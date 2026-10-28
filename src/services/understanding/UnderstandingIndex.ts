import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Compact metadata index over the repository-understanding cache.
 *
 * The cache itself stays markdown (human-readable, and the format every
 * consumer already reads); markdown is the EXPORT/interchange format. What it
 * cannot do is answer "what is cached, how big is it, what was used last" —
 * one file per entity means a directory scan plus a full parse to rank or
 * evict anything. So the directory gets a single small JSON sidecar that
 * carries the metadata, and markdown stays the payload.
 *
 * Design constraints (ADO-27358):
 *  - the index is derived state: it is always rebuildable from the directory,
 *    and a corrupt or missing index must never break a chat turn;
 *  - it stays tiny — only counters, short labels and a content hash per
 *    entry, so at the default 300-entry cap it remains ~1% of the cache;
 *  - every entry records `lastAccessed`, which is the LRU eviction key.
 */

export const INDEX_FILE = 'index.json';
export const INDEX_VERSION = 1;
/** LRU cap: beyond this many entries the least-recently-accessed ones go. */
export const DEFAULT_MAX_ENTRIES = 300;
/** Titles are a display aid, not a store — keep the index cheap. */
const MAX_TITLE_CHARS = 80;
/** Markdown files that are exports, not cache entries. */
const EXPORT_DIR = 'export';

export type UnderstandingKind = 'repo' | 'workitem' | 'knowledge';

export interface UnderstandingIndexEntry {
  /** Stable key: 'repo' | 'knowledge' | 'workitem-<id>'. */
  id: string;
  kind: UnderstandingKind;
  /** Short human label (work-item title, repo branch, …). */
  title: string;
  /** File name relative to the understanding directory. */
  file: string;
  bytes: number;
  chars: number;
  /** Content hash — doubles as the "did this actually change?" fingerprint. */
  hash: string;
  updatedAt: string;
  /** LRU key: bumped on read and on write. */
  lastAccessed: string;
}

export interface UnderstandingIndexData {
  version: number;
  entries: Record<string, UnderstandingIndexEntry>;
}

/** Cheap, stable content hash used for change detection. */
export function contentHash(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 16);
}

function clipTitle(title: string): string {
  const flat = (title || '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat;
}

/** Derive kind + id from a cache file name. */
export function classifyCacheFile(file: string): { id: string; kind: UnderstandingKind } | null {
  const base = file.replace(/\\/g, '/');
  if (base.includes('/')) return null;
  if (!base.endsWith('.md')) return null;
  if (base === 'repo.md') return { id: 'repo', kind: 'repo' };
  if (base === 'knowledge.md') return { id: 'knowledge', kind: 'knowledge' };
  const m = /^workitem-(\d+)\.md$/.exec(base);
  if (m) return { id: `workitem-${m[1]}`, kind: 'workitem' };
  return null;
}

/** Pull a display label out of the cached markdown (first heading, else first line). */
function titleFromMarkdown(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line.trim());
    if (heading) return heading[1];
    if (line.trim().startsWith('>')) {
      // digest block — first `- **Key:** value` bullet is a decent fallback
      const bullet = /^\s*[-*]\s*\*\*(.+?):\*\*\s*(.+)$/.exec(line);
      if (bullet) return bullet[2];
    }
    if (line.trim()) return line.trim();
  }
  return '(untitled)';
}

/** Kind codes keep the index compact — one character per entry. */
const KIND_CODES: Record<UnderstandingKind, string> = { repo: 'r', workitem: 'w', knowledge: 'k' };
const KIND_NAMES: Record<string, UnderstandingKind> = { r: 'repo', w: 'workitem', k: 'knowledge' };

/**
 * Serialise the index as compact tuples rather than pretty field objects.
 * The index is derived state read on every cache access, so its size matters
 * more than its beauty: at the 300-entry cap it must stay around 1% of the
 * cache it describes (ADO-27358). `file` is derived from the id and the
 * timestamps are epoch seconds.
 */
function encodeIndex(data: UnderstandingIndexData): {
  v: number;
  e: Record<string, Array<string | number>>;
} {
  const e: Record<string, Array<string | number>> = {};
  for (const [id, entry] of Object.entries(data.entries)) {
    // [kind, title, chars, lastAccessed] — everything else is derivable:
    // size and mtime come from the file, the hash is only needed in memory.
    e[id] = [
      KIND_CODES[entry.kind] ?? 'w',
      entry.title,
      entry.chars,
      Math.floor(Date.parse(entry.lastAccessed) / 1000) || 0,
    ];
  }
  return { v: INDEX_VERSION, e };
}

function decodeEntry(id: string, tuple: unknown): UnderstandingIndexEntry | null {
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const kind = KIND_NAMES[String(tuple[0])];
  if (!kind) return null;
  const n = Number(tuple[3]);
  const lastAccessed = Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date(0).toISOString();
  return {
    id,
    kind,
    title: clipTitle(String(tuple[1] ?? '')),
    file: fileForId(id),
    bytes: 0, // filled from the file on demand — keeps the index small
    chars: Number(tuple[2]) || 0,
    hash: '', // recomputed only when rebuilding; never persisted
    updatedAt: lastAccessed, // overwritten from the file mtime on load
    lastAccessed,
  };
}

/** Cache file name for an entry id (repo/knowledge are fixed names). */
export function fileForId(id: string): string {
  return id === 'repo' ? 'repo.md' : id === 'knowledge' ? 'knowledge.md' : `${id}.md`;
}

/**
 * The index over `<understanding>/index.json`. All methods are synchronous and
 * must never throw: a cache-index problem degrades to "no index", never to a
 * failed chat turn.
 */
export class UnderstandingIndex {
  constructor(private readonly dir: string) {}

  get indexPath(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  /** Current time, overridable so tests can drive LRU order deterministically. */
  now: () => Date = () => new Date();

  private readRaw(): UnderstandingIndexData | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as {
        v?: number;
        e?: Record<string, unknown[]>;
      };
      if (!parsed || typeof parsed !== 'object' || !parsed.e || typeof parsed.e !== 'object') return null;
      const entries: Record<string, UnderstandingIndexEntry> = {};
      for (const [id, tuple] of Object.entries(parsed.e)) {
        const entry = decodeEntry(id, tuple);
        if (entry) entries[id] = entry;
      }
      return { version: Number(parsed.v) || INDEX_VERSION, entries };
    } catch {
      return null;
    }
  }

  /** Read the index, self-healing from disk when it is missing or corrupt. */
  load(): UnderstandingIndexData {
    const raw = this.readRaw();
    if (!raw) return this.rebuild();
    // Drop entries whose file disappeared (users delete caches by hand).
    let pruned = false;
    for (const [id, entry] of Object.entries(raw.entries)) {
      if (!entry || typeof entry.file !== 'string' || !this.fileExists(entry.file)) {
        delete raw.entries[id];
        pruned = true;
      }
    }
    if (pruned) this.save(raw);
    return raw;
  }

  private fileExists(file: string): boolean {
    try {
      return fs.statSync(path.join(this.dir, file)).isFile();
    } catch {
      return false;
    }
  }

  private writeRaw(data: UnderstandingIndexData): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.indexPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(encodeIndex(data)), 'utf8');
      fs.renameSync(tmp, this.indexPath);
    } catch {
      /* index is derived state; never fail the caller over it */
    }
  }

  save(data: UnderstandingIndexData): void {
    this.writeRaw({ version: INDEX_VERSION, entries: data.entries });
  }

  /** Rebuild the whole index by scanning the cache directory. */
  rebuild(): UnderstandingIndexData {
    const previous = this.readRaw();
    const entries: Record<string, UnderstandingIndexEntry> = {};
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      files = [];
    }
    const stamp = this.now().toISOString();
    for (const file of files) {
      const kind = classifyCacheFile(file);
      if (!kind) continue;
      const full = path.join(this.dir, file);
      let content: string;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      entries[kind.id] = {
        id: kind.id,
        kind: kind.kind,
        title: clipTitle(titleFromMarkdown(content)),
        file,
        bytes: stat.size,
        chars: content.length,
        hash: contentHash(content),
        updatedAt: stamp,
        // Preserve the LRU position when we already know it.
        lastAccessed: previous?.entries?.[kind.id]?.lastAccessed ?? stamp,
      };
    }
    const data: UnderstandingIndexData = { version: INDEX_VERSION, entries };
    this.writeRaw(data);
    return data;
  }

  /** Record (or refresh) an entry from the content that was just written. */
  upsert(params: { id: string; kind: UnderstandingKind; title: string; content: string }): void {
    const data = this.load();
    const stamp = this.now().toISOString();
    const file = fileForId(params.id);
    try {
      // Persist the payload alongside the metadata: the index is the single
      // writer of a cache entry, so a load() can never prune what was just
      // recorded. Callers that wrote the file themselves write it twice with
      // identical bytes, which is harmless.
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, file), params.content, 'utf8');
    } catch {
      /* the caller's own write may already have landed */
    }
    data.entries[params.id] = {
      id: params.id,
      kind: params.kind,
      title: clipTitle(params.title || titleFromMarkdown(params.content)),
      file,
      bytes: Buffer.byteLength(params.content, 'utf8'),
      chars: params.content.length,
      hash: contentHash(params.content),
      updatedAt: stamp,
      lastAccessed: stamp,
    };
    this.save(data);
  }

  /**
   * Mark an entry as used. Returns true when the entry was known — an unknown
   * id is indexed from disk instead of being invented.
   */
  touch(id: string): boolean {
    const data = this.load();
    const entry = data.entries[id];
    if (!entry) return false;
    entry.lastAccessed = this.now().toISOString();
    this.save(data);
    return true;
  }

  remove(id: string): boolean {
    const data = this.load();
    if (!data.entries[id]) return false;
    const file = data.entries[id].file;
    delete data.entries[id];
    this.save(data);
    try {
      fs.rmSync(path.join(this.dir, file), { force: true });
    } catch {
      /* best effort */
    }
    return true;
  }

  /** Fill in on-disk size for an entry (kept out of the index itself). */
  private withSize(entry: UnderstandingIndexEntry): UnderstandingIndexEntry {
    if (entry.bytes > 0) return entry;
    try {
      const stat = fs.statSync(path.join(this.dir, entry.file));
      return { ...entry, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
    } catch {
      return entry;
    }
  }

  /** Entries, most recently accessed first. */
  list(): UnderstandingIndexEntry[] {
    const data = this.load();
    return Object.values(data.entries).map((e) => this.withSize(e)).sort(
      (a, b) => Date.parse(b.lastAccessed) - Date.parse(a.lastAccessed) || a.id.localeCompare(b.id),
    );
  }

  /** Total cached characters across entries (the budget GC measures). */
  totalChars(): number {
    const data = this.load();
    return Object.values(data.entries).reduce((sum, e) => sum + (Number(e.chars) || 0), 0);
  }

  /** Total cached bytes on disk across entries. */
  totalBytes(): number {
    const data = this.load();
    return Object.values(data.entries).reduce((sum, e) => sum + this.withSize(e).bytes, 0);
  }

  /** Size of index.json itself, in bytes. */
  indexBytes(): number {
    try {
      return fs.statSync(this.indexPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Evict least-recently-accessed entries until at most `maxEntries` remain.
   * `protect` ids are never evicted (e.g. repo.md / knowledge.md, which the
   * prompt always injects). Returns the evicted ids, oldest first.
   */
  evictLRU(maxEntries: number, protect: string[] = []): string[] {
    const data = this.load();
    const keep = new Set(protect);
    const all = Object.values(data.entries).sort(
      (a, b) => Date.parse(a.lastAccessed) - Date.parse(b.lastAccessed) || a.id.localeCompare(b.id),
    );
    let count = all.length;
    const evicted: string[] = [];
    for (const entry of all) {
      if (count <= maxEntries) break;
      if (keep.has(entry.id)) continue;
      delete data.entries[entry.id];
      evicted.push(entry.id);
      count--;
    }
    if (evicted.length === 0) return evicted;
    this.save(data);
    for (const id of evicted) {
      const file = all.find((e) => e.id === id)?.file;
      if (!file) continue;
      try {
        fs.rmSync(path.join(this.dir, file), { force: true });
      } catch {
        /* best effort */
      }
    }
    return evicted;
  }

  /**
   * Export the cache as markdown into `targetDir`, leaving the cache files
   * untouched. Content is the cached markdown verbatim, so an export always
   * matches what the caches hold; a manifest describes the set.
   */
  exportTo(targetDir: string): { files: string[]; manifestPath: string } {
    fs.mkdirSync(targetDir, { recursive: true });
    const files: string[] = [];
    const rows: string[] = [];
    for (const entry of this.list()) {
      const source = path.join(this.dir, entry.file);
      const dest = path.join(targetDir, entry.file);
      try {
        fs.copyFileSync(source, dest);
        files.push(dest);
      } catch {
        continue;
      }
      rows.push(
        `| ${entry.kind} | ${entry.id} | ${entry.title.replace(/\|/g, '/')} | ${entry.chars} | ${entry.updatedAt} |`,
      );
    }
    const manifestPath = path.join(targetDir, 'MANIFEST.md');
    const manifest = [
      '# Understanding export',
      '',
      `Exported ${files.length} entr${files.length === 1 ? 'y' : 'ies'} on ${this.now().toISOString()}.`,
      'Source: `.ado-code/understanding/` (copied verbatim — the cache was not modified).',
      '',
      '| Kind | Id | Title | Chars | Updated |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n');
    fs.writeFileSync(manifestPath, manifest, 'utf8');
    return { files, manifestPath };
  }

  /** Default export location next to the cache. */
  defaultExportDir(): string {
    return path.join(this.dir, EXPORT_DIR);
  }
}

// ArtifactStore — inventory and garbage collection for generated artifacts
// (ADO-27356).
//
// Everything ADO Code writes for its own use lives under `.ado-code/`, and
// nothing ever deleted it: one work-item cache per work item ever opened, run
// output files at ~50 KB each, leftover task drafts. This module is the single
// place that knows what those artifacts are and when they may go.
//
// Design rules (each one exists because the alternative silently loses data):
//  - Classification is CLOSED and name-based. A file becomes a prune candidate
//    only when its path matches a known generated-artifact pattern, so a
//    hand-placed file, a user-authored memory entry or a future artifact kind
//    is never swept up by a prune it was not designed for.
//  - Kinds that hold user data (`memory`, `sessions`, `checkpoints`,
//    `worktrees`) are not prunable AT ALL — they have their own lifecycle.
//  - The newest artifact of every prunable kind is always kept, even when it is
//    older than the age limit, so a prune can never leave a kind empty.
//  - `planPrune` and `pruneArtifacts` share one code path, so a dry run reports
//    exactly the bytes the real run reclaims (and a second real run reclaims 0).
//  - Symlinks are never followed and nothing outside the state dir is touched.
//
// Deliberately free of `vscode` imports: the store is pure fs/path so it can be
// exercised headlessly (see src/test/suite/services/artifacts.test.ts).

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export type ArtifactKind =
  /** `.ado-code/understanding/workitem-<id>.md` — one per work item ever opened. */
  | 'workitem-cache'
  /** `.ado-code/understanding/repo.md` — the current repository map. */
  | 'understanding-map'
  /** `.ado-code/understanding/index.json` — the cache index. */
  | 'understanding-index'
  /** `.ado-code/task-draft.md` and legacy `task-draft-*.md`. */
  | 'draft'
  /** `.ado-code/runs/*.out.txt` / `*.log` — delegated agent output. */
  | 'run-log'
  /** `.ado-code/memory/**` — user-authored workspace memory. */
  | 'memory'
  /** `.ado-code/sessions/**` — crash-safe session mirrors. */
  | 'session'
  /** `.ado-code/checkpoints/**` — restorable checkpoints. */
  | 'checkpoint'
  /** `.ado-code/worktrees/**` — git worktrees (git owns their lifecycle). */
  | 'worktree'
  /** `.ado-code/config.json`, `.ado-code/.prune-stamp.json` — small state. */
  | 'state'
  /** Anything else, including files the user put there by hand. */
  | 'other';

/** Kinds a prune may delete. Everything absent from this list is untouchable. */
export const PRUNABLE_KINDS: readonly ArtifactKind[] = ['workitem-cache', 'draft', 'run-log'];

export const STATE_DIR = '.ado-code';

/** `.ado-code/.prune-stamp.json` — last successful prune, for throttling. */
export const PRUNE_STAMP_REL = `${STATE_DIR}/.prune-stamp.json`;

/** How often the automatic prune may run. */
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Classify a workspace-relative path. `AGENTS.md`, `docs/*.md` and other
 * workspace files are intentionally NOT artifacts — the store only ever owns
 * `.ado-code`.
 */
export function classifyArtifact(relPath: string): ArtifactKind {
  const rel = toPosix(relPath).replace(/^\.\//, '');
  if (!rel.startsWith(`${STATE_DIR}/`)) {
    return 'other';
  }
  const rest = rel.slice(STATE_DIR.length + 1);
  const dir = rest.includes('/') ? rest.split('/')[0] : '';

  switch (dir) {
    case 'understanding':
      if (/^understanding\/workitem-.*\.md$/.test(rest)) {
        return 'workitem-cache';
      }
      if (rest === 'understanding/repo.md') {
        return 'understanding-map';
      }
      if (rest === 'understanding/index.json') {
        return 'understanding-index';
      }
      return 'other';
    case 'runs':
      return /\.(out\.txt|log)$/i.test(rest) ? 'run-log' : 'other';
    case 'memory':
      return 'memory';
    case 'sessions':
      return 'session';
    case 'checkpoints':
      return 'checkpoint';
    case 'worktrees':
      return 'worktree';
    default:
      break;
  }

  // Files that sit directly in the state dir.
  if (/^task-draft(-[\w.-]+)?\.md$/.test(rest)) {
    return 'draft';
  }
  if (rest === 'config.json' || rest === '.prune-stamp.json') {
    return 'state';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface ArtifactEntry {
  kind: ArtifactKind;
  /** Workspace-relative, always posix separators. */
  relPath: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
}

export interface ArtifactKindSummary {
  kind: ArtifactKind;
  count: number;
  bytes: number;
}

export interface ArtifactInventory {
  root: string;
  stateDir: string;
  /** True when the scan hit its entry cap; counts below are then partial. */
  truncated: boolean;
  entries: ArtifactEntry[];
  byKind: ArtifactKindSummary[];
  totalCount: number;
  totalBytes: number;
  /** mtime of the oldest scanned file, or null when nothing was found. */
  oldestMtimeMs: number | null;
}

export interface ScanOptions {
  /** Hard cap on scanned files (guards against a pathological tree). */
  maxEntries?: number;
}

const DEFAULT_SCAN_MAX_ENTRIES = 20000;

/** Estimated prompt cost of a byte count — the epic's chars/4 heuristic. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/**
 * Walk the state dir and classify everything in it. Never follows symlinks,
 * never throws on an unreadable directory (a half-deleted artifact tree must
 * not break activation), and reports what it saw even when the entry cap bites.
 */
export function scanArtifacts(root: string, options: ScanOptions = {}): ArtifactInventory {
  const stateDir = path.join(root, STATE_DIR);
  const maxEntries = options.maxEntries ?? DEFAULT_SCAN_MAX_ENTRIES;
  const entries: ArtifactEntry[] = [];
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) {
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const absPath = path.join(dir, dirent.name);
      // A symlink is neither walked nor counted: following one could pull a
      // path from outside the state dir into the inventory.
      if (dirent.isSymbolicLink()) {
        continue;
      }
      if (dirent.isDirectory()) {
        if (dirent.name === 'node_modules' || dirent.name === '.git') {
          continue;
        }
        walk(absPath);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      const relPath = toPosix(path.relative(root, absPath));
      entries.push({
        kind: classifyArtifact(relPath),
        relPath,
        absPath,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  };

  walk(stateDir);

  const totals = new Map<ArtifactKind, { count: number; bytes: number }>();
  let totalBytes = 0;
  let oldestMtimeMs: number | null = null;
  for (const entry of entries) {
    const bucket = totals.get(entry.kind) ?? { count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += entry.bytes;
    totals.set(entry.kind, bucket);
    totalBytes += entry.bytes;
    if (oldestMtimeMs === null || entry.mtimeMs < oldestMtimeMs) {
      oldestMtimeMs = entry.mtimeMs;
    }
  }

  const byKind: ArtifactKindSummary[] = [...totals.entries()]
    .map(([kind, t]) => ({ kind, count: t.count, bytes: t.bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind));

  return {
    root,
    stateDir,
    truncated,
    entries,
    byKind,
    totalCount: entries.length,
    totalBytes,
    oldestMtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface KindPolicy {
  /** Maximum files of this kind to keep (newest first). */
  maxFiles: number;
  /** Maximum age in days; older files go even when under `maxFiles`. */
  maxAgeDays: number;
}

export interface PrunePolicy {
  /** Per-kind rules. A prunable kind with no rule is kept as-is. */
  kinds: Partial<Record<ArtifactKind, KindPolicy>>;
  /** Whole-state-dir byte budget; when exceeded the oldest artifacts go first. */
  maxTotalBytes: number;
}

/**
 * Suggested defaults from the epic: work-item caches 50 files / 30 days, run
 * logs 20 / 14 days, drafts 5 / 7 days.
 */
export const DEFAULT_PRUNE_POLICY: PrunePolicy = {
  kinds: {
    'workitem-cache': { maxFiles: 50, maxAgeDays: 30 },
    'run-log': { maxFiles: 20, maxAgeDays: 14 },
    draft: { maxFiles: 5, maxAgeDays: 7 },
  },
  maxTotalBytes: 4 * 1024 * 1024,
};

/**
 * Build the effective policy from the user's settings. One global cap scales
 * every kind, so the settings surface stays three keys instead of a matrix.
 */
export function resolvePrunePolicy(
  settings: { retentionDays?: number; maxFilesPerKind?: number; maxTotalBytes?: number } = {}
): PrunePolicy {
  const retentionDays = settings.retentionDays;
  const maxFiles = settings.maxFilesPerKind;
  const kinds: Partial<Record<ArtifactKind, KindPolicy>> = {};
  for (const kind of PRUNABLE_KINDS) {
    const base = DEFAULT_PRUNE_POLICY.kinds[kind];
    if (!base) {
      continue;
    }
    kinds[kind] = {
      maxFiles: Math.max(1, Math.floor(maxFiles ?? base.maxFiles)),
      maxAgeDays: Math.max(1, retentionDays ?? base.maxAgeDays),
    };
  }
  return {
    kinds,
    maxTotalBytes: Math.max(0, settings.maxTotalBytes ?? DEFAULT_PRUNE_POLICY.maxTotalBytes),
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type PruneReason = 'max-files' | 'max-age' | 'total-bytes';

export interface PruneCandidate {
  entry: ArtifactEntry;
  reason: PruneReason;
  /** Human sentence explaining why this file is on the list. */
  detail: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function newestFirst(a: ArtifactEntry, b: ArtifactEntry): number {
  return b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath);
}

/**
 * Decide what to delete without touching the disk. Returning the candidates
 * rather than deleting lets the command show the exact report a real run would
 * produce (AC: the dry run reports the exact bytes reclaimed).
 */
export function planPrune(
  inventory: ArtifactInventory,
  policy: PrunePolicy = DEFAULT_PRUNE_POLICY,
  now: number = Date.now()
): PruneCandidate[] {
  const candidates: PruneCandidate[] = [];
  const pruned = new Set<string>();

  for (const kind of PRUNABLE_KINDS) {
    const rule = policy.kinds[kind];
    if (!rule) {
      continue;
    }
    const entries = inventory.entries.filter(e => e.kind === kind).sort(newestFirst);
    entries.forEach((entry, index) => {
      // The newest file of a kind is never deleted, whatever the rules say.
      if (index === 0) {
        return;
      }
      const ageDays = (now - entry.mtimeMs) / DAY_MS;
      if (index >= rule.maxFiles) {
        candidates.push({
          entry,
          reason: 'max-files',
          detail: `older than the newest ${rule.maxFiles} ${kind} artifact(s)`,
        });
      } else if (ageDays > rule.maxAgeDays) {
        candidates.push({
          entry,
          reason: 'max-age',
          detail: `${Math.floor(ageDays)} days old (limit ${rule.maxAgeDays})`,
        });
      } else {
        return;
      }
      pruned.add(entry.relPath);
    });
  }

  // Whole-directory byte budget: oldest prunable artifacts go next, still
  // protecting the newest file of each kind.
  const protectedRel = new Set<string>();
  for (const kind of PRUNABLE_KINDS) {
    const newest = inventory.entries.filter(e => e.kind === kind).sort(newestFirst)[0];
    if (newest) {
      protectedRel.add(newest.relPath);
    }
  }
  let remainingBytes = inventory.entries
    .filter(e => !pruned.has(e.relPath))
    .reduce((sum, e) => sum + e.bytes, 0);
  if (remainingBytes > policy.maxTotalBytes) {
    const pool = inventory.entries
      .filter(
        e =>
          PRUNABLE_KINDS.includes(e.kind) && !pruned.has(e.relPath) && !protectedRel.has(e.relPath)
      )
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.relPath.localeCompare(b.relPath));
    for (const entry of pool) {
      if (remainingBytes <= policy.maxTotalBytes) {
        break;
      }
      candidates.push({
        entry,
        reason: 'total-bytes',
        detail: `.ado-code holds more than the ${policy.maxTotalBytes}-byte budget`,
      });
      pruned.add(entry.relPath);
      remainingBytes -= entry.bytes;
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

export interface PruneReport {
  dryRun: boolean;
  policy: PrunePolicy;
  candidates: PruneCandidate[];
  /** Files actually removed (equals candidates.length for a real run). */
  deleted: number;
  /** Bytes actually reclaimed (the sum reported by a dry run). */
  bytesFreed: number;
  keptByKind: Partial<Record<ArtifactKind, number>>;
  errors: Array<{ relPath: string; message: string }>;
}

export interface PruneOptions {
  now?: number;
  dryRun?: boolean;
  policy?: PrunePolicy;
}

/**
 * Apply the policy. Deletes only planned candidates, only regular files inside
 * the state dir, and reports per-file errors instead of aborting — one locked
 * file must not block the rest of the cleanup.
 */
export function pruneArtifacts(root: string, options: PruneOptions = {}): PruneReport {
  const policy = options.policy ?? DEFAULT_PRUNE_POLICY;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? Date.now();
  const inventory = scanArtifacts(root);
  const candidates = planPrune(inventory, policy, now);

  const report: PruneReport = {
    dryRun,
    policy,
    candidates,
    deleted: 0,
    bytesFreed: 0,
    keptByKind: {},
    errors: [],
  };

  const prunedRel = new Set<string>();
  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        const stat = fs.lstatSync(candidate.entry.absPath);
        if (!stat.isFile()) {
          // Became a directory or a link between scan and delete: leave it.
          continue;
        }
        fs.unlinkSync(candidate.entry.absPath);
        report.deleted += 1;
        report.bytesFreed += stat.size;
        prunedRel.add(candidate.entry.relPath);
      } catch (err) {
        report.errors.push({
          relPath: candidate.entry.relPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    report.bytesFreed = candidates.reduce((sum, c) => sum + c.entry.bytes, 0);
    report.deleted = candidates.length;
  }

  for (const entry of inventory.entries) {
    const gone = dryRun ? candidates.some(c => c.entry.relPath === entry.relPath) : prunedRel.has(entry.relPath);
    if (gone) {
      continue;
    }
    report.keptByKind[entry.kind] = (report.keptByKind[entry.kind] ?? 0) + 1;
  }

  return report;
}

/** One-line-per-event summary for the output channel and the command. */
export function formatPruneReport(report: PruneReport): string {
  const head = report.dryRun
    ? `Artifact prune (dry run): ${report.deleted} file(s), ${formatBytes(report.bytesFreed)} would be reclaimed.`
    : `Artifact prune: removed ${report.deleted} file(s), reclaimed ${formatBytes(report.bytesFreed)}.`;
  const lines = [head];
  const reasons = new Map<string, { count: number; bytes: number }>();
  for (const candidate of report.candidates) {
    const key = `${candidate.entry.kind} (${candidate.reason})`;
    const bucket = reasons.get(key) ?? { count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += candidate.entry.bytes;
    reasons.set(key, bucket);
  }
  for (const [key, bucket] of [...reasons.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    lines.push(`  ${key}: ${bucket.count} file(s), ${formatBytes(bucket.bytes)}`);
  }
  const kept = Object.entries(report.keptByKind)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ');
  if (kept) {
    lines.push(`  kept: ${kept}`);
  }
  if (report.errors.length > 0) {
    lines.push(`  ${report.errors.length} file(s) could not be removed (in use?)`);
    for (const error of report.errors.slice(0, 5)) {
      lines.push(`    ${error.relPath}: ${error.message}`);
    }
  }
  return lines.join('\n');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Scheduling (throttled automatic prune)
// ---------------------------------------------------------------------------

export function pruneStampPath(root: string): string {
  return path.join(root, STATE_DIR, '.prune-stamp.json');
}

export interface PruneStamp {
  lastPruneAt: string;
  filesRemoved: number;
  bytesFreed: number;
}

/** Read the last-prune stamp; null when absent or unreadable (⇒ due). */
export function readPruneStamp(root: string): PruneStamp | null {
  try {
    const raw = fs.readFileSync(pruneStampPath(root), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PruneStamp>;
    if (typeof parsed.lastPruneAt !== 'string') {
      return null;
    }
    if (Number.isNaN(Date.parse(parsed.lastPruneAt))) {
      return null;
    }
    return {
      lastPruneAt: parsed.lastPruneAt,
      filesRemoved: Number(parsed.filesRemoved) || 0,
      bytesFreed: Number(parsed.bytesFreed) || 0,
    };
  } catch {
    return null;
  }
}

export function writePruneStamp(root: string, stamp: PruneStamp): void {
  try {
    fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
    fs.writeFileSync(pruneStampPath(root), JSON.stringify(stamp, null, 2), 'utf8');
  } catch {
    /* throttling is best-effort — a failed stamp only costs another prune */
  }
}

/** True when the automatic prune has not run within `intervalMs`. */
export function isPruneDue(root: string, now: number = Date.now(), intervalMs = PRUNE_INTERVAL_MS): boolean {
  const stamp = readPruneStamp(root);
  if (!stamp) {
    return true;
  }
  return now - Date.parse(stamp.lastPruneAt) >= intervalMs;
}

export interface ScheduledPruneOptions {
  /** `adoCode.artifacts.enabled`: false stops ALL automatic deletion. */
  enabled: boolean;
  policy?: PrunePolicy;
  now?: number;
  intervalMs?: number;
}

/**
 * The activation-time entry point: prune when enabled and due, stamp the run.
 * Returns null when nothing ran (disabled or not due) so callers stay quiet.
 */
export function runScheduledPrune(root: string, options: ScheduledPruneOptions): PruneReport | null {
  if (!options.enabled) {
    return null;
  }
  const now = options.now ?? Date.now();
  if (!isPruneDue(root, now, options.intervalMs ?? PRUNE_INTERVAL_MS)) {
    return null;
  }
  const report = pruneArtifacts(root, { now, policy: options.policy });
  writePruneStamp(root, {
    lastPruneAt: new Date(now).toISOString(),
    filesRemoved: report.deleted,
    bytesFreed: report.bytesFreed,
  });
  return report;
}

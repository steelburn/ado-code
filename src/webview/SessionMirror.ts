import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../shared/messages';

/**
 * Crash-safe on-disk mirror of the chat sessions.
 *
 * WHY: sessions live in `workspaceState`, a debounced, sqlite-backed Memento —
 * an `update()` promise resolving does NOT mean the bytes reached the disk, and
 * anything the provider keeps in memory only (the in-flight turn's messages)
 * never reaches it at all. Shutting a laptop lid (or a hard kill) during a turn
 * therefore lost the message the user had just sent.
 *
 * HOW: every write of the session list also lands a per-session JSON copy here,
 * written SYNCHRONOUSLY (write → fsync → rename) so the data is durable the
 * moment the call returns. The mirror is a FALLBACK, never the primary store:
 * activation loads the Memento list first and lets the mirror win only where it
 * holds strictly more for the same session (see {@link SessionMirror.merge}).
 */

/** Bumped when the on-disk shape changes — a mismatch is treated as "no mirror". */
export const MIRROR_VERSION = 1;

export interface MirroredSessions {
  sessions: Session[];
  activeSessionId?: string;
}

/** Session metadata (everything except the message transcript). */
type SessionMeta = Omit<Session, 'messages'>;

interface SessionFile {
  version: number;
  savedAt: string;
  folderKey?: string;
  session: Session;
}

interface IndexFile {
  version: number;
  savedAt: string;
  folderKey?: string;
  activeSessionId?: string;
  sessions: SessionMeta[];
}

const INDEX_FILE = 'index.json';

/** Filenames are derived from ids — keep them portable and separator-free. */
function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Write a file so that a crash mid-write cannot leave a half-written payload in
 * place: write to a sibling temp file, fsync it, then rename over the target
 * (rename is atomic on the same volume, and Node replaces an existing target on
 * Windows too). Falls back to a direct write if the rename is refused.
 */
function writeFileDurable(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data, 'utf8');
    // fsync: without it the payload can still be sitting in the OS cache when
    // the machine loses power — exactly the case this mirror exists for.
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, data, 'utf8');
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file already gone */
    }
  }
}

export class SessionMirror {
  /** Last payload written per session id — an unchanged session is not rewritten. */
  private readonly written = new Map<string, string>();
  private lastIndexSignature?: string;

  /**
   * @param getDir      absolute mirror directory, or undefined to disable
   *                    mirroring entirely (no workspace folder open → the
   *                    sessions are not folder-scoped either)
   * @param getFolderKey workspace-folder key recorded in the index, for debugging
   */
  constructor(
    private readonly getDir: () => string | undefined,
    private readonly getFolderKey: () => string = () => '',
  ) {}

  /**
   * Mirror the full session list plus the active-session pointer.
   * Best-effort and synchronous: a mirror failure must never break a save.
   */
  write(sessions: Session[], activeSessionId?: string | null): void {
    const dir = this.getDir();
    if (!dir) return;
    let folderKey: string | undefined;
    try {
      folderKey = this.getFolderKey() || undefined;
    } catch {
      folderKey = undefined;
    }
    const savedAt = new Date().toISOString();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }

    const metas: SessionMeta[] = [];
    const liveFiles = new Set<string>();
    for (const session of sessions) {
      if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages)) continue;
      const { messages: _messages, ...meta } = session;
      metas.push(meta);
      const file = `${safeFileName(session.id)}.json`;
      liveFiles.add(file);
      // Dedupe on the transcript alone (savedAt alone would defeat it): a
      // streaming checkpoint rewrites one session, not all of them.
      let signature: string;
      try {
        signature = JSON.stringify(session);
      } catch {
        continue; // non-serialisable session (shouldn't happen) — skip, don't thrash
      }
      if (this.written.get(session.id) === signature) continue;
      const payload: SessionFile = { version: MIRROR_VERSION, savedAt, folderKey, session };
      try {
        writeFileDurable(path.join(dir, file), JSON.stringify(payload));
        this.written.set(session.id, signature);
      } catch {
        /* disk full / permissions — the Memento copy is still written below */
      }
    }

    // Index: which sessions exist and which one was on screen. Deleted sessions
    // disappear from here first, so a stale session file can never resurrect one.
    const indexSignature = JSON.stringify({ activeSessionId: activeSessionId ?? undefined, metas });
    if (indexSignature !== this.lastIndexSignature) {
      const index: IndexFile = {
        version: MIRROR_VERSION,
        savedAt,
        folderKey,
        ...(activeSessionId ? { activeSessionId } : {}),
        sessions: metas,
      };
      try {
        writeFileDurable(path.join(dir, INDEX_FILE), JSON.stringify(index));
        this.lastIndexSignature = indexSignature;
      } catch {
        /* best effort */
      }
    }

    // Drop files for sessions that no longer exist (chat cleared / session
    // deleted / pruned beyond the per-project limit).
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === INDEX_FILE || !entry.endsWith('.json') || liveFiles.has(entry)) continue;
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {
          /* in use — skipped, and ignored on read anyway */
        }
      }
    } catch {
      /* directory unreadable — nothing to prune */
    }
  }

  /**
   * Read the mirrored sessions. Returns undefined when the mirror is absent,
   * corrupt, or written by an incompatible version — the caller then simply
   * keeps the Memento copy.
   */
  read(): MirroredSessions | undefined {
    const dir = this.getDir();
    if (!dir) return undefined;
    let index: IndexFile;
    try {
      index = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8')) as IndexFile;
    } catch {
      return undefined;
    }
    if (!index || index.version !== MIRROR_VERSION || !Array.isArray(index.sessions)) return undefined;

    const sessions: Session[] = [];
    for (const meta of index.sessions) {
      if (!meta || typeof meta.id !== 'string') continue;
      try {
        const file = JSON.parse(
          fs.readFileSync(path.join(dir, `${safeFileName(meta.id)}.json`), 'utf8'),
        ) as SessionFile;
        if (!file || file.version !== MIRROR_VERSION) continue;
        const session = file.session;
        if (!session || session.id !== meta.id || !Array.isArray(session.messages)) continue;
        sessions.push(session);
      } catch {
        // Session file missing or unreadable — fall back to the Memento copy.
      }
    }
    if (sessions.length === 0) return undefined;
    return {
      sessions,
      activeSessionId: typeof index.activeSessionId === 'string' ? index.activeSessionId : undefined,
    };
  }

  /** Forget the dedupe cache (e.g. after the mirror directory changed). */
  reset(): void {
    this.written.clear();
    this.lastIndexSignature = undefined;
  }

  /**
   * Union of the Memento list and the mirror.
   *
   * The mirror is the survivor of a crash, so the rule is deliberately narrow:
   * a session present on both sides is taken from the mirror ONLY when the
   * mirror holds more messages (a turn that was mid-flight). Equal or fewer
   * messages means the Memento copy is the newer one — it carries renames, trace
   * rewrites and approvals the mirror may predate.
   */
  static merge(
    stored: Session[],
    mirrored: Session[],
    storedActiveId?: string | null,
    mirroredActiveId?: string | null,
  ): { sessions: Session[]; replaced: string[]; added: string[]; activeSessionId?: string } {
    const byId = new Map<string, Session>();
    const out: Session[] = [];
    for (const session of stored) {
      if (!session || typeof session.id !== 'string') continue;
      byId.set(session.id, session);
      out.push(session);
    }

    const replaced: string[] = [];
    const added: string[] = [];
    for (const candidate of mirrored) {
      if (!candidate || typeof candidate.id !== 'string' || !Array.isArray(candidate.messages)) continue;
      const existing = byId.get(candidate.id);
      if (!existing) {
        byId.set(candidate.id, candidate);
        out.push(candidate);
        added.push(candidate.id);
        continue;
      }
      if (candidate.messages.length > existing.messages.length) {
        const at = out.indexOf(existing);
        if (at >= 0) out[at] = candidate;
        byId.set(candidate.id, candidate);
        replaced.push(candidate.id);
      }
    }

    if (added.length > 0) {
      // Keep the history dropdown in creation order regardless of which copy won.
      out.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }

    // The active pointer: the mirror is written alongside every session save, so
    // it is at least as fresh — but only trust it when that session still exists.
    const activeSessionId =
      mirroredActiveId && byId.has(mirroredActiveId)
        ? mirroredActiveId
        : storedActiveId && byId.has(storedActiveId)
          ? storedActiveId
          : undefined;

    return { sessions: out, replaced, added, ...(activeSessionId ? { activeSessionId } : {}) };
  }
}

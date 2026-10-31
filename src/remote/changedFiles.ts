import {
  MAX_CHANGED_FILES,
  type RemoteChangedFile,
  type RemoteFilesEvent,
  type RemoteToolStatus,
} from '../shared/remoteProtocol';

/**
 * Host-side list of the files an agent changed, for the remote console.
 *
 * The console can see a tool call go by (`toolFeed`) and can read the
 * conversation (`TranscriptMirror`), but neither answers the question the phone
 * actually asks after an hour of edits: *what did it touch?* A rolling window
 * of 12 tool calls forgets; this does not.
 *
 * Fed from the same `postMessage` choke point as the tool feed, so it sees the
 * calls that never raise an approval card. Deliberately vscode-free: the
 * aggregation is pure bookkeeping and is unit-tested outside the host.
 */

/** Tools that write to the workspace. A read tool is never a "change". */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'edit_file',
  'apply_diff',
  'write_to_file',
  'delete_file',
]);

/** Argument keys a mutating tool may name its target with, most specific first. */
const PATH_KEYS = ['path', 'filePath', 'file', 'targetPath', 'target'] as const;

interface Entry {
  path: string;
  tool: string;
  edits: number;
  at: number;
  /** Mutating calls against this file that have not settled yet. */
  running: number;
  /** Settled calls against this file that reported an error. */
  failures: number;
}

/** One-line path for a phone: the workspace-relative target of a tool call. */
export function toolTargetPath(args: unknown): string | null {
  let value = args;
  if (typeof value === 'string') {
    // A replayed transcript carries arguments as JSON text.
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Aggregates mutating tool calls into a deduplicated, capped file list.
 *
 * Status is derived, never assigned: a file is `running` while any call
 * against it is in flight, `error` once one of them has failed, and `ok`
 * otherwise — so a retry that succeeds still leaves the failure visible, which
 * is the honest thing to show from a sofa.
 */
export class ChangedFilesTracker {
  private readonly files = new Map<string, Entry>();
  private readonly byCall = new Map<string, string>();
  private truncated = false;
  private readonly now: () => number;

  constructor(private readonly sink: (event: RemoteFilesEvent) => void, now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  /** True when `name` writes to the workspace. */
  static isMutating(name: string): boolean {
    return MUTATING_TOOLS.has(name);
  }

  /**
   * Record a mutating call that just started.
   *
   * Returns true when the file list changed — a read tool, an unrecognised
   * argument shape and a duplicate `callId` all return false so the caller
   * does not push an identical frame to the phone.
   */
  start(callId: string, name: string, args: unknown): boolean {
    if (!MUTATING_TOOLS.has(name)) {
      return false;
    }
    const path = toolTargetPath(args);
    if (!path || this.byCall.has(callId)) {
      return false;
    }
    const entry = this.entryFor(path);
    entry.tool = name;
    entry.edits += 1;
    entry.at = this.now();
    entry.running += 1;
    this.byCall.set(callId, path);
    this.trim();
    this.emit();
    return true;
  }

  /**
   * Record how a call ended. Calls that were never tracked (a read, or a call
   * from before the console was switched on) are ignored.
   */
  settle(callId: string, status: RemoteToolStatus): boolean {
    const path = this.byCall.get(callId);
    if (!path) {
      return false;
    }
    this.byCall.delete(callId);
    const entry = this.files.get(path);
    if (!entry) {
      return false;
    }
    entry.running = Math.max(0, entry.running - 1);
    if (status === 'error') {
      entry.failures += 1;
    }
    // A settle is not a touch: the modification happened at start.
    this.emit();
    return true;
  }

  /** The whole list, for `GET /files` and for every `files` frame. */
  snapshot(): RemoteFilesEvent {
    const files: RemoteChangedFile[] = [];
    for (const entry of this.files.values()) {
      files.push({
        path: entry.path,
        tool: entry.tool,
        status: entry.failures > 0 ? 'error' : entry.running > 0 ? 'running' : 'ok',
        edits: entry.edits,
        at: entry.at,
      });
    }
    const event: RemoteFilesEvent = { type: 'files', files };
    if (this.truncated) {
      event.truncated = true;
    }
    return event;
  }

  /** How many files are tracked (test hook; the console uses the snapshot). */
  get size(): number {
    return this.files.size;
  }

  reset(): void {
    this.files.clear();
    this.byCall.clear();
    this.truncated = false;
    this.emit();
  }

  private entryFor(path: string): Entry {
    const existing = this.files.get(path);
    if (existing) {
      return existing;
    }
    const entry: Entry = { path, tool: '', edits: 0, at: this.now(), running: 0, failures: 0 };
    this.files.set(path, entry);
    return entry;
  }

  /**
   * Drop the least recently touched files beyond the cap.
   *
   * Evicting the COLDEST rather than the oldest means a long run that keeps
   * coming back to one file never loses it.
   */
  private trim(): void {
    while (this.files.size > MAX_CHANGED_FILES) {
      let coldest: string | null = null;
      let coldestAt = Number.POSITIVE_INFINITY;
      for (const entry of this.files.values()) {
        if (entry.at < coldestAt) {
          coldestAt = entry.at;
          coldest = entry.path;
        }
      }
      if (coldest === null) {
        return;
      }
      this.files.delete(coldest);
      for (const [callId, path] of this.byCall) {
        if (path === coldest) {
          this.byCall.delete(callId);
        }
      }
      this.truncated = true;
    }
  }

  private emit(): void {
    try {
      this.sink(this.snapshot());
    } catch {
      /* a console that cannot be reached must not fail the tool call */
    }
  }
}

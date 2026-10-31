import {
  MAX_TOOL_ACTIVITY,
  MAX_TOOL_DETAIL,
  type RemoteToolActivity,
  type RemoteToolFeedEvent,
  type RemoteToolStatus,
} from '../shared/remoteProtocol';

/**
 * Host-side feed of the tool calls the agent made, for the remote console.
 *
 * The console already mirrors the CONVERSATION (TranscriptMirror) and the
 * approvals, but a tool call that needs no consent never produced a message
 * there: the phone showed "Reading the thread…" for the whole minute the agent
 * spent editing files. `update.tool` / `update.toolResult` in the agentic loop
 * are that missing signal, and this is where they land.
 *
 * Design notes:
 *  - Bounded ring: a long Act/YOLO turn makes hundreds of calls; the phone only
 *    ever needs the last handful, and the whole feed is pushed as ONE frame.
 *  - Keyed by call id: the loop announces the same call twice (once with
 *    details, once without) and the result arrives separately, so start/finish
 *    must upsert rather than append.
 *  - Never throws: this is telemetry for a second screen and must not be able
 *    to break the turn that produces it.
 */

/**
 * Argument keys, in the order the console prefers them for a one-line digest.
 *
 * The most DESCRIPTIVE value wins, not the first key: for a `search_files` call
 * the regex says far more than the directory it ran in.
 */
const DETAIL_KEYS = [
  'command', 'commands',
  'regex', 'pattern', 'query', 'search',
  'path', 'paths', 'file', 'files', 'glob', 'file_pattern',
  'url', 'id', 'ids', 'workItemId', 'title', 'agent', 'runId', 'state',
  'text', 'content', 'prompt', 'message', 'value', 'name',
];

/** Longest digest for a single argument value (the entry itself caps at MAX_TOOL_DETAIL). */
const VALUE_CLIP = 80;

function clip(text: string, max = MAX_TOOL_DETAIL): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * One-line digest of a tool call's arguments.
 *
 * Deliberately shape-agnostic: a per-tool table would rot the moment a tool is
 * added, so this picks the first recognisable key and falls back to the first
 * scalar value. Arrays (a batch `edit_file`, `commands`) collapse to their
 * first entry plus a count.
 */
export function summariseToolArguments(args: unknown): string {
  if (args === null || args === undefined) { return ''; }
  if (typeof args === 'string') { return clip(args); }
  if (typeof args !== 'object') { return clip(String(args)); }

  const record = args as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    if (!(key in record)) { continue; }
    const value = record[key];
    if (Array.isArray(value)) {
      if (!value.length) { continue; }
      const first = clip(String(value[0]), 60);
      return value.length > 1 ? clip(`${first} (+${value.length - 1} more)`) : first;
    }
    if (value === null || value === undefined || typeof value === 'object') { continue; }
    if (value === '') { continue; }
    return clip(String(value), VALUE_CLIP);
  }
  // Nothing recognisable: show the keys, which at least tells the phone WHAT the
  // call is configured with without dumping a payload at it.
  const keys = Object.keys(record);
  return keys.length ? clip(keys.slice(0, 4).join(', ')) : '';
}

/**
 * The agent reports failures as tool RESULT text (`{ error: … }` JSON per the
 * repo convention, or a plain "Error:" line), not as a thrown exception — so
 * the only way to colour the row red is to read what came back.
 */
export function resultLooksLikeError(content: unknown): boolean {
  if (typeof content !== 'string') { return false; }
  const head = content.trim().slice(0, 200);
  if (/^\{?\s*"?error"?\s*:/i.test(head)) { return true; }
  return /^(error|failed|exception)\b/i.test(head);
}

export class ToolActivityFeed {
  private entries: RemoteToolActivity[] = [];
  private readonly started = new Map<string, number>();
  private lastId = 0;
  private readonly now: () => number;

  /**
   * @param sink  where each change goes (RemoteControl.broadcast in production)
   * @param now   injectable clock — the tests assert on durations
   */
  constructor(private readonly sink: (event: RemoteToolFeedEvent) => void, now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  /** A tool call started (or was re-announced by the loop). */
  start(id: string, name: string, detail = ''): RemoteToolActivity | null {
    try {
      const callId = String(id || `tool-${++this.lastId}`);
      const existing = this.entries.find(entry => entry.id === callId);
      if (existing) {
        // Re-announcement: keep the first timestamp (the call really started
        // then) and never regress a finished row back to "running".
        if (detail && !existing.detail) { existing.detail = clip(detail); }
        if (!existing.name && name) { existing.name = String(name); }
        this.publish();
        return existing;
      }
      const startedAt = this.now();
      this.started.set(callId, startedAt);
      const entry: RemoteToolActivity = {
        id: callId,
        name: String(name || 'tool'),
        detail: clip(detail),
        status: 'running',
        startedAt,
      };
      this.entries.push(entry);
      this.trim();
      this.publish();
      return entry;
    } catch {
      return null;
    }
  }

  /** A tool call finished: `ok`, or `error` when the result says so. */
  finish(id: string, status: RemoteToolStatus = 'ok'): RemoteToolActivity | null {
    try {
      const entry = this.entries.find(candidate => candidate.id === String(id));
      if (!entry) { return null; }
      if (entry.status !== 'running') { return entry; }
      const startedAt = this.started.get(entry.id) ?? entry.startedAt;
      entry.status = status;
      entry.durationMs = Math.max(0, this.now() - startedAt);
      this.publish();
      return entry;
    } catch {
      return null;
    }
  }

  /** Convenience for a result frame — decides the status from the payload. */
  finishWithResult(id: string, content: unknown): RemoteToolActivity | null {
    return this.finish(id, resultLooksLikeError(content) ? 'error' : 'ok');
  }

  /** The feed as the console renders it: oldest first. */
  snapshot(): RemoteToolActivity[] {
    return this.entries.map(entry => ({ ...entry }));
  }

  /** The ready-to-broadcast frame (also the body of GET /tools). */
  event(): RemoteToolFeedEvent {
    return { type: 'toolFeed', entries: this.snapshot() };
  }

  clear(): void {
    if (!this.entries.length) { return; }
    this.entries = [];
    this.started.clear();
    this.publish();
  }

  private trim(): void {
    while (this.entries.length > MAX_TOOL_ACTIVITY) {
      const dropped = this.entries.shift();
      if (dropped) { this.started.delete(dropped.id); }
    }
  }

  private publish(): void {
    try {
      this.sink(this.event());
    } catch {
      /* a console that cannot be reached must not fail the tool call */
    }
  }
}

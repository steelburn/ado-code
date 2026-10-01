/**
 * Pure helpers for the chat-area declutter strategy — item 1
 * ("Group a turn's tool calls into one collapsible activity row").
 *
 * The webview renders a turn as an ordered list of trace entries: reasoning
 * blocks interleaved with tool calls. Consecutive tool calls are noise at the
 * top level (a turn routinely fires 7+), so we fold each *run* of consecutive
 * tool calls into a single "Ran N tools" activity segment. Reasoning blocks are
 * preserved in place — they delimit the runs and explain the batch that follows.
 *
 * Nothing is deleted, only folded: the activity segment still carries every
 * call, so the UI can expand it into the existing per-tool cards.
 *
 * Kept framework-free so it can be unit-tested from the host test suite. The
 * webview imports it across the build-root boundary (see the `rootDir` setting
 * in src/webview-ui/tsconfig.json), so there is a single tested source.
 */

/** A trace entry as the grouping helper sees it (structurally a `TraceEntry`). */
export type ToolTraceLike<T> =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; call: T };

/** A grouped trace: reasoning stays as-is, runs of tools become `activity`. */
export type ToolTraceGroup<T> =
  | { kind: 'thinking'; text: string }
  | { kind: 'activity'; calls: T[] };

/**
 * Fold each run of consecutive `tool` entries into one `activity` segment.
 * Thinking entries pass through untouched and break the runs.
 */
export function groupToolActivity<T>(entries: ToolTraceLike<T>[]): ToolTraceGroup<T>[] {
  const groups: ToolTraceGroup<T>[] = [];
  for (const entry of entries) {
    if (entry.kind === 'thinking') {
      groups.push({ kind: 'thinking', text: entry.text });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.kind === 'activity') {
      last.calls.push(entry.call);
    } else {
      groups.push({ kind: 'activity', calls: [entry.call] });
    }
  }
  return groups;
}

/** Header label for an activity row: "Ran 1 tool" / "Ran 7 tools". */
export function toolActivityLabel(count: number): string {
  return count === 1 ? 'Ran 1 tool' : `Ran ${count} tools`;
}

/**
 * A compact, collapsed-state preview of the tools in a run — the first two
 * distinct tool names plus a "+N" counter for the rest (unnamed → "tool").
 */
export function toolActivityPreview(calls: Array<{ name?: string } | undefined>): string {
  const names = calls.map((c) => {
    const name = c && typeof c.name === 'string' ? c.name.trim() : '';
    return name || 'tool';
  });
  const distinct = names.filter((n, i) => names.indexOf(n) === i);
  if (distinct.length === 0) {
    return '';
  }
  if (distinct.length <= 2) {
    return distinct.join(', ');
  }
  return `${distinct.slice(0, 2).join(', ')} +${distinct.length - 2}`;
}

/**
 * Transient status line (chat-declutter strategy, item 7).
 *
 * The "Working…" headline and the per-tool running spinners are *transient*
 * state — they describe what the assistant is doing right now, not part of the
 * conversation record. This module distils them into a single low-contrast
 * line pinned above the input, so the thread keeps only durable content while
 * the live status stays legible in one predictable place.
 *
 * Pure and side-effect free, so the host test suite and the webview share the
 * exact same logic (the webview imports `src/shared` directly).
 */

/** The subset of a trace entry this module reads. */
export interface StatusTraceEntry {
    kind: string;
    /** Present on `thinking` entries. */
    text?: string;
    /** Present on `tool` entries (subset of `ToolCallInfo`). */
    call?: {
        done?: boolean;
        result?: unknown;
        showDetails?: boolean;
    };
}

export interface StatusInput {
    /** Host-driven activity label (e.g. skill execution, task generation). */
    activity?: string | null;
    /** Streaming assistant text, if any. */
    streamText?: string | null;
    /** True when a reasoning block is already visible for this turn. */
    hasVisibleThinking?: boolean;
    /** True when any visible tool card is still running. */
    anyToolRunning?: boolean;
    /** Whether the assistant is currently working. */
    loading?: boolean;
}

/** `"Executing skill: lint"` → `"Executing skill: lint…"`; blank/absent → `""`. */
export function activityHeadline(activity?: string | null): string {
    const text = typeof activity === 'string' ? activity.trim() : '';
    return text ? `${text}…` : '';
}

/**
 * The single transient headline, with the same precedence the legacy inline row
 * used: host activity wins; otherwise the wording depends on whether reasoning
 * is already on screen (so the word "Thinking" isn't repeated). Returns `""`
 * when not loading, so the status line collapses entirely.
 */
export function deriveStatusText(input: StatusInput): string {
    if (!input.loading) return '';
    const headline = activityHeadline(input.activity);
    if (headline) return headline;
    if (input.hasVisibleThinking) {
        return input.streamText || input.anyToolRunning ? 'Working…' : 'Reasoning…';
    }
    return input.streamText ? 'Responding…' : 'Thinking…';
}

/**
 * Counts visible tool cards that are still in flight — the same predicate the
 * inline `anyToolRunning` check used (finished = `done` or a result is present;
 * hidden cards are excluded).
 */
export function countRunningTools(entries: StatusTraceEntry[] | undefined | null): number {
    if (!Array.isArray(entries)) return 0;
    let count = 0;
    for (const entry of entries) {
        if (!entry || entry.kind !== 'tool' || !entry.call) continue;
        if (entry.call.showDetails === false) continue;
        if (entry.call.done || entry.call.result !== undefined) continue;
        count += 1;
    }
    return count;
}

/** `("Working…", 2)` → `"Working… · 2 tools running"`; `0` leaves it untouched. */
export function statusLineText(text: string, runningTools: number): string {
    const base = typeof text === 'string' ? text.trim() : '';
    const n = Number.isFinite(runningTools) && runningTools > 0 ? Math.floor(runningTools) : 0;
    if (n === 0) return base;
    const suffix = `${n} tool${n === 1 ? '' : 's'} running`;
    return base ? `${base} · ${suffix}` : suffix;
}

/**
 * Pure helpers for the chat-area declutter strategy — item 4
 * ("A compact, count-based summary line on a completed turn").
 *
 * A finished turn collapses its activity into one row (item 1). This adds the
 * at-a-glance cost of that turn — `Ran 7 tools · 2 files edited` — derived
 * purely from the turn's trace. Deliberately count-based: the trace carries no
 * timing or token data, so the summary promises nothing it cannot source.
 *
 * Pure and dependency-light so both the webview and the host test suite can
 * consume it (the webview resolves this via its `rootDir: "../.."` tsconfig).
 */

import { ToolTraceLike, toolActivityLabel } from './toolActivity';

/** The subset of a tool call the summariser reads. */
export interface ToolCallLike {
    name?: string;
    arguments?: Record<string, any>;
}

export interface TurnSummary {
    /** Number of tool calls in the turn. */
    tools: number;
    /** Distinct files touched by mutating tools (edit/write/apply/delete/create). */
    filesEdited: number;
    /** Number of reasoning blocks in the turn. */
    reasoning: number;
}

/** Tools that change files on disk — the ones that count toward "files edited". */
const FILE_MUTATING_TOOLS = new Set([
    'edit_file',
    'write_to_file',
    'apply_diff',
    'delete_file',
    'create_file',
]);

/** Argument keys that carry a file path across the tool set. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename'];

function callName(call: ToolCallLike | undefined): string {
    return call && typeof call.name === 'string' ? call.name : '';
}

function callPath(call: ToolCallLike | undefined): string | undefined {
    const args = call?.arguments;
    if (!args || typeof args !== 'object') {
        return undefined;
    }
    for (const key of PATH_KEYS) {
        const value = (args as Record<string, any>)[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

/**
 * Roll a turn's trace up into count-based metrics. Never throws — a missing or
 * malformed trace yields all zeros.
 */
export function summarizeTurn(
    trace: ReadonlyArray<ToolTraceLike<ToolCallLike>> | undefined,
): TurnSummary {
    const summary: TurnSummary = { tools: 0, filesEdited: 0, reasoning: 0 };
    if (!trace) {
        return summary;
    }
    const files = new Set<string>();
    for (const entry of trace) {
        if (entry.kind === 'thinking') {
            summary.reasoning++;
            continue;
        }
        summary.tools++;
        if (FILE_MUTATING_TOOLS.has(callName(entry.call))) {
            const path = callPath(entry.call);
            if (path) {
                files.add(path);
            }
        }
    }
    summary.filesEdited = files.size;
    return summary;
}

/**
 * Format a turn summary as a single line, e.g. `Ran 7 tools · 2 files edited`.
 * Returns '' when there is nothing worth saying (an empty or reasoning-only
 * turn), so callers can render the row unconditionally.
 */
export function formatTurnSummary(summary: TurnSummary): string {
    const parts: string[] = [];
    if (summary.tools > 0) {
        parts.push(toolActivityLabel(summary.tools));
    }
    if (summary.filesEdited > 0) {
        parts.push(
            summary.filesEdited === 1
                ? '1 file edited'
                : `${summary.filesEdited} files edited`,
        );
    }
    return parts.join(' · ');
}

/**
 * Pure helpers behind "switching chat sessions must never kill a running turn".
 *
 * A chat turn is bound to the session it was started from, and only ONE LLM
 * turn runs at a time (a single abort slot drives the agentic loop). Therefore:
 *
 *  - switching sessions DETACHES the running turn — it keeps streaming into its
 *    own session buffer and persists when it finishes — instead of aborting it;
 *  - its live output only reaches the webview while that session is the one on
 *    screen, so switching back re-attaches the stream;
 *  - sending a message in a DIFFERENT session while one is still running is the
 *    only case that would silently abort it, so the user is warned first.
 */

/**
 * True when a session's live turn output should reach the webview: only ever
 * when the turn's own session is the one currently displayed.
 */
export function isTurnVisible(
    turnSessionId: string | null | undefined,
    activeSessionId: string | null | undefined,
): boolean {
    return !!turnSessionId && turnSessionId === activeSessionId;
}

/**
 * The id of a still-running turn owned by a session OTHER than the visible one,
 * or null when nothing foreign is running (including "no turn at all").
 */
export function foreignRunningTurn(
    runningSessionId: string | null | undefined,
    activeSessionId: string | null | undefined,
): string | null {
    if (!runningSessionId) return null;
    return runningSessionId === activeSessionId ? null : runningSessionId;
}

/**
 * Shared copy for the switch-back banner and the send-while-busy warning.
 */
export function runningElsewhereNotice(sessionName?: string | null): string {
    const name = sessionName && sessionName.trim() ? sessionName.trim() : 'another session';
    return `A response is still being generated in \u201c${name}\u201d.`;
}

/**
 * Badge data for the session list: which session still owns the in-flight turn,
 * whether it is generating while a DIFFERENT session is on screen (a background
 * run), and the tooltip to show. Null when nothing is running.
 *
 * Computed on the HOST and shipped verbatim to the webview — the webview
 * imports this module (re-exported by src/webview-ui/src/types.ts), so it must
 * not re-derive the foreground/background split itself.
 */
export interface SessionRunInfo {
    /** Id of the session whose turn is still generating. */
    id: string;
    /** True when it runs while another session is the one on screen. */
    background: boolean;
    /** Tooltip for the running badge. */
    title: string;
}

export function sessionRunInfo(
    runningSessionId: string | null | undefined,
    activeSessionId: string | null | undefined,
): SessionRunInfo | null {
    if (!runningSessionId) return null;
    const background = runningSessionId !== activeSessionId;
    return {
        id: runningSessionId,
        background,
        title: background
            ? 'Generating\u2026 running in the background'
            : 'Generating\u2026',
    };
}

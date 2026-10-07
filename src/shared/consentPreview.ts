/**
 * Consent-preview helpers (pure; shared by the extension host and the webview).
 *
 * A tool call's arguments — most visibly `run_terminal_command`'s `command` —
 * can be enormous (heredocs, `node -e "…"`, big one-liners). The consent card
 * and the transcript render that text verbatim, so an unbounded preview pushes
 * the Allow/Deny buttons and the input bar off-screen (the app column is
 * `overflow:hidden`). These helpers clamp the text for DISPLAY only: approval
 * is keyed by `requestId`, so shortening the payload never changes what runs.
 */

/** Default cap for a one-line summary preview, in characters. */
export const SUMMARY_PREVIEW_MAX_CHARS = 200;

/** Default per-string cap for a consent payload, in characters. */
export const CONSENT_ARG_MAX_CHARS = 2000;

export interface TextPreview {
    /** Clamped preview: the first line, capped, plus an overflow marker. */
    preview: string;
    /** True when `preview` shows less than the input (a toggle should appear). */
    truncated: boolean;
}

/**
 * Build a short, roughly single-line preview of possibly huge text.
 * Keeps the first line (capped at `maxChars`) and appends a marker describing
 * what was hidden — either `… (+N more lines)` or `… (+N chars)`.
 */
export function buildTextPreview(text: unknown, maxChars: number = SUMMARY_PREVIEW_MAX_CHARS): TextPreview {
    const raw = text == null ? '' : String(text);
    const cap = Math.max(1, maxChars);
    if (raw.length <= cap) return { preview: raw, truncated: false };

    const nl = raw.search(/[\r\n]/);
    const firstLine = nl === -1 ? raw : raw.slice(0, nl);
    const head = firstLine.length > cap ? firstLine.slice(0, cap) : firstLine;

    // Count newlines after whatever we are showing to describe the overflow.
    let extraLines = 0;
    for (let i = head.length; i < raw.length; i++) {
        if (raw.charCodeAt(i) === 10 /* \n */) extraLines++;
    }
    const hiddenChars = raw.length - head.length;
    const marker = extraLines > 0
        ? `… (+${extraLines} more line${extraLines === 1 ? '' : 's'})`
        : `… (+${hiddenChars} chars)`;
    return { preview: `${head} ${marker}`, truncated: true };
}

export interface TruncatedArgs {
    args: Record<string, any>;
    /** True when at least one value was shortened. */
    truncated: boolean;
}

/**
 * Shallow-clamp oversized STRING values in a consent payload so an enormous
 * command cannot bloat the `consentRequest` message or the card. Non-strings
 * are passed through untouched (they are small and structured). Display-only.
 */
export function truncateConsentArgs(
    args: Record<string, any> | undefined,
    maxChars: number = CONSENT_ARG_MAX_CHARS,
): TruncatedArgs {
    if (!args || typeof args !== 'object') return { args: {}, truncated: false };
    const cap = Math.max(1, maxChars);
    let truncated = false;
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.length > cap) {
            out[key] = `${value.slice(0, cap)}\n… [truncated ${value.length - cap} chars]`;
            truncated = true;
        } else {
            out[key] = value;
        }
    }
    return { args: out, truncated };
}

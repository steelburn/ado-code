/**
 * Pure helpers for the chat-area declutter strategy — item 5
 * ("Explicit chat density modes").
 *
 * The previous declutter items each fold *something* away (tool calls → one
 * activity row, reasoning → quiet text, attachments → chips). Density draws
 * them together behind a single, explicit, user-chosen setting so the chat can
 * be dialled from fully narrated down to answers-only:
 *
 *   - `comfortable`  — the default; everything (activity row, reasoning,
 *                      summary line) is rendered.
 *   - `compact`      — same chrome, but the spacing rules that follow from the
 *                      mode class tighten vertical rhythm.
 *   - `answers-only` — chrome (tool activity, reasoning, turn summary) is
 *                      hidden for completed turns; the reader who wants it can
 *                      still reveal a single turn's details.
 *
 * Everything here is pure and host-tested, so the webview imports it directly
 * rather than duplicating the logic (see `src/webview-ui/tsconfig.json`
 * `rootDir: "../.."`).
 */

/** The three density modes, tightest last. */
export type ChatDensity = 'comfortable' | 'compact' | 'answers-only';

/** Canonical, ordered list of density modes. */
export const CHAT_DENSITY_MODES: readonly ChatDensity[] = [
    'comfortable',
    'compact',
    'answers-only',
];

/** Mode used when nothing is configured or a value is unrecognised. */
export const DEFAULT_CHAT_DENSITY: ChatDensity = 'comfortable';

function isChatDensity(value: unknown): value is ChatDensity {
    return (
        typeof value === 'string' &&
        (CHAT_DENSITY_MODES as readonly string[]).includes(value)
    );
}

/**
 * Coerce an arbitrary configured value into a `ChatDensity`.
 *
 * Tolerant of surrounding whitespace and casing (settings values often arrive
 * as authored strings), and falls back to {@link DEFAULT_CHAT_DENSITY} for
 * anything unrecognised — including `null`/`undefined`/non-strings — so the
 * webview can render unconditionally without validating upstream.
 */
export function normalizeDensity(value: unknown): ChatDensity {
    if (typeof value !== 'string') {
        return DEFAULT_CHAT_DENSITY;
    }
    const normalized = value.trim().toLowerCase();
    return isChatDensity(normalized) ? normalized : DEFAULT_CHAT_DENSITY;
}

/**
 * The container CSS class that carries the per-mode styling
 * (`.chat-density-comfortable`, `.chat-density-compact`,
 * `.chat-density-answers-only`).
 */
export function densityContainerClass(mode: ChatDensity): string {
    return `chat-density-${mode}`;
}

/**
 * Whether the mode drops the per-turn chrome (tool activity, reasoning text,
 * and the turn summary line). Only `answers-only` does; `compact` keeps the
 * chrome and merely tightens spacing.
 */
export function densityHidesChrome(mode: ChatDensity): boolean {
    return mode === 'answers-only';
}

/**
 * Whether the chrome (activity row / reasoning / summary) should render for a
 * given turn.
 *
 * `comfortable` and `compact` always show it. `answers-only` hides it for
 * completed turns, but a turn the reader has explicitly expanded (`expanded`
 * true) reveals it again — so the detail is folded by default, never lost.
 */
export function isChromeVisible(mode: ChatDensity, expanded: boolean): boolean {
    return !densityHidesChrome(mode) || expanded;
}

/**
 * The next mode in the cycle `comfortable → compact → answers-only →
 * comfortable`, used by the kebab "cycle density" action.
 */
export function cycleDensity(mode: ChatDensity): ChatDensity {
    const index = CHAT_DENSITY_MODES.indexOf(mode);
    if (index === -1) {
        return DEFAULT_CHAT_DENSITY;
    }
    return CHAT_DENSITY_MODES[(index + 1) % CHAT_DENSITY_MODES.length];
}

/** Human-readable label for a density mode (shown in the kebab menu / settings). */
export function densityLabel(mode: ChatDensity): string {
    switch (mode) {
        case 'compact':
            return 'Compact';
        case 'answers-only':
            return 'Answers only';
        case 'comfortable':
        default:
            return 'Comfortable';
    }
}

/** Label for the per-turn details toggle, reflecting the *next* action. */
export function detailsToggleLabel(expanded: boolean): string {
    return expanded ? 'Hide details' : 'Show details';
}

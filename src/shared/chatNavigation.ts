/**
 * Pure helpers for the chat-area declutter strategy — item 6
 * ("Sticky 'jump to latest answer' + collapse-all").
 *
 * A long, tool-heavy thread pushes the newest answer far below the fold. Two
 * navigation aids fix that: a floating "jump to latest" affordance that appears
 * once the reader scrolls up, and a collapse/expand-all override driven from
 * the kebab menu. Both decisions are trivial arithmetic and state resolution —
 * kept pure here so the host test suite can exercise them without a DOM.
 */

/** Distance (px) from the bottom below which the reader counts as "at the
 *  bottom" and the jump-to-latest affordance stays hidden. */
export const JUMP_TO_LATEST_THRESHOLD_PX = 120;

/**
 * Whether the scroll viewport is far enough from the bottom that a
 * "jump to latest answer" affordance should be offered.
 *
 * Defensive by design: non-finite inputs (a detached/unmeasured element) and
 * content shorter than the viewport both resolve to `false`, so the affordance
 * never flashes on an empty or already-bottomed thread.
 */
export function shouldShowJumpToLatest(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    threshold: number = JUMP_TO_LATEST_THRESHOLD_PX,
): boolean {
    if (
        !Number.isFinite(scrollTop) ||
        !Number.isFinite(scrollHeight) ||
        !Number.isFinite(clientHeight) ||
        !Number.isFinite(threshold)
    ) {
        return false;
    }
    const maxScroll = scrollHeight - clientHeight;
    if (maxScroll <= threshold) {
        return false;
    }
    return scrollTop < maxScroll - threshold;
}

/**
 * Resolve the effective expanded state of a turn's folded activity row.
 *
 * `override` comes from the kebab collapse/expand-all action: `true` forces
 * every row open, `false` forces every row closed, and `null`/`undefined` means
 * "no override" — fall back to the row's per-turn default (live turns open,
 * completed turns closed).
 */
export function resolveActivityExpanded(
    defaultOpen: boolean,
    override: boolean | null | undefined,
): boolean {
    return override === null || override === undefined ? defaultOpen : override;
}

/**
 * Label for the kebab collapse/expand-all action, describing what it does
 * *next*: while rows are forced open (or undecided) it collapses, and once they
 * are forced closed it expands.
 */
export function collapseAllActionLabel(override: boolean | null | undefined): string {
    return override === false ? 'Expand all turns' : 'Collapse all turns';
}

/**
 * Whether an incoming chat-area update should scroll the viewport down to the
 * newest content.
 *
 * The reader "follows" the thread while `stickToBottom` is true (parked at the
 * bottom). Once they scroll up into history we stop auto-scrolling so streamed
 * tokens and freshly appended turns don't yank them back to the end. Two cases
 * override that and re-engage following:
 *
 *  - the reader just sent a message (`countDelta > 0 && lastRole === 'user'`) --
 *    they expect to see it and the reply, and
 *  - a bulk load (`countDelta > 1`: refresh / session switch) which must land at
 *    the newest content.
 *
 * Pure and side-effect free so the host test suite can exercise every branch.
 */
export function shouldAutoScroll(
    stickToBottom: boolean,
    countDelta: number,
    lastRole?: string | null,
): boolean {
    if (countDelta > 1) {
        return true;
    }
    if (countDelta > 0 && lastRole === 'user') {
        return true;
    }
    return stickToBottom;
}

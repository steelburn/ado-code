import * as assert from 'assert';
import {
    shouldShowJumpToLatest,
    shouldAutoScroll,
    resolveActivityExpanded,
    collapseAllActionLabel,
    JUMP_TO_LATEST_THRESHOLD_PX,
} from '../../../shared/chatNavigation';

suite('shared/chatNavigation', () => {
    suite('shouldShowJumpToLatest', () => {
        test('false when the viewport is parked at the bottom', () => {
            // 1000px of content in a 400px viewport, scrolled fully down.
            assert.strictEqual(shouldShowJumpToLatest(600, 1000, 400), false);
        });

        test('true when the user has scrolled well above the bottom', () => {
            assert.strictEqual(shouldShowJumpToLatest(0, 1000, 400), true);
        });

        test('false when within the threshold of the bottom', () => {
            // maxScroll = 600; 560 leaves only 40px (< 120 default threshold).
            assert.strictEqual(shouldShowJumpToLatest(560, 1000, 400), false);
        });

        test('true once the gap exceeds the threshold', () => {
            // 459 leaves a 141px gap (> 120 default threshold).
            assert.strictEqual(shouldShowJumpToLatest(459, 1000, 400), true);
        });

        test('false when content is shorter than the viewport', () => {
            assert.strictEqual(shouldShowJumpToLatest(0, 300, 400), false);
        });

        test('honours a custom threshold', () => {
            // 40px gap is "away" under a 10px threshold.
            assert.strictEqual(shouldShowJumpToLatest(560, 1000, 400, 10), true);
            assert.strictEqual(shouldShowJumpToLatest(560, 1000, 400, 120), false);
        });

        test('default threshold constant is exposed', () => {
            assert.strictEqual(typeof JUMP_TO_LATEST_THRESHOLD_PX, 'number');
            assert.ok(JUMP_TO_LATEST_THRESHOLD_PX > 0);
        });

        test('false for non-finite inputs', () => {
            assert.strictEqual(shouldShowJumpToLatest(NaN, 1000, 400), false);
            assert.strictEqual(shouldShowJumpToLatest(0, Infinity, 400), false);
            assert.strictEqual(shouldShowJumpToLatest(0, 1000, NaN), false);
        });
    });

    suite('resolveActivityExpanded', () => {
        test('null override falls back to the per-turn default', () => {
            assert.strictEqual(resolveActivityExpanded(true, null), true);
            assert.strictEqual(resolveActivityExpanded(false, null), false);
        });

        test('undefined override falls back to the per-turn default', () => {
            assert.strictEqual(resolveActivityExpanded(true, undefined), true);
            assert.strictEqual(resolveActivityExpanded(false, undefined), false);
        });

        test('true override forces every row open', () => {
            assert.strictEqual(resolveActivityExpanded(false, true), true);
            assert.strictEqual(resolveActivityExpanded(true, true), true);
        });

        test('false override forces every row closed', () => {
            assert.strictEqual(resolveActivityExpanded(true, false), false);
            assert.strictEqual(resolveActivityExpanded(false, false), false);
        });
    });

    suite('shouldAutoScroll', () => {
        test('follows the newest content while parked at the bottom', () => {
            assert.strictEqual(shouldAutoScroll(true, 0, 'assistant'), true);
            assert.strictEqual(shouldAutoScroll(true, 1, 'assistant'), true);
        });

        test('stays put once the reader scrolled up (streaming tokens)', () => {
            assert.strictEqual(shouldAutoScroll(false, 0, 'assistant'), false);
        });

        test('stays put when a new assistant turn arrives after scrolling up', () => {
            assert.strictEqual(shouldAutoScroll(false, 1, 'assistant'), false);
        });

        test('re-engages when the reader just sent a message', () => {
            assert.strictEqual(shouldAutoScroll(false, 1, 'user'), true);
        });

        test('always scrolls on a bulk load (refresh / session switch)', () => {
            assert.strictEqual(shouldAutoScroll(false, 5, 'assistant'), true);
            assert.strictEqual(shouldAutoScroll(false, 2, 'user'), true);
        });

        test('empty thread keeps following state', () => {
            assert.strictEqual(shouldAutoScroll(true, 0, undefined), true);
            assert.strictEqual(shouldAutoScroll(false, 0, null), false);
        });
    });

    suite('collapseAllActionLabel', () => {
        test('offers collapse when undecided', () => {
            assert.strictEqual(collapseAllActionLabel(null), 'Collapse all turns');
            assert.strictEqual(collapseAllActionLabel(undefined), 'Collapse all turns');
        });

        test('offers collapse while rows are forced open', () => {
            assert.strictEqual(collapseAllActionLabel(true), 'Collapse all turns');
        });

        test('offers expand once rows are forced closed', () => {
            assert.strictEqual(collapseAllActionLabel(false), 'Expand all turns');
        });
    });
});

import * as assert from 'assert';
import {
    activityHeadline,
    deriveStatusText,
    countRunningTools,
    statusLineText,
} from '../../../shared/transientStatus';

/** Minimal trace-entry factory — only the fields the helper reads. */
const think = (text = 'reasoning'): any => ({ kind: 'thinking', text });
const tool = (over: Record<string, any> = {}): any => ({
    kind: 'tool',
    call: { id: 't', name: 'read_file', arguments: {}, ...over },
});

suite('shared/transientStatus', () => {
    suite('activityHeadline', () => {
        test('appends an ellipsis to a host activity label', () => {
            assert.strictEqual(
                activityHeadline('Executing skill: lint'),
                'Executing skill: lint…',
            );
        });

        test('returns empty string for blank, null and undefined', () => {
            assert.strictEqual(activityHeadline(''), '');
            assert.strictEqual(activityHeadline('   '), '');
            assert.strictEqual(activityHeadline(null), '');
            assert.strictEqual(activityHeadline(undefined), '');
        });

        test('trims surrounding whitespace before appending', () => {
            assert.strictEqual(activityHeadline('  Generating tasks '), 'Generating tasks…');
        });
    });

    suite('deriveStatusText', () => {
        test('returns empty string when not loading (collapses the line)', () => {
            assert.strictEqual(deriveStatusText({ loading: false, streamText: 'hi' }), '');
        });

        test('host activity wins over every other signal', () => {
            assert.strictEqual(
                deriveStatusText({
                    loading: true,
                    activity: 'Generating tasks',
                    streamText: 'hi',
                    hasVisibleThinking: true,
                    anyToolRunning: true,
                }),
                'Generating tasks…',
            );
        });

        test('with reasoning on screen and stream/tools → Working…', () => {
            assert.strictEqual(
                deriveStatusText({ loading: true, hasVisibleThinking: true, streamText: 'x' }),
                'Working…',
            );
            assert.strictEqual(
                deriveStatusText({ loading: true, hasVisibleThinking: true, anyToolRunning: true }),
                'Working…',
            );
        });

        test('with reasoning on screen and nothing else → Reasoning…', () => {
            assert.strictEqual(
                deriveStatusText({ loading: true, hasVisibleThinking: true }),
                'Reasoning…',
            );
        });

        test('without reasoning: stream → Responding…, else Thinking…', () => {
            assert.strictEqual(
                deriveStatusText({ loading: true, streamText: 'x' }),
                'Responding…',
            );
            assert.strictEqual(deriveStatusText({ loading: true }), 'Thinking…');
        });
    });

    suite('countRunningTools', () => {
        test('returns 0 for missing / non-array input', () => {
            assert.strictEqual(countRunningTools(undefined), 0);
            assert.strictEqual(countRunningTools([]), 0);
            assert.strictEqual(countRunningTools(null as any), 0);
        });

        test('counts only in-flight, visible tool calls', () => {
            assert.strictEqual(
                countRunningTools([tool(), tool(), think()]),
                2,
            );
        });

        test('ignores finished calls (done or with a result)', () => {
            assert.strictEqual(countRunningTools([tool({ done: true }), tool({ result: {} })]), 0);
        });

        test('ignores hidden calls (showDetails === false)', () => {
            assert.strictEqual(countRunningTools([tool({ showDetails: false })]), 0);
        });

        test('ignores non-tool entries and malformed entries', () => {
            assert.strictEqual(
                countRunningTools([think(), { kind: 'tool' } as any, null as any, tool()]),
                1,
            );
        });
    });

    suite('statusLineText', () => {
        test('returns the headline unchanged when nothing is running', () => {
            assert.strictEqual(statusLineText('Working…', 0), 'Working…');
        });

        test('appends a singular running-tools suffix', () => {
            assert.strictEqual(statusLineText('Working…', 1), 'Working… · 1 tool running');
        });

        test('appends a plural running-tools suffix', () => {
            assert.strictEqual(statusLineText('Working…', 3), 'Working… · 3 tools running');
        });

        test('emits just the suffix when the headline is empty', () => {
            assert.strictEqual(statusLineText('', 2), '2 tools running');
            assert.strictEqual(statusLineText('   ', 1), '1 tool running');
        });

        test('treats non-finite/negative counts as zero', () => {
            assert.strictEqual(statusLineText('Thinking…', NaN), 'Thinking…');
            assert.strictEqual(statusLineText('Thinking…', -4), 'Thinking…');
        });
    });
});

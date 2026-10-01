import * as assert from 'assert';
import {
    summarizeTurn,
    formatTurnSummary,
} from '../../../shared/turnSummary';

/** A minimal trace entry factory — only the fields the summariser reads. */
const think = (text = 'reasoning'): any => ({ kind: 'thinking', text });
const tool = (name: string, args: Record<string, any> = {}): any => ({
    kind: 'tool',
    call: { id: name, name, arguments: args },
});

suite('shared/turnSummary', () => {
    suite('summarizeTurn', () => {
        test('empty / undefined trace is all zeros', () => {
            const empty = { tools: 0, filesEdited: 0, reasoning: 0 };
            assert.deepStrictEqual(summarizeTurn(undefined), empty);
            assert.deepStrictEqual(summarizeTurn([]), empty);
        });

        test('counts tool calls and reasoning blocks', () => {
            const s = summarizeTurn([
                think(),
                tool('read_file', { path: 'a.ts' }),
                tool('read_file', { path: 'b.ts' }),
                think(),
            ]);
            assert.strictEqual(s.tools, 2);
            assert.strictEqual(s.reasoning, 2);
            assert.strictEqual(s.filesEdited, 0);
        });

        test('counts distinct files edited by mutating tools', () => {
            const s = summarizeTurn([
                tool('read_file', { path: 'read.ts' }),
                tool('edit_file', { path: 'a.ts' }),
                tool('write_to_file', { path: 'b.ts' }),
                tool('apply_diff', { path: 'c.ts' }),
                tool('delete_file', { path: 'd.ts' }),
            ]);
            assert.strictEqual(s.tools, 5);
            assert.strictEqual(s.filesEdited, 4);
        });

        test('deduplicates repeated edits to the same file', () => {
            const s = summarizeTurn([
                tool('edit_file', { path: 'a.ts' }),
                tool('edit_file', { path: 'a.ts' }),
                tool('apply_diff', { path: 'a.ts' }),
            ]);
            assert.strictEqual(s.filesEdited, 1);
        });

        test('ignores mutating tools with no usable path argument', () => {
            const s = summarizeTurn([
                tool('edit_file', {}),
                tool('write_to_file', { path: '   ' }),
                tool('delete_file', { path: 42 as any }),
            ]);
            assert.strictEqual(s.tools, 3);
            assert.strictEqual(s.filesEdited, 0);
        });

        test('accepts file_path / filePath / filename aliases', () => {
            const s = summarizeTurn([
                tool('edit_file', { file_path: 'a.ts' }),
                tool('write_to_file', { filePath: 'b.ts' }),
                tool('create_file', { filename: 'c.ts' }),
            ]);
            assert.strictEqual(s.filesEdited, 3);
        });
    });

    suite('formatTurnSummary', () => {
        test('empty summary formats to an empty string', () => {
            assert.strictEqual(
                formatTurnSummary({ tools: 0, filesEdited: 0, reasoning: 0 }),
                '',
            );
        });

        test('reasoning-only turn produces no summary line', () => {
            assert.strictEqual(
                formatTurnSummary(summarizeTurn([think(), think()])),
                '',
            );
        });

        test('tools only', () => {
            assert.strictEqual(
                formatTurnSummary({ tools: 3, filesEdited: 0, reasoning: 1 }),
                'Ran 3 tools',
            );
        });

        test('tools and files, plural', () => {
            assert.strictEqual(
                formatTurnSummary({ tools: 7, filesEdited: 2, reasoning: 0 }),
                'Ran 7 tools · 2 files edited',
            );
        });

        test('tools and files, singular', () => {
            assert.strictEqual(
                formatTurnSummary({ tools: 1, filesEdited: 1, reasoning: 0 }),
                'Ran 1 tool · 1 file edited',
            );
        });
    });
});

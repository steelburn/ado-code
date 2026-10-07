import * as assert from 'assert';
import {
    buildTextPreview,
    truncateConsentArgs,
    SUMMARY_PREVIEW_MAX_CHARS,
    CONSENT_ARG_MAX_CHARS,
} from '../../../shared/consentPreview';

suite('shared/consentPreview', () => {
    suite('buildTextPreview', () => {
        test('returns short text unchanged and not truncated', () => {
            const r = buildTextPreview('git status');
            assert.strictEqual(r.preview, 'git status');
            assert.strictEqual(r.truncated, false);
        });

        test('keeps the first line of a long multi-line command and reports extra lines', () => {
            const cmd = 'node -e "x"\n' + 'y'.repeat(300);
            const r = buildTextPreview(cmd, 200);
            assert.ok(r.truncated);
            assert.ok(r.preview.startsWith('node -e "x"'), r.preview);
            assert.ok(/\+\d+ more lines?/.test(r.preview), r.preview);
        });

        test('a short multi-line command is returned verbatim (no truncation)', () => {
            const cmd = 'echo one\necho two';
            const r = buildTextPreview(cmd, 200);
            assert.strictEqual(r.preview, cmd);
            assert.strictEqual(r.truncated, false);
        });

        test('caps a single very long line at maxChars and reports hidden chars', () => {
            const long = 'a'.repeat(500);
            const r = buildTextPreview(long, 100);
            assert.ok(r.truncated);
            assert.ok(r.preview.startsWith('a'.repeat(100)));
            assert.ok(/\+\d+ chars/.test(r.preview), r.preview);
        });

        test('counts CRLF line endings too', () => {
            const r = buildTextPreview('first\r\nsecond\r\nthird', 5);
            assert.ok(r.truncated);
            assert.ok(/\+\d+ more lines?/.test(r.preview), r.preview);
        });

        test('empty text is not truncated', () => {
            const r = buildTextPreview('');
            assert.strictEqual(r.preview, '');
            assert.strictEqual(r.truncated, false);
        });

        test('handles null/undefined defensively', () => {
            assert.strictEqual(buildTextPreview(null as any).preview, '');
            assert.strictEqual(buildTextPreview(undefined as any).truncated, false);
        });

        test('exactly maxChars is not truncated', () => {
            const s = 'b'.repeat(SUMMARY_PREVIEW_MAX_CHARS);
            const r = buildTextPreview(s, SUMMARY_PREVIEW_MAX_CHARS);
            assert.strictEqual(r.truncated, false);
        });
    });

    suite('truncateConsentArgs', () => {
        test('leaves small string args untouched', () => {
            const r = truncateConsentArgs({ command: 'ls', cwd: '/tmp' });
            assert.deepStrictEqual(r.args, { command: 'ls', cwd: '/tmp' });
            assert.strictEqual(r.truncated, false);
        });

        test('clamps an oversized string arg and marks truncated', () => {
            const big = 'x'.repeat(5000);
            const r = truncateConsentArgs({ command: big }, CONSENT_ARG_MAX_CHARS);
            assert.strictEqual(r.truncated, true);
            assert.ok(r.args.command.length < big.length);
            assert.ok(r.args.command.startsWith('x'.repeat(100)));
            assert.ok(/truncated \d+ chars/.test(r.args.command), r.args.command);
        });

        test('passes non-string values through untouched', () => {
            const r = truncateConsentArgs({ count: 3, flag: true, nested: { a: 1 } });
            assert.strictEqual(r.args.count, 3);
            assert.strictEqual(r.args.flag, true);
            assert.deepStrictEqual(r.args.nested, { a: 1 });
            assert.strictEqual(r.truncated, false);
        });

        test('handles undefined args', () => {
            const r = truncateConsentArgs(undefined);
            assert.deepStrictEqual(r.args, {});
            assert.strictEqual(r.truncated, false);
        });
    });
});

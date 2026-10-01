import * as assert from 'assert';
import {
    isTurnVisible,
    foreignRunningTurn,
    runningElsewhereNotice,
    sessionRunInfo,
} from '../../../shared/sessionRun';

suite('shared/sessionRun', () => {
    suite('isTurnVisible', () => {
        test('true only when the turn belongs to the displayed session', () => {
            assert.strictEqual(isTurnVisible('a', 'a'), true);
        });

        test('false when the user switched to another session', () => {
            assert.strictEqual(isTurnVisible('a', 'b'), false);
        });

        test('false when no turn is running', () => {
            assert.strictEqual(isTurnVisible(undefined, 'a'), false);
            assert.strictEqual(isTurnVisible(null, 'a'), false);
        });

        test('false when no session is displayed', () => {
            assert.strictEqual(isTurnVisible('a', null), false);
            assert.strictEqual(isTurnVisible('a', undefined), false);
        });
    });

    suite('foreignRunningTurn', () => {
        test('null when nothing is running', () => {
            assert.strictEqual(foreignRunningTurn(undefined, 'a'), null);
            assert.strictEqual(foreignRunningTurn(null, 'a'), null);
        });

        test('null when the running turn belongs to the displayed session', () => {
            assert.strictEqual(foreignRunningTurn('a', 'a'), null);
        });

        test('returns the foreign session id when another session runs', () => {
            assert.strictEqual(foreignRunningTurn('a', 'b'), 'a');
        });

        test('returns the session id when a turn runs with no session displayed', () => {
            assert.strictEqual(foreignRunningTurn('a', null), 'a');
        });
    });

    suite('runningElsewhereNotice', () => {
        test('names the session the run belongs to', () => {
            assert.strictEqual(
                runningElsewhereNotice('Refactor the parser'),
                'A response is still being generated in \u201cRefactor the parser\u201d.',
            );
        });

        test('falls back to a generic name when the session is unnamed or blank', () => {
            const expected = 'A response is still being generated in \u201canother session\u201d.';
            assert.strictEqual(runningElsewhereNotice(undefined), expected);
            assert.strictEqual(runningElsewhereNotice(null), expected);
            assert.strictEqual(runningElsewhereNotice('   '), expected);
        });
    });

    suite('sessionRunInfo', () => {
        test('null when nothing is running', () => {
            assert.strictEqual(sessionRunInfo(null, 'a'), null);
            assert.strictEqual(sessionRunInfo(undefined, 'a'), null);
        });

        test('non-background for the session currently on screen', () => {
            const info = sessionRunInfo('a', 'a');
            assert.ok(info, 'expected run info');
            assert.strictEqual(info!.id, 'a');
            assert.strictEqual(info!.background, false);
        });

        test('background when a different session is on screen', () => {
            const info = sessionRunInfo('a', 'b');
            assert.ok(info, 'expected run info');
            assert.strictEqual(info!.id, 'a');
            assert.strictEqual(info!.background, true);
        });

        test('running with no visible session counts as background', () => {
            const info = sessionRunInfo('a', null);
            assert.ok(info, 'expected run info');
            assert.strictEqual(info!.background, true);
        });

        test('title distinguishes foreground from background runs', () => {
            const fg = sessionRunInfo('a', 'a')!;
            const bg = sessionRunInfo('a', 'b')!;
            assert.notStrictEqual(fg.title, bg.title);
            assert.ok(fg.title.length > 0 && bg.title.length > 0);
        });
    });
});

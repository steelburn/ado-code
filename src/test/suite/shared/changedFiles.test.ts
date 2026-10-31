import * as assert from 'assert';

import { ChangedFilesTracker, toolTargetPath } from '../../../remote/changedFiles';
import { MAX_CHANGED_FILES, type RemoteFilesEvent } from '../../../shared/remoteProtocol';

/**
 * The list behind the console's Files tab. It is pure bookkeeping over tool
 * calls, so it is tested without a VS Code host: the phone must be able to
 * answer "what did it touch?" after an hour of edits, and it must not be able
 * to make a tool call fail.
 */
suite('remote/changedFiles', () => {
    function harness(now?: () => number) {
        const frames: RemoteFilesEvent[] = [];
        const tracker = new ChangedFilesTracker((event) => frames.push(event), now);
        return { tracker, frames, last: () => frames[frames.length - 1] };
    }

    suite('toolTargetPath', () => {
        test('reads the target from the argument object', () => {
            assert.strictEqual(toolTargetPath({ path: 'src/a.ts' }), 'src/a.ts');
            assert.strictEqual(toolTargetPath({ filePath: 'src/b.ts' }), 'src/b.ts');
            assert.strictEqual(toolTargetPath({ file: 'src/c.ts' }), 'src/c.ts');
            assert.strictEqual(toolTargetPath({ targetPath: 'src/d.ts' }), 'src/d.ts');
            assert.strictEqual(toolTargetPath({ path: '  src/e.ts  ' }), 'src/e.ts', 'trimmed');
        });

        test('prefers the most specific key', () => {
            assert.strictEqual(
                toolTargetPath({ path: 'src/a.ts', filePath: 'src/b.ts' }),
                'src/a.ts'
            );
        });

        test('accepts a replayed transcript, where arguments are JSON text', () => {
            assert.strictEqual(toolTargetPath('{"path":"src/a.ts"}'), 'src/a.ts');
            assert.strictEqual(toolTargetPath('not json'), null);
            assert.strictEqual(toolTargetPath('"just a string"'), null);
        });

        test('returns null for anything without a usable path', () => {
            assert.strictEqual(toolTargetPath(null), null);
            assert.strictEqual(toolTargetPath(undefined), null);
            assert.strictEqual(toolTargetPath(['src/a.ts']), null);
            assert.strictEqual(toolTargetPath({ path: '' }), null);
            assert.strictEqual(toolTargetPath({ path: 42 }), null);
            assert.strictEqual(toolTargetPath({ content: 'hello' }), null);
        });
    });

    test('a read tool is never a change', () => {
        const { tracker, frames } = harness();
        assert.strictEqual(tracker.start('c1', 'read_file', { path: 'src/a.ts' }), false);
        assert.strictEqual(tracker.start('c2', 'search_files', { path: 'src' }), false);
        assert.strictEqual(tracker.size, 0);
        assert.strictEqual(frames.length, 0, 'nothing is pushed to the phone');
    });

    test('a mutating tool creates one entry and pushes a frame', () => {
        const { tracker, frames, last } = harness(() => 1000);
        assert.strictEqual(tracker.start('c1', 'edit_file', { path: 'src/a.ts' }), true);
        assert.strictEqual(tracker.size, 1);
        assert.strictEqual(frames.length, 1);
        assert.deepStrictEqual(last()!.files, [
            { path: 'src/a.ts', tool: 'edit_file', status: 'running', edits: 1, at: 1000 },
        ]);
    });

    test('a call with no path argument is ignored, not guessed', () => {
        const { tracker, frames } = harness();
        assert.strictEqual(tracker.start('c1', 'edit_file', { content: 'x' }), false);
        assert.strictEqual(tracker.start('c1', 'edit_file', 'not json'), false);
        assert.strictEqual(tracker.size, 0);
        assert.strictEqual(frames.length, 0);
    });

    test('the same call id is never counted twice', () => {
        const { tracker } = harness();
        assert.strictEqual(tracker.start('c1', 'edit_file', { path: 'src/a.ts' }), true);
        assert.strictEqual(tracker.start('c1', 'edit_file', { path: 'src/a.ts' }), false);
        assert.strictEqual(tracker.snapshot().files[0].edits, 1);
    });

    test('repeated edits collapse onto one file and count up', () => {
        const { tracker } = harness();
        tracker.start('c1', 'edit_file', { path: 'src/a.ts' });
        tracker.settle('c1', 'ok');
        tracker.start('c2', 'apply_diff', { path: 'src/a.ts' });
        tracker.settle('c2', 'ok');
        tracker.start('c3', 'write_to_file', { path: 'src/a.ts' });
        const files = tracker.snapshot().files;
        assert.strictEqual(files.length, 1, 'one row per file');
        assert.strictEqual(files[0].edits, 3);
        assert.strictEqual(files[0].tool, 'write_to_file', 'the newest tool names the row');
    });

    test('status is derived from the calls, not assigned', () => {
        const { tracker } = harness();
        const statusOf = (target: string) =>
            tracker.snapshot().files.find((file) => file.path === target)!.status;

        tracker.start('c1', 'edit_file', { path: 'src/a.ts' });
        assert.strictEqual(statusOf('src/a.ts'), 'running', 'in flight');
        tracker.settle('c1', 'ok');
        assert.strictEqual(statusOf('src/a.ts'), 'ok', 'settled clean');

        tracker.start('c2', 'edit_file', { path: 'src/b.ts' });
        tracker.settle('c2', 'error');
        assert.strictEqual(statusOf('src/b.ts'), 'error', 'a failure stays visible');

        // A later success must not paint over it: from a sofa the reader wants
        // to know the file was touched by a call that failed.
        tracker.start('c3', 'edit_file', { path: 'src/b.ts' });
        tracker.settle('c3', 'ok');
        assert.strictEqual(statusOf('src/b.ts'), 'error');
    });

    test('a settle is not a touch', () => {
        const { tracker } = harness();
        tracker.start('c1', 'edit_file', { path: 'src/a.ts' });
        tracker.settle('c1', 'ok');
        assert.strictEqual(tracker.snapshot().files[0].edits, 1);
    });

    test('settling an untracked call is ignored', () => {
        const { tracker, frames } = harness();
        assert.strictEqual(tracker.settle('nope', 'ok'), false);
        assert.strictEqual(frames.length, 0);
    });

    test('the list is capped, and it says so', () => {
        let clock = 0;
        const { tracker } = harness(() => ++clock);
        for (let i = 0; i < MAX_CHANGED_FILES + 5; i++) {
            tracker.start('c' + i, 'edit_file', { path: 'src/f' + i + '.ts' });
            tracker.settle('c' + i, 'ok');
        }
        const event = tracker.snapshot();
        assert.strictEqual(event.files.length, MAX_CHANGED_FILES);
        assert.strictEqual(event.truncated, true, 'the console is told the list is partial');
        assert.ok(
            !event.files.some((file) => file.path === 'src/f0.ts'),
            'the oldest file is the one that goes'
        );
        assert.ok(event.files.some((file) => file.path === 'src/f' + (MAX_CHANGED_FILES + 4) + '.ts'));
    });

    test('the coldest file is evicted, not the oldest', () => {
        let clock = 0;
        const { tracker } = harness(() => ++clock);
        // src/hot.ts is touched first and then again at the end.
        tracker.start('hot-1', 'edit_file', { path: 'src/hot.ts' });
        tracker.settle('hot-1', 'ok');
        for (let i = 0; i < MAX_CHANGED_FILES - 1; i++) {
            tracker.start('c' + i, 'edit_file', { path: 'src/f' + i + '.ts' });
            tracker.settle('c' + i, 'ok');
        }
        tracker.start('hot-2', 'edit_file', { path: 'src/hot.ts' });
        tracker.settle('hot-2', 'ok');
        // One more file tips it over the cap.
        tracker.start('last', 'edit_file', { path: 'src/last.ts' });
        const files = tracker.snapshot().files;
        assert.strictEqual(files.length, MAX_CHANGED_FILES);
        assert.ok(
            files.some((file) => file.path === 'src/hot.ts'),
            'a long run that keeps coming back to one file never loses it'
        );
        assert.ok(!files.some((file) => file.path === 'src/f0.ts'), 'the cold one goes instead');
    });

    test('reset clears the list and tells the phone', () => {
        const { tracker, last } = harness();
        tracker.start('c1', 'edit_file', { path: 'src/a.ts' });
        tracker.reset();
        assert.strictEqual(tracker.size, 0);
        assert.deepStrictEqual(last(), { type: 'files', files: [] });
    });

    test('a dead console cannot fail a tool call', () => {
        const tracker = new ChangedFilesTracker(() => {
            throw new Error('socket closed');
        });
        assert.doesNotThrow(() => tracker.start('c1', 'edit_file', { path: 'src/a.ts' }));
        assert.strictEqual(tracker.size, 1, 'the bookkeeping still happened');
    });
});

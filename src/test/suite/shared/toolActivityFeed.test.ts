import * as assert from 'assert';
import { MAX_TOOL_ACTIVITY } from '../../../shared/remoteProtocol';
import {
  ToolActivityFeed,
  resultLooksLikeError,
  summariseToolArguments,
} from '../../../remote/toolActivityFeed';

suite('remote/toolActivityFeed', () => {
  suite('summariseToolArguments', () => {
    test('names the file a path-shaped tool targets', () => {
      assert.strictEqual(
        summariseToolArguments({ path: 'src/remote/consolePage.ts' }),
        'src/remote/consolePage.ts',
      );
    });

    test('collapses a batch to its first entry plus a count', () => {
      // A batch edit or a `commands` array would otherwise push the rest of the
      // row off a 390px screen.
      assert.strictEqual(
        summariseToolArguments({ commands: ['npm test', 'npm run compile'] }),
        'npm test (+1 more)',
      );
    });

    test('recognises a search regex before falling back to keys', () => {
      assert.strictEqual(summariseToolArguments({ regex: 'toolFeed', path: 'src' }), 'toolFeed');
    });

    test('clips a long digest instead of sending a payload', () => {
      const digest = summariseToolArguments({ command: 'x'.repeat(400) });
      assert.strictEqual(digest.length, 80, 'command digests stop at 80 chars including the ellipsis');
      assert.ok(digest.endsWith('…'));
    });

    test('shows the argument KEYS when nothing is recognisable', () => {
      assert.strictEqual(summariseToolArguments({ alpha: { nested: 1 }, beta: true }), 'alpha, beta');
    });

    test('never throws on junk', () => {
      assert.strictEqual(summariseToolArguments(undefined), '');
      assert.strictEqual(summariseToolArguments(null), '');
      assert.strictEqual(summariseToolArguments('just text'), 'just text');
      assert.strictEqual(summariseToolArguments(42), '42');
      assert.strictEqual(summariseToolArguments({}), '');
    });
  });

  suite('resultLooksLikeError', () => {
    test('reads the JSON error convention', () => {
      assert.strictEqual(resultLooksLikeError('{"error":"ENOENT"}'), true);
      assert.strictEqual(resultLooksLikeError('{ "error": "boom" }'), true);
    });

    test('reads a plain failure line', () => {
      assert.strictEqual(resultLooksLikeError('Error: command failed'), true);
      assert.strictEqual(resultLooksLikeError('failed to apply diff'), true);
    });

    test('does not mistake content for a failure', () => {
      assert.strictEqual(resultLooksLikeError('const errorHandler = 1;'), false);
      assert.strictEqual(resultLooksLikeError({ error: 'shape, not text' }), false);
      assert.strictEqual(resultLooksLikeError(undefined), false);
    });
  });

  suite('ToolActivityFeed', () => {
    function feedAt(clock: { now: number }) {
      const events: any[] = [];
      const feed = new ToolActivityFeed(event => events.push(event), () => clock.now);
      return { feed, events };
    }

    test('announces a running call, then its outcome and duration', () => {
      const clock = { now: 1000 };
      const { feed, events } = feedAt(clock);

      feed.start('c1', 'edit_file', 'src/a.ts');
      let entry = feed.snapshot()[0];
      assert.strictEqual(entry.status, 'running');
      assert.strictEqual(entry.startedAt, 1000);
      assert.strictEqual(entry.durationMs, undefined);

      clock.now = 1450;
      feed.finish('c1');
      entry = feed.snapshot()[0];
      assert.strictEqual(entry.status, 'ok');
      assert.strictEqual(entry.durationMs, 450);

      assert.deepStrictEqual(events.map(event => event.type), ['toolFeed', 'toolFeed']);
      assert.deepStrictEqual(events[1].entries[0].status, 'ok');
    });

    test('a re-announced call upserts instead of duplicating the row', () => {
      // The loop posts the same toolCall twice (details, then completion tick).
      const clock = { now: 5 };
      const { feed } = feedAt(clock);
      feed.start('c1', 'read_file', 'src/b.ts');
      clock.now = 9;
      feed.start('c1', 'read_file', '');

      assert.strictEqual(feed.snapshot().length, 1);
      assert.strictEqual(feed.snapshot()[0].startedAt, 5, 'the call really started at 5');
      assert.strictEqual(feed.snapshot()[0].detail, 'src/b.ts', 'detail is never lost');
    });

    test('a finished call is not dragged back to running', () => {
      const clock = { now: 0 };
      const { feed } = feedAt(clock);
      feed.start('c1', 'edit_file');
      feed.finishWithResult('c1', '{"error":"nope"}');
      feed.start('c1', 'edit_file');
      feed.finishWithResult('c1', 'ok');

      const entry = feed.snapshot()[0];
      assert.strictEqual(entry.status, 'error', 'the first verdict stands');
      clock.now = 1;
      feed.finish('c1');
      assert.strictEqual(feed.snapshot()[0].durationMs, 0);
    });

    test('takes the status from the tool RESULT text', () => {
      const { feed } = feedAt({ now: 0 });
      feed.start('c1', 'run_terminal_command', 'npm test');
      feed.finishWithResult('c1', 'Error: exit code 1');
      assert.strictEqual(feed.snapshot()[0].status, 'error');
    });

    test('drops the oldest call once the feed is full', () => {
      const { feed } = feedAt({ now: 0 });
      for (let i = 0; i < MAX_TOOL_ACTIVITY + 4; i++) {
        feed.start(`c${i}`, 'read_file', `src/${i}.ts`);
      }
      const entries = feed.snapshot();
      assert.strictEqual(entries.length, MAX_TOOL_ACTIVITY);
      assert.strictEqual(entries[0].id, 'c4', 'newest MAX_TOOL_ACTIVITY survive');
      assert.strictEqual(entries[entries.length - 1].id, `c${MAX_TOOL_ACTIVITY + 3}`);
    });

    test('ignores a finish for a call it never saw', () => {
      const { feed } = feedAt({ now: 0 });
      assert.strictEqual(feed.finish('ghost'), null);
      feed.start('c1', 'read_file');
      assert.strictEqual(feed.finish('ghost'), null);
      assert.strictEqual(feed.snapshot()[0].status, 'running');
    });

    test('clear empties the feed so a new session starts clean', () => {
      const clock = { now: 0 };
      const { feed, events } = feedAt(clock);
      feed.start('c1', 'read_file');
      feed.clear();
      assert.deepStrictEqual(feed.snapshot(), []);
      assert.deepStrictEqual(events[events.length - 1].entries, []);
      feed.clear();
      assert.strictEqual(events.length, 2, 'an already-empty feed sends nothing');
    });

    test('a failing sink cannot break the tool call that produced it', () => {
      const feed = new ToolActivityFeed(() => { throw new Error('console gone'); });
      assert.doesNotThrow(() => feed.start('c1', 'edit_file'));
      assert.doesNotThrow(() => feed.finish('c1'));
    });

    test('snapshot hands out copies, not the live rows', () => {
      const { feed } = feedAt({ now: 0 });
      feed.start('c1', 'edit_file', 'a.ts');
      const copy = feed.snapshot();
      copy[0].status = 'error';
      copy[0].detail = 'mutated';
      assert.strictEqual(feed.snapshot()[0].status, 'running');
      assert.strictEqual(feed.snapshot()[0].detail, 'a.ts');
    });
  });
});

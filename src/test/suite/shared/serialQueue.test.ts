import * as assert from 'assert';
import { SerialQueue } from '../../../shared/serialQueue';

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('shared/serialQueue', () => {
  test('runs enqueued tasks strictly one at a time, in FIFO order', async () => {
    const q = new SerialQueue();
    const events: string[] = [];

    const first = q.run(async () => {
      events.push('a:start');
      await tick();
      events.push('a:end');
      return 'a';
    });
    const second = q.run(async () => {
      events.push('b:start');
      events.push('b:end');
      return 'b';
    });

    // The second task must NOT have started while the first is mid-flight —
    // this is the whole point: single-slot user-facing state needs isolation.
    assert.deepStrictEqual(events, ['a:start']);

    assert.strictEqual(await first, 'a');
    assert.strictEqual(await second, 'b');
    assert.deepStrictEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  test('a rejecting task is reported to its caller but does not stall the queue', async () => {
    const q = new SerialQueue();
    const events: string[] = [];

    const boom = q.run(async () => {
      events.push('boom');
      throw new Error('kaboom');
    });
    const ok = q.run(async () => {
      events.push('ok');
      return 42;
    });

    await assert.rejects(boom, /kaboom/);
    assert.strictEqual(await ok, 42);
    assert.deepStrictEqual(events, ['boom', 'ok']);
  });

  test('serializes even when callers fire and forget', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const tasks = [30, 5, 15].map((delay, index) =>
      q.run(async () => {
        order.push(index);
        await tick(delay);
        return index;
      }),
    );
    // Kick off without awaiting so all three are enqueued up front.
    await Promise.all(tasks);
    assert.deepStrictEqual(order, [0, 1, 2], 'later (faster) tasks cannot jump the queue');
  });
});

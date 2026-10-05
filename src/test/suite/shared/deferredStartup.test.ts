import * as assert from 'assert';

import { DeferredStartup } from '../../../shared/deferredStartup';

// Guardrail for the P2 deferred-startup queue.
//
// Activation must only do what the first render needs. Work that costs I/O,
// spawns a process or hits the network (repository-understanding refresh, MCP
// server connect, ...) is queued here and drained *after* `activate()` returns.
//
// The contract that matters for startup correctness:
//   1. queued work does NOT run while registering (it would be back on the
//      critical path — the exact bug P2 fixes),
//   2. work runs in registration order,
//   3. one failing task never blocks the others (a dead MCP server must not
//      stop the understanding refresh),
//   4. draining twice does not re-run finished work.

suite('shared/deferredStartup', () => {
    test('registered work does not run until the queue is drained', () => {
        const startup = new DeferredStartup();
        const ran: string[] = [];

        startup.register('a', () => { ran.push('a'); });

        assert.deepStrictEqual(ran, [], 'nothing may run during registration');
    });

    test('draining runs queued work in registration order', async () => {
        const startup = new DeferredStartup();
        const ran: string[] = [];

        startup.register('first', () => { ran.push('first'); });
        startup.register('second', () => { ran.push('second'); });
        startup.register('third', () => { ran.push('third'); });

        await startup.flush();

        assert.deepStrictEqual(ran, ['first', 'second', 'third']);
    });

    test('a failing task does not prevent the remaining tasks from running', async () => {
        const startup = new DeferredStartup();
        const ran: string[] = [];

        startup.register('ok-1', () => { ran.push('ok-1'); });
        startup.register('boom', () => { throw new Error('task failed'); });
        startup.register('ok-2', () => { ran.push('ok-2'); });

        await startup.flush();

        assert.deepStrictEqual(ran, ['ok-1', 'ok-2'], 'a failed task must be isolated');
    });

    test('a rejected async task is isolated too', async () => {
        const startup = new DeferredStartup();
        const ran: string[] = [];

        startup.register('slow-boom', async () => { throw new Error('async task failed'); });
        startup.register('after', () => { ran.push('after'); });

        await startup.flush();

        assert.deepStrictEqual(ran, ['after']);
    });

    test('draining twice does not re-run finished work', async () => {
        const startup = new DeferredStartup();
        let runs = 0;

        startup.register('once', () => { runs++; });

        await startup.flush();
        await startup.flush();

        assert.strictEqual(runs, 1);
    });

    test('starting an empty queue is a no-op', () => {
        const startup = new DeferredStartup();

        assert.doesNotThrow(() => startup.start());
        assert.doesNotThrow(() => startup.start());
    });

    test('work registered after a flush is still drained', async () => {
        const startup = new DeferredStartup();
        const ran: string[] = [];

        startup.register('early', () => { ran.push('early'); });
        await startup.flush();

        startup.register('late', () => { ran.push('late'); });
        await startup.flush();

        assert.deepStrictEqual(ran, ['early', 'late']);
    });
});

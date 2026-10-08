import * as assert from 'assert';
import { AdoClient } from '../../../ado/client';

// Regression: a stalled ADO request (VPN drop, proxy/DNS blackhole, dead
// socket) must fail fast instead of hanging forever. The project-list refresh
// only recovers because the promise settles — without a timeout it stays
// pending and the header sticks on "Fetching projects…" with no way out.
suite('AdoClient request timeout', () => {
  const realFetch = globalThis.fetch;
  const realTimeout = (AdoClient as any).requestTimeoutMs;

  teardown(() => {
    globalThis.fetch = realFetch;
    (AdoClient as any).requestTimeoutMs = realTimeout;
  });

  test('rejects with a timeout error when the server never responds', async function () {
    this.timeout(4000);
    // Lower the timeout so the test is fast; the knob is a static on purpose.
    (AdoClient as any).requestTimeoutMs = 50;
    // A fetch that never settles — and only rejects if the request is aborted.
    globalThis.fetch = ((_url: any, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err: any = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }
      })) as unknown as typeof fetch;

    const client = new AdoClient('org', 'pat');
    await assert.rejects(() => client.getProjects(), /timed out/i);
  });

  test('passes fast responses straight through', async () => {
    (AdoClient as any).requestTimeoutMs = 50;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ value: [{ id: '1', name: 'P', state: 'wellFormed' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const client = new AdoClient('org', 'pat');
    const projects = await client.getProjects();
    assert.strictEqual(projects.length, 1);
    assert.strictEqual(projects[0].name, 'P');
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { CONSOLE_HTML } from '../../../remote/consolePage';
import { REMOTE_CHAT_ACK_GRACE_MS, settlesWithin } from '../../../shared/remoteProtocol';

// Regression guard: a reply typed on the phone is ACKNOWLEDGED, never waited on.
//
// `POST /chat` used to await the whole agentic turn — minutes on a real task —
// so the request outlived the tunnel edge (Cloudflare answers 524 after ~100 s)
// and the console reported "send failed" for a message the host had already
// received, answered and finished. The host now races the turn against a short
// grace window and answers 202 { accepted, running }; the console only treats a
// send as unconfirmed when nothing comes back at all.
//
// These assertions keep both halves of that contract wired: re-introducing a
// bare `await this.handleUserMessage(...)` or a wait-for-the-turn `fetch` has to
// fail here rather than on a phone.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROVIDER = path.join(REPO_ROOT, 'src', 'webview', 'ChatViewProvider.ts');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** The body of `remoteSendMessage`, up to the next member of the class. */
function remoteSendMessageBody(src: string): string {
  const start = src.indexOf('public async remoteSendMessage(');
  assert.ok(start > 0, 'ChatViewProvider no longer has remoteSendMessage');
  const rest = src.slice(start);
  const end = rest.search(/\n {2}(?:public|private|protected) /);
  return end < 0 ? rest : rest.slice(0, end);
}

suite('Remote chat — POST /chat acknowledges instead of waiting for the turn', () => {
  test('the host races the turn instead of awaiting it', () => {
    const body = remoteSendMessageBody(read(PROVIDER));
    assert.ok(
      !/await this\.handleUserMessage\(/.test(body),
      'remoteSendMessage must not await the turn: that is what made the phone time out',
    );
    assert.ok(
      body.includes('settlesWithin('),
      'the turn must be raced against the acknowledgement window',
    );
    assert.ok(
      /status:\s*202/.test(body),
      'a turn that outlives the window must be answered 202 (accepted, running)',
    );
    assert.ok(
      body.includes('accepted: true'),
      'the 202 body must say the reply was accepted',
    );
  });

  test('a refusal inside the window still reaches the phone', () => {
    const body = remoteSendMessageBody(read(PROVIDER));
    assert.ok(
      /status:\s*409/.test(body),
      'a refused turn must still answer 409 with the reason',
    );
    assert.ok(
      /status:\s*500/.test(body),
      'a turn that throws before the window must still answer 500',
    );
  });

  test('the acknowledgement window stays far below an edge timeout', () => {
    assert.ok(REMOTE_CHAT_ACK_GRACE_MS > 0, 'the window must be positive');
    assert.ok(
      REMOTE_CHAT_ACK_GRACE_MS <= 5000,
      'the window must stay far below the ~100 s a tunnel edge allows',
    );
  });

  test('settlesWithin reports a fast result and gives up on a slow one', async () => {
    const fast = await settlesWithin(Promise.resolve({ status: 409 }), 50);
    assert.deepStrictEqual(fast, { status: 409 }, 'a fast result must come back as-is');

    const slow = await settlesWithin(new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200)), 30);
    assert.strictEqual(slow, null, 'a slow turn must be reported as still running, not awaited');
  });

  test('settlesWithin gives up on a rejection too, and never leaks the timer', async () => {
    const rejected = await settlesWithin(Promise.reject(new Error('boom')), 50);
    assert.strictEqual(rejected, null, 'a rejection must not escape the race as a throw');
    // The rejection above must be handled, not unhandled: reaching here is enough,
    // but assert the timer path as well so the process exits promptly.
    const started = Date.now();
    await settlesWithin(new Promise<void>(() => { /* never settles */ }), 10);
    assert.ok(Date.now() - started < 1000, 'the window must resolve, not hang');
  });

  test('the console bounds the wait and tells "unconfirmed" apart from "refused"', () => {
    assert.ok(
      CONSOLE_HTML.includes('CHAT_CONFIRM_TIMEOUT_MS'),
      'the console must bound how long a send waits for an answer',
    );
    assert.ok(
      CONSOLE_HTML.includes('AbortController'),
      'the bounded wait must abort the request instead of leaving it open',
    );
    assert.ok(
      CONSOLE_HTML.includes('unconfirmed: true'),
      'a send that got no answer must be reported as unconfirmed, not refused',
    );
    assert.ok(
      /payload && payload\.unconfirmed/.test(CONSOLE_HTML),
      'the composer must handle an unconfirmed send without inviting a blind retry',
    );
  });
});

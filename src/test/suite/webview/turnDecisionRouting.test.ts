import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { ChatViewProvider } from '../../../webview/ChatViewProvider';

/**
 * A turn belongs to the session it was started from — INCLUDING its decisions.
 *
 * Switching to an older chat while a turn is running detaches the turn: its
 * streamed output is dropped from the webview (the session buffer keeps it) and
 * its console view lives in another window. A decision card is different — it
 * has to be answerable — so it is stamped with the session that asked it and
 * re-posted when the user returns. Before this, the card was filed under
 * whatever session happened to be on screen, and answering it there made that
 * older session the tracked run.
 */

function makeProvider(saved: Record<string, any> = {}) {
  const provider = new ChatViewProvider(
    { fsPath: '/tmp/x' } as any,
    { todos: { setActiveSession() {}, rename() {}, setGoal() {} } } as any,
    {
      workspaceState: {
        get: (k: string, defaultVal?: any) => saved[k] ?? defaultVal,
        update: async (k: string, v: any) => {
          if (v === undefined) delete saved[k];
          else saved[k] = v;
        },
        keys: () => Object.keys(saved),
      },
    } as any
  );
  const posts: any[] = [];
  (provider as any).postMessage = (m: any) => posts.push(m);
  return { provider, posts };
}

function readWebviewSource(): string {
  const candidates = [
    path.join(__dirname, '../../../../../src/webview-ui/src/App.tsx'),
    path.join(__dirname, '../../../../src/webview-ui/src/App.tsx'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw new Error('App.tsx not found from ' + __dirname);
}

suite('Turn decisions stay in the session that owns the run', () => {
  test('a failure raised by a detached turn is stamped and queued for its own session', () => {
    const { provider, posts } = makeProvider();
    (provider as any).getActiveSessionId = () => 'session-on-screen';

    (provider as any).postTurnError('session-running', 'stream died');

    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(
      { type: posts[0].type, message: posts[0].message, sessionId: posts[0].sessionId },
      { type: 'error', message: 'stream died', sessionId: 'session-running' },
      'the failure must carry the session that owns the turn'
    );
    const queued = (provider as any).pendingTurnNotices.get('session-running');
    assert.strictEqual(queued?.length, 1, 'it is also queued for the return trip');
  });

  test('the footer of a visible turn is not queued twice', () => {
    const { provider, posts } = makeProvider();
    (provider as any).getActiveSessionId = () => 'session-running';

    (provider as any).postTurnError('session-running', 'boom');

    assert.strictEqual(posts.length, 1);
    assert.strictEqual((provider as any).pendingTurnNotices.size, 0);
  });

  test('replaying reaches only the session that owns the frame', () => {
    const { provider, posts } = makeProvider();
    (provider as any).getActiveSessionId = () => 'session-on-screen';
    (provider as any).postTurnError('session-running', 'stream died');

    posts.length = 0;
    (provider as any).replayPendingTurnFrames('session-other');
    assert.strictEqual(posts.length, 0, 'a foreign session must not inherit the failure');

    (provider as any).replayPendingTurnFrames('session-running');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].sessionId, 'session-running');
    assert.strictEqual(
      (provider as any).pendingTurnNotices.size,
      0,
      'the notice is delivered once, then forgotten'
    );
  });

  test('the pending choice card is re-posted to the session that asked', () => {
    const { provider, posts } = makeProvider();
    const frame = { type: 'choicePrompt', requestId: 'choice-1', question: 'Ship it?', options: [], sessionId: 'session-running' };
    (provider as any).pendingChoiceRequestId = 'choice-1';
    (provider as any).pendingChoiceSessionId = 'session-running';
    (provider as any).pendingChoiceFrame = frame;

    (provider as any).replayPendingTurnFrames('session-other');
    assert.ok(
      !posts.some(p => p.type === 'choicePrompt'),
      'the card must not follow the user into another session'
    );

    (provider as any).replayPendingTurnFrames('session-running');
    assert.deepStrictEqual(posts.filter(p => p.type === 'choicePrompt'), [frame]);
  });

  test('answering the card clears its owning session as well as its id', () => {
    const { provider } = makeProvider();
    (provider as any).pendingChoiceRequestId = 'choice-1';
    (provider as any).pendingChoiceSessionId = 'session-running';
    (provider as any).pendingChoiceFrame = { type: 'choicePrompt', sessionId: 'session-running' };

    provider.resolveChoiceCard('choice-1', 'yes', 'host');

    assert.strictEqual((provider as any).pendingChoiceRequestId, null);
    assert.strictEqual((provider as any).pendingChoiceSessionId, null);
    assert.strictEqual((provider as any).pendingChoiceFrame, null);
  });

  test('the webview files a decision card under the session that asked', () => {
    const src = readWebviewSource();
    const choice = /case 'choicePrompt':([\s\S]{0,700}?)\n          const curKey = ([^;]+);/.exec(src);
    assert.ok(choice, 'the choicePrompt case still exists');
    assert.match(
      choice![2],
      /msg\.sessionId/,
      'the card is keyed by the asking session, not activeSessionIdRef'
    );

    const confirmation = /case 'confirmationRequest':([\s\S]{0,500}?)\n          const curKey = ([^;]+);/.exec(src);
    assert.ok(confirmation, 'the confirmationRequest case still exists');
    assert.match(confirmation![2], /msg\.sessionId/, 'confirmation cards follow the same rule');

    const errorCase = /case 'error': \{([\s\S]{0,700}?)\n          setError\(msg\.message\);/.exec(src);
    assert.ok(errorCase, 'the error case still exists');
    assert.match(
      errorCase![1],
      /msg\.sessionId && msg\.sessionId !== \(activeSessionIdRef\.current \|\| 'default'\)/,
      "another session's failure must not be shown in this thread"
    );
  });
});

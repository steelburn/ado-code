import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { CONSOLE_HTML } from '../../../remote/consolePage';
import { parseDownstream } from '../../../shared/remoteProtocol';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';
import { TranscriptMirror } from '../../../webview/TranscriptMirror';

/**
 * Two-way answer sync between the VS Code chat and the remote console.
 *
 * Three regressions are pinned here, all of them "the answer landed on one
 * surface and the other kept showing a live card":
 *
 *  1. a choice answered on the phone must close the desktop card;
 *  2. a choice answered in VS Code must close the phone's option block;
 *  3. a consent request ("Allow terminal command") answered on the phone must
 *     remove the desktop card too — it used to post `promptExpired` with
 *     `action: 'cancel'`, which the webview only applied to the confirmation
 *     map, leaving the consent card on screen forever.
 *
 * The wire contract is `choiceResolved` (downstream) plus `choiceAnswered` /
 * `approvalResolved` (host → webview).
 */

function makeSessionContext(): any {
  const data = new Map<string, any>();
  return {
    workspaceState: {
      get: (key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        data.set(key, value);
      },
      keys: () => [...data.keys()],
    },
  };
}

/** Same minimal bundle chatViewProvider.test.ts uses: a no-op to-do store. */
function makeServices(): any {
  return {
    todos: {
      setActiveSession() {
        /* noop */
      },
      rename() {
        /* noop */
      },
      removeSession() {
        /* noop */
      },
      removeAll() {
        /* noop */
      },
      setGoal() {
        /* noop */
      },
    },
  };
}

interface Posted {
  type?: string;
  requestId?: string;
  answer?: string;
  source?: string;
  outcome?: string;
  [key: string]: unknown;
}

function makeProvider(): { provider: ChatViewProvider; posted: Posted[] } {
  const provider = new ChatViewProvider({} as any, makeServices(), makeSessionContext());
  const posted: Posted[] = [];
  (provider as any)._view = { webview: { postMessage: (message: Posted) => posted.push(message) } };
  return { provider, posted };
}

function readSource(relative: string): string {
  // The suites run from `out/test/suite/shared`, so the repo root is four up.
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', relative), 'utf8');
}

suite('shared/remoteChoiceSync — the wire carries "this card is answered"', () => {
  test('a choiceResolved frame round-trips through parseDownstream', () => {
    const frame = JSON.stringify({
      type: 'choiceResolved',
      requestId: 'choice-1',
      messageId: 'msg-1',
      answer: 'Deploy it',
      source: 'host',
    });
    const parsed = parseDownstream(frame);
    assert.strictEqual(parsed.ok, true, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) {
      return;
    }
    const event = parsed.value as Extract<typeof parsed.value, { type: 'choiceResolved' }>;
    assert.strictEqual(event.requestId, 'choice-1');
    assert.strictEqual(event.messageId, 'msg-1');
    assert.strictEqual(event.answer, 'Deploy it');
    assert.strictEqual(event.source, 'host');
  });

  test('a choiceResolved frame without an answer or a known source is rejected', () => {
    for (const bad of [
      { type: 'choiceResolved', requestId: 'c1', source: 'host' },
      { type: 'choiceResolved', requestId: 'c1', answer: 'x' },
      { type: 'choiceResolved', requestId: '', answer: 'x', source: 'host' },
      { type: 'choiceResolved', requestId: 'c1', answer: 'x', source: 'elsewhere' },
    ]) {
      const parsed = parseDownstream(JSON.stringify(bad));
      assert.strictEqual(parsed.ok, false, `expected a rejection for ${JSON.stringify(bad)}`);
    }
  });

  test('the upstream /chat call carries the choice it answers', () => {
    const protocol = readSource(path.join('src', 'remote', 'RemoteServer.ts'));
    assert.match(
      protocol,
      /onChat\?: \(text: string, choiceRequestId\?: string\)/,
      'RemoteServer.onChat must accept the answered choice id',
    );
    assert.match(protocol, /onChat\(text, choiceRequestId\)/, 'handleChat must forward it');
  });
});

suite('shared/remoteChoiceSync — TranscriptMirror closes the answered block', () => {
  function make(): { mirror: TranscriptMirror; events: any[] } {
    const events: any[] = [];
    const mirror = new TranscriptMirror((event: any) => events.push(event), () => 'session-1');
    return { mirror, events };
  }

  test('resolveChoice marks the block answered, re-publishes and announces it', () => {
    const { mirror, events } = make();
    mirror.noteAssistant(undefined, 'Which branch?', true);
    mirror.noteChoice('Which branch?', ['main', 'release'], 'choice-7');
    events.length = 0;

    mirror.resolveChoice('choice-7', 'release', 'remote');

    const resolved = events.filter(event => event.type === 'choiceResolved');
    assert.strictEqual(resolved.length, 1, 'exactly one choiceResolved event');
    assert.strictEqual(resolved[0].requestId, 'choice-7');
    assert.strictEqual(resolved[0].answer, 'release');
    assert.strictEqual(resolved[0].source, 'remote');

    const republished = events.filter(event => event.type === 'transcriptMessage');
    assert.ok(republished.length >= 1, 'the phone needs the closed block re-sent');
    const closed = republished[republished.length - 1].message;
    assert.strictEqual(closed.choice?.answered, true);
    assert.strictEqual(closed.choice?.answer, 'release');
    assert.strictEqual(mirror.snapshot().messages[0].choice?.answered, true);
  });

  test('resolving twice announces the closure once', () => {
    const { mirror, events } = make();
    mirror.noteAssistant(undefined, 'Pick', true);
    mirror.noteChoice('Pick', ['a', 'b'], 'choice-8');
    events.length = 0;

    mirror.resolveChoice('choice-8', 'a', 'host');
    mirror.resolveChoice('choice-8', 'b', 'remote');

    assert.strictEqual(events.filter(event => event.type === 'choiceResolved').length, 1);
    assert.strictEqual(mirror.snapshot().messages[0].choice?.answer, 'a', 'the first answer wins');
  });

  test('an unknown requestId resolves nothing', () => {
    const { mirror, events } = make();
    mirror.noteAssistant(undefined, 'Pick', true);
    mirror.noteChoice('Pick', ['a'], 'choice-9');
    events.length = 0;

    mirror.resolveChoice('nope', 'a', 'host');

    assert.strictEqual(events.length, 0, 'no event may be invented for an unknown card');
  });
});

suite('shared/remoteChoiceSync — answering on the phone closes the desktop card', () => {
  test("resolveChoiceCard('remote') posts choiceAnswered and clears the pending id", () => {
    const { provider, posted } = makeProvider();
    (provider as any).pendingChoiceRequestId = 'choice-1';

    (provider as any).resolveChoiceCard(undefined, 'Deploy it', 'remote');

    const answered = posted.filter(message => message.type === 'choiceAnswered');
    assert.strictEqual(answered.length, 1);
    assert.strictEqual(answered[0].requestId, 'choice-1');
    assert.strictEqual(answered[0].answer, 'Deploy it');
    assert.strictEqual(answered[0].source, 'remote');
    assert.strictEqual((provider as any).pendingChoiceRequestId, null);
  });

  test("resolveChoiceCard('host') never echoes back to the webview", () => {
    const { provider, posted } = makeProvider();
    (provider as any).pendingChoiceRequestId = 'choice-2';

    (provider as any).resolveChoiceCard('choice-2', 'main', 'host');

    assert.strictEqual(
      posted.filter(message => message.type === 'choiceAnswered').length,
      0,
      'the desktop answered it, so its card is already gone',
    );
  });

  test('a refused phone answer leaves the card open on both surfaces', async () => {
    const { provider, posted } = makeProvider();
    (provider as any).pendingChoiceRequestId = 'choice-3';
    (provider as any).getActiveSessionId = () => 'session-1';
    // A turn is already running in ANOTHER session: the host refuses the
    // message, so the answer never landed and the choice must stay answerable
    // on both surfaces.
    (provider as any).runningTurnSession = 'session-other';
    let reachedTurn = false;
    (provider as any).handleUserMessage = async () => {
      reachedTurn = true;
      return { ok: true };
    };

    const result = await provider.remoteSendMessage('Deploy it', 'choice-3');

    assert.strictEqual(result.status, 409, 'the host refused the message');
    assert.strictEqual(reachedTurn, false, 'the refused message never starts a turn');
    assert.strictEqual(
      posted.filter(message => message.type === 'choiceAnswered').length,
      0,
      'a refused answer must not close the desktop card',
    );
    assert.strictEqual((provider as any).pendingChoiceRequestId, 'choice-3');
  });

  test('an accepted phone answer closes the named card', async () => {
    const { provider, posted } = makeProvider();
    (provider as any).pendingChoiceRequestId = 'choice-new';
    (provider as any).handleUserMessage = async () => ({ ok: true });

    const result = await provider.remoteSendMessage('Deploy it', 'choice-old');

    assert.strictEqual(result.status, 200);
    const answered = posted.filter(message => message.type === 'choiceAnswered');
    assert.strictEqual(answered.length, 1);
    assert.strictEqual(
      answered[0].requestId,
      'choice-old',
      'the id the console sent wins over the latest pending prompt',
    );
    assert.strictEqual(answered[0].answer, 'Deploy it', 'the text IS the answer');
    assert.strictEqual(answered[0].source, 'remote', 'the desktop must hear it');
  });

  test('the desktop card closes BEFORE the turn runs, not after it', async () => {
    const { provider, posted } = makeProvider();
    (provider as any).pendingChoiceRequestId = 'choice-1';
    // A turn streams for a long time. The desktop must not sit on a question the
    // phone already answered for all of it — so the card is closed on ACCEPTANCE.
    let answeredBeforeTurn = -1;
    (provider as any).handleUserMessage = async () => {
      answeredBeforeTurn = posted.filter(message => message.type === 'choiceAnswered').length;
      return { ok: true };
    };

    await provider.remoteSendMessage('Deploy it', 'choice-1');

    assert.strictEqual(answeredBeforeTurn, 1, 'the card was closed before the turn started');
    assert.strictEqual((provider as any).pendingChoiceRequestId, null, 'and the pending id is spent');
  });

  test('the desktop card follows the CONSOLE\'s id even when the pending one has moved', async () => {
    const { provider, posted } = makeProvider();
    // The mirrored block was answered by a console that still remembers an older
    // prompt: the id it sends wins, so the block it closed on screen is the one
    // that closes here too.
    (provider as any).pendingChoiceRequestId = 'choice-new';
    (provider as any).handleUserMessage = async () => ({ ok: true });

    await provider.remoteSendMessage('Deploy it', 'choice-old');

    assert.strictEqual(
      (provider as any).pendingChoiceRequestId,
      'choice-new',
      'the newer prompt is untouched — it is still answerable',
    );
    const answered = posted.filter(message => message.type === 'choiceAnswered');
    assert.deepStrictEqual(answered.map((m: any) => m.requestId), ['choice-old']);
  });
});

suite('shared/remoteChoiceSync — a remote consent answer clears the desktop card', () => {
  test('handleRemoteConsent posts approvalResolved, not promptExpired', async () => {
    const { provider, posted } = makeProvider();
    const decision = provider.requestConsent('run_terminal_command', { command: 'npm test' });
    const card = posted.find(message => message.type === 'consentRequest');
    assert.ok(card, 'the consent card was posted');
    posted.length = 0;

    const reply = await provider.handleRemoteConsent({
      requestId: String(card!.requestId),
      approved: true,
    });

    assert.strictEqual(reply.status, 200);
    const resolved = posted.filter(message => message.type === 'approvalResolved');
    assert.strictEqual(resolved.length, 1, 'the desktop needs an explicit resolution');
    assert.strictEqual(resolved[0].requestId, card!.requestId);
    assert.strictEqual(resolved[0].outcome, 'approved');
    assert.strictEqual(resolved[0].source, 'remote');
    assert.strictEqual(
      posted.filter(message => message.type === 'promptExpired').length,
      0,
      'promptExpired only cleared the confirmation map and left the card behind',
    );
    assert.strictEqual(await decision, true, 'the tool call proceeds');
  });

  test('handleRemoteConfirmation posts approvalResolved with the picked value', async () => {
    const { provider, posted } = makeProvider();
    const decision = provider.requestConfirmation('Overwrite the file?', 'The file exists.', [
      { label: 'Yes', value: 'Yes' },
      { label: 'No', value: 'No' },
    ]);
    const card = posted.find(message => message.type === 'confirmationRequest');
    assert.ok(card, 'the confirmation card was posted');
    posted.length = 0;

    const reply = await provider.handleRemoteConfirmation({
      requestId: String(card!.requestId),
      value: 'Yes',
    });

    assert.strictEqual(reply.status, 200);
    const resolved = posted.filter(message => message.type === 'approvalResolved');
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].requestId, card!.requestId);
    assert.strictEqual(resolved[0].outcome, 'approved');
    assert.strictEqual(resolved[0].answer, 'Yes');
    assert.strictEqual(await decision, 'Yes');
  });
});

suite('shared/remoteChoiceSync — the browser halves agree on the contract', () => {
  test('the console page handles choiceResolved and closes every option', () => {
    assert.match(CONSOLE_HTML, /case 'choiceResolved'/, 'the console must listen for it');
    assert.match(CONSOLE_HTML, /function markChoiceAnswered\(/, 'and mark the block answered');
    assert.match(
      CONSOLE_HTML,
      /choiceRequestId: choiceRequestId/,
      'a tap names the card it answers',
    );
    assert.match(
      CONSOLE_HTML,
      /esc\(message\.id\) \+ '"' \+ esc\(disabled\) \+ '>'/,
      'the choice button disables through esc(), like every other attribute',
    );
    assert.match(
      CONSOLE_HTML,
      /var closed = picked !== undefined;/,
      'an unanswered block stays live: closed is derived from a defined answer',
    );
  });

  test('the webview names the answered card and closes on any resolution', () => {
    const app = readSource(path.join('src', 'webview-ui', 'src', 'App.tsx'));
    assert.match(
      app,
      /choiceRequestId: requestId/,
      'a desktop choice click must name its card so the phone closes too',
    );
    for (const frame of ['promptExpired', 'approvalResolved', 'choiceAnswered']) {
      assert.match(app, new RegExp(`case '${frame}'`), `${frame} must be handled`);
    }
  });
});

suite('shared/remoteChoiceSync — an answered question stays answered', () => {
  function make(): { mirror: TranscriptMirror; events: any[] } {
    const events: any[] = [];
    const mirror = new TranscriptMirror((event: any) => events.push(event), () => 'session-1');
    return { mirror, events };
  }

  function lastChoice(events: any[]): any {
    const published = events.filter(event => event.type === 'transcriptMessage');
    assert.ok(published.length > 0, 'the block must be re-published');
    return published[published.length - 1].message.choice;
  }

  test('a second noteChoice for the same requestId comes back closed', () => {
    const { mirror, events } = make();
    mirror.noteAssistant(undefined, 'Which branch?', true);
    mirror.noteChoice('Which branch?', ['main', 'release'], 'choice-1');
    mirror.resolveChoice('choice-1', 'release', 'remote');
    events.length = 0;

    // The desktop re-posts the same card (a retry, a re-render, a replayed turn).
    mirror.noteChoice('Which branch?', ['main', 'release'], 'choice-1');

    const choice = lastChoice(events);
    assert.strictEqual(choice.answered, true, 'a re-posted card must stay closed');
    assert.strictEqual(choice.answer, 'release');
    assert.strictEqual(choice.requestId, 'choice-1');
  });

  test('a re-rendered choice fence does not resurrect the options', () => {
    const { mirror, events } = make();
    const text = 'Pick one:\n\n```choice\n{"question":"Which?","options":["a","b"]}\n```';
    mirror.noteAssistant('card-1', text, true);
    mirror.noteChoice('Which?', ['a', 'b'], 'choice-2');
    mirror.resolveChoice('choice-2', 'b', 'host');
    events.length = 0;

    // The same prompt on a fresh card: the fence is parsed again from the text,
    // so this block has no requestId of its own — only the answer registry can
    // tell the phone that it was already answered.
    mirror.noteAssistant('card-2', text, true);

    const choice = lastChoice(events);
    assert.strictEqual(choice.question, 'Which?');
    assert.strictEqual(choice.answered, true, 'the remembered answer closes the block');
    assert.strictEqual(choice.answer, 'b');
  });

  test('a NEW prompt on the same card is still live', () => {
    const { mirror, events } = make();
    mirror.noteAssistant(undefined, 'Which?', true);
    mirror.noteChoice('Which?', ['a', 'b'], 'choice-4');
    mirror.resolveChoice('choice-4', 'a', 'remote');
    events.length = 0;

    // A different requestId is a DIFFERENT question: only the answered one is
    // closed, or a repeated question could never be answered at all.
    mirror.noteChoice('Which?', ['a', 'b'], 'choice-5');

    const choice = lastChoice(events);
    assert.strictEqual(choice.requestId, 'choice-5');
    assert.strictEqual(choice.answered, undefined, 'a new prompt must offer its options');
  });

  test('history restore keeps a remembered answer closed', () => {
    const { mirror, events } = make();
    const text = 'Pick one:\n\n```choice\n{"question":"Which?","options":["a","b"]}\n```';
    mirror.noteAssistant(undefined, text, true);
    mirror.noteChoice('Which?', ['a', 'b'], 'choice-6');
    mirror.resolveChoice('choice-6', 'a', 'remote');

    // A webview reload restores the thread from stored text alone.
    mirror.reset([{ role: 'assistant', content: text }]);

    const restored = mirror.snapshot().messages.filter(message => message.choice);
    assert.strictEqual(restored.length, 1, 'the restored prompt must still be shown');
    assert.strictEqual(restored[0].choice?.answered, true, 'restored prompts stay closed');
    assert.strictEqual(restored[0].choice?.answer, 'a');
    assert.ok(events.length > 0);
  });

  test('a session switch drops the remembered answers', () => {
    let session = 'session-1';
    const events: any[] = [];
    const mirror = new TranscriptMirror((event: any) => events.push(event), () => session);
    const text = 'Pick one:\n\n```choice\n{"question":"Which?","options":["a","b"]}\n```';
    mirror.noteAssistant(undefined, text, true);
    mirror.noteChoice('Which?', ['a', 'b'], 'choice-7');
    mirror.resolveChoice('choice-7', 'a', 'remote');

    // Another work item / chat session restores ITS history: the same question
    // there was never answered, so its options must be offered again.
    session = 'session-2';
    mirror.reset([{ role: 'assistant', content: text }]);

    const restored = mirror.snapshot().messages.filter(message => message.choice);
    assert.strictEqual(restored.length, 1);
    assert.strictEqual(restored[0].choice?.answered, undefined, 'a new session asks afresh');
  });

  test('the console remembers an answer the host reports', () => {
    assert.match(
      CONSOLE_HTML,
      /state\.answered\[existing\.id\]/,
      'a frame that reports the answer must be remembered, not just re-rendered',
    );
  });
});

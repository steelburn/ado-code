import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard: a message typed on the REMOTE console must show up in the
// desktop chat, not just in the answer that follows it.
//
// The webview renders its user bubble optimistically when the desktop sends, so
// a phone-typed turn had no bubble at all: the host ran the turn and streamed
// the answer, and the desktop showed a reply with no question above it. The
// host now posts a `remoteUserMessage` frame (ChatViewProvider) that the
// webview appends (App.tsx). These assertions keep the two halves wired: drop
// either one and the echo silently disappears again.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP = path.join(REPO_ROOT, 'src', 'webview-ui', 'src', 'App.tsx');
const PROVIDER = path.join(REPO_ROOT, 'src', 'webview', 'ChatViewProvider.ts');
const MESSAGES = path.join(REPO_ROOT, 'src', 'shared', 'messages.ts');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** The `case '<type>': { ... }` arm of the webview's message switch. */
function caseBlock(src: string, type: string): string | null {
  const start = src.indexOf(`case '${type}'`);
  if (start < 0) return null;
  // The arm ends where the next `case '` begins, or at the closing switch.
  const rest = src.slice(start + 1);
  const next = rest.search(/\n\s*case '/);
  return next < 0 ? rest : rest.slice(0, next);
}

suite('Remote input — phone turn echoes into the desktop chat', () => {
  test('the host posts a remoteUserMessage frame for a phone-typed turn', () => {
    const provider = read(PROVIDER);
    assert.ok(
      provider.includes("type: 'remoteUserMessage'"),
      'ChatViewProvider no longer posts the remote user-turn frame',
    );
    // It must be the REMOTE path that posts it: a local send already rendered
    // its own bubble, so echoing there would double every desktop message.
    const remoteSend = provider.slice(provider.indexOf('public async remoteSendMessage'));
    assert.ok(
      remoteSend.includes('handleUserMessage'),
      'remoteSendMessage no longer funnels through handleUserMessage',
    );
    assert.ok(
      remoteSend.includes("'remote'"),
      "remoteSendMessage must pass origin 'remote'",
    );
  });

  test('the webview appends the echoed turn as a user bubble', () => {
    const app = read(APP);
    const arm = caseBlock(app, 'remoteUserMessage');
    assert.ok(arm, "App.tsx has no `case 'remoteUserMessage'` — the phone turn never renders");
    assert.ok(
      /setMessages\(\s*prev\s*=>\s*\[\.\.\.prev/.test(arm!),
      'the remote turn is not appended to the message list',
    );
    assert.ok(
      arm!.includes("role: 'user'"),
      'the echoed turn is not rendered as a user message',
    );
    assert.ok(
      /setLoading\(\s*true\s*\)/.test(arm!),
      'the desktop must show its spinner while the remote turn runs',
    );
  });

  test('the frame is part of the extension → webview contract', () => {
    const messages = read(MESSAGES);
    const unionStart = messages.indexOf('export type ExtensionToWebviewMessage');
    assert.ok(unionStart > 0, 'ExtensionToWebviewMessage union not found');
    const union = messages.slice(unionStart, messages.indexOf('export type', unionStart + 10));
    assert.ok(
      union.includes("type: 'remoteUserMessage'"),
      'remoteUserMessage is missing from ExtensionToWebviewMessage',
    );
    assert.ok(
      /remoteUserMessage[^|]*content:\s*string/.test(union),
      'the frame must carry the typed content',
    );
  });
});

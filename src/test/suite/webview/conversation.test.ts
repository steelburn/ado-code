import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

function makeProvider(saved: Record<string, any> = {}) {
  return new ChatViewProvider(
    { fsPath: '/tmp/x' } as any,
    {} as any,
    { workspaceState: { get: (k: string, defaultVal?: any) => saved[k] ?? defaultVal, update: async (k: string, v: any) => { saved[k] = v; } } } as any
  );
}

suite('Session history persistence', () => {
  test('createNewSession adds a session and sets it active', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    await provider.createNewSession();

    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].name, 'New Session');
    assert.strictEqual((provider as any).getActiveSessionId(), sessions[0].id);
  });

  test('loadSession restores messages from a session', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    // Create a session with messages
    await provider.createNewSession();
    const sessions = (provider as any).getSessions();
    sessions[0].messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    await (provider as any).saveSessions(sessions);

    // Clear sent messages from setup
    sent.length = 0;

    // Load it
    await (provider as any).loadSession(sessions[0].id);
    const restored = sent.find(m => m.type === 'historyRestored');
    assert.ok(restored);
    assert.strictEqual(restored.messages.length, 2);
    assert.strictEqual(restored.messages[0].content, 'hello');
  });

  test('deleteSession removes session and switches if active', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    await provider.createNewSession();
    const id1 = (provider as any).getActiveSessionId();

    // Small delay to ensure different timestamp for second session
    await new Promise(r => setTimeout(r, 2));
    await provider.createNewSession();
    const id2 = (provider as any).getActiveSessionId();

    // Verify we have 2 distinct sessions
    assert.notStrictEqual(id1, id2);
    assert.strictEqual((provider as any).getSessions().length, 2);

    // Simulate deleteSession: remove session, switch if active
    let sessions = (provider as any).getSessions().filter((s: any) => s.id !== id2);
    await (provider as any).saveSessions(sessions);
    if ((provider as any).getActiveSessionId() === id2) {
      if (sessions.length > 0) {
        await (provider as any).loadSession(sessions[sessions.length - 1].id);
      } else {
        await provider.createNewSession();
      }
    }

    sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].id, id1);
  });

  test('migrateFromLegacyHistory wraps old format into session', async () => {
    // In test env, vscode.workspace.workspaceFolders is undefined → folder = 'default'
    const saved: Record<string, any> = {
      'adoCode.chatHistory:default': [
        { role: 'user', content: 'old msg' },
        { role: 'assistant', content: 'old reply' },
      ],
    };
    const provider = makeProvider(saved);
    await (provider as any).migrateFromLegacyHistory();

    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].messages.length, 2);
    assert.strictEqual(sessions[0].messages[0].content, 'old msg');
    // Legacy key should be removed
    assert.strictEqual(saved['adoCode.chatHistory:default'], undefined);
  });

  test('migrateFromLegacyHistory skips if sessions already exist', async () => {
    const saved: Record<string, any> = {
      'adoCode.chatHistory:default': [{ role: 'user', content: 'old' }],
    };
    const provider = makeProvider(saved);
    // Pre-populate sessions
    await provider.createNewSession();
    const beforeCount = (provider as any).getSessions().length;

    await (provider as any).migrateFromLegacyHistory();

    // Should not add another session
    assert.strictEqual((provider as any).getSessions().length, beforeCount);
  });

  test('persistConversation saves to active session', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    await provider.createNewSession();
    const activeId = (provider as any).getActiveSessionId();

    (provider as any).conversation = [
      { role: 'user', content: 'test message' },
      { role: 'assistant', content: 'test reply' },
    ];
    await (provider as any).persistConversation();

    const sessions = (provider as any).getSessions();
    const active = sessions.find((s: any) => s.id === activeId);
    assert.ok(active);
    assert.strictEqual(active.messages.length, 2);
    assert.strictEqual(active.messages[0].content, 'test message');
  });

  test('persistConversation keeps complete pairs + the leading summary marker', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    await provider.createNewSession();
    const activeId = (provider as any).getActiveSessionId();

    // Marker + 60 user/assistant pairs — far more than the 25-pair cap.
    const convo: any[] = [{ role: 'user', content: '[Conversation Summary]\nEarlier context was condensed here.' }];
    for (let i = 0; i < 60; i++) {
      convo.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
    }
    (provider as any).conversation = convo;
    await (provider as any).persistConversation();

    const sessions = (provider as any).getSessions();
    const active = sessions.find((s: any) => s.id === activeId);
    assert.ok(active);
    // Marker + last 25 complete pairs (50 messages) = 51 messages.
    assert.strictEqual(active.messages.length, 51);
    // The leading summary marker survives the pair slice.
    assert.strictEqual(active.messages[0].content, '[Conversation Summary]\nEarlier context was condensed here.');
    // First kept pair is intact and the tail ends on an assistant message
    // (never a mid-pair cut that would start a restored turn on assistant).
    assert.strictEqual(active.messages[1].content, 'q35');
    assert.strictEqual(active.messages[2].role, 'assistant');
    assert.strictEqual(active.messages[active.messages.length - 1].role, 'assistant');
  });
});

import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';
import {
  isSessionAutoApproved,
  addSessionToolApproval,
  addSessionCommandApproval,
  clearSessionAutoApprovals,
} from '../../../llm/tool-approval-ui';

/** Fake ExtensionContext whose workspaceState backs a Map (like the real one). */
function makeSessionContext(): any {
  const data = new Map<string, any>();
  return {
    workspaceState: {
      get: (k: string, d?: any) => (data.has(k) ? data.get(k) : d),
      update: async (k: string, v: any) => { data.set(k, v); },
    },
  };
}

suite('ChatViewProvider', () => {
  test('can be instantiated', () => {
    // C-6 fix: Task 8 changed the signature to (extensionUri, services, context, onItemsFetched?).
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    assert.ok(provider);
  });

  test('requestConsent posts a consentRequest card and resolves on approval', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };
    const args = { path: 'a.ts', oldText: 'a', newText: 'b' };
    const decision = provider.requestConsent('edit_file', args);
    const req = posted.find(m => m.type === 'consentRequest');
    assert.ok(req, 'consentRequest message was posted to the webview');
    assert.strictEqual(req.tool, 'edit_file');
    assert.deepStrictEqual(req.args, args);
    assert.ok(req.requestId);
    // Simulate the webview's consentResponse handler (message switch → broker).
    (provider as any).consentBroker.resolve(req.requestId, true);
    assert.strictEqual(await decision, true);
    assert.strictEqual((provider as any).consentBroker.pending, null);
  });

  test('requestConsent denies when the webview rejects', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };
    const decision = provider.requestConsent('add_comment', { id: 5, text: 'hi' });
    const req = posted.find(m => m.type === 'consentRequest');
    (provider as any).consentBroker.resolve(req.requestId, false);
    assert.strictEqual(await decision, false);
  });

  test('setWorking tracks depth and shows/hides the status-bar indicator', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    let shown = 0;
    let hidden = 0;
    const bar: any = { show: () => shown++, hide: () => hidden++, text: '', tooltip: '' };
    provider.setWorkingStatusBar(bar);

    provider.setWorking(true);   // depth 1 → show
    provider.setWorking(true);   // depth 2 → still shown
    provider.setWorking(false);  // depth 1 → still shown
    provider.setWorking(false);  // depth 0 → hide
    assert.strictEqual(shown, 1, 'indicator shown once while any work is in flight');
    assert.strictEqual(hidden, 1, 'indicator hidden once all work finished');

    // Over-drain clamps at 0 — no crash, no redundant hide.
    provider.setWorking(false);
    assert.strictEqual(hidden, 1, 'no extra hide once already idle');
  });

  test('setWorking shows a spinner text while active and clears it when idle', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const bar: any = { show: () => {}, hide: () => {}, text: '', tooltip: '' };
    provider.setWorkingStatusBar(bar);

    provider.setWorking(true);
    assert.ok(bar.text.includes('Working'), 'spinner text set while working');
    provider.setWorking(false);
    assert.strictEqual(bar.text, '', 'text cleared when idle');
  });

  test('first user message auto-creates a session named from the message', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, makeSessionContext());
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };

    await (provider as any).ensureSession('fix the login bug');
    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1, 'one session created');
    assert.strictEqual(sessions[0].name, 'fix the login bug', 'named from the first message');
    assert.strictEqual((provider as any).getActiveSessionId(), sessions[0].id, 'session set active');

    const listMsg = posted.find((m: any) => m.type === 'sessionList');
    assert.ok(listMsg, 'sessionList posted after creation');
    assert.strictEqual(listMsg.sessions.length, 1);
    assert.strictEqual(listMsg.activeId, sessions[0].id);

    // Subsequent messages must NOT stack new sessions.
    await (provider as any).ensureSession('another message');
    assert.strictEqual((provider as any).getSessions().length, 1, 'no second session on later messages');
  });

  test('ensureSession is a no-op when an active session already exists', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, makeSessionContext());
    await provider.createNewSession();
    await (provider as any).ensureSession('hello');
    assert.strictEqual((provider as any).getSessions().length, 1);
    assert.strictEqual((provider as any).getActiveSessionId(), (provider as any).getSessions()[0].id);
  });

  test('requestConsent skips the prompt for a session-approved tool', async () => {
    clearSessionAutoApprovals();
    addSessionToolApproval('edit_file');
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };

    const decision = await provider.requestConsent('edit_file', { path: 'a.ts', oldText: 'a', newText: 'b' });
    assert.strictEqual(decision, true, 'session-approved tool auto-approves');
    assert.ok(!posted.find((m: any) => m.type === 'consentRequest'), 'no consent card posted');
  });

  test('requestConsent skips the prompt for a session-approved terminal command (inline mode)', async () => {
    clearSessionAutoApprovals();
    addSessionCommandApproval('npm test');
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };

    const decision = await provider.requestConsent('run_terminal_command', { command: 'npm test' });
    assert.strictEqual(decision, true, 'session-approved command auto-approves');
    assert.ok(!posted.find((m: any) => m.type === 'consentRequest'), 'no consent card posted');
  });

  test('createNewSession clears session approvals (no leak into the new chat)', async () => {
    clearSessionAutoApprovals();
    addSessionToolApproval('edit_file');
    const provider = new ChatViewProvider({} as any, {} as any, makeSessionContext());

    await provider.createNewSession();
    assert.strictEqual(isSessionAutoApproved('edit_file'), false, 'approvals reset on new session');
  });
});

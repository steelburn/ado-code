import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

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
});

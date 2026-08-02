import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

suite('ChatViewProvider', () => {
  test('can be instantiated', () => {
    // C-6 fix: Task 8 changed the signature to (extensionUri, services, context, onItemsFetched?).
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    assert.ok(provider);
  });
});

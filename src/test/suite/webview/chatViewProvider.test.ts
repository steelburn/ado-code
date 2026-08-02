import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

suite('ChatViewProvider', () => {
  test('can be instantiated', () => {
    // H15 fix: match Task 3's 1-param constructor. Task 8 changes the
    // signature to (extensionUri, services, context, onItemsFetched?) —
    // update this test there.
    const provider = new ChatViewProvider({} as any);
    assert.ok(provider);
  });
});

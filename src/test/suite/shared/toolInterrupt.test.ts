import * as assert from 'assert';
import {
  USER_INTERRUPT_REASON,
  interruptedToolResult,
  isToolInterruptResult,
  shouldInterruptTool,
} from '../../../shared/toolInterrupt';

suite('shared/toolInterrupt', () => {
  test('interruptedToolResult is machine-readable JSON carrying the default reason', () => {
    const parsed = JSON.parse(interruptedToolResult());
    assert.strictEqual(parsed.interrupted, true);
    assert.strictEqual(parsed.reason, USER_INTERRUPT_REASON);
  });

  test('interruptedToolResult honours a custom reason', () => {
    const parsed = JSON.parse(interruptedToolResult('stopped by user'));
    assert.strictEqual(parsed.interrupted, true);
    assert.strictEqual(parsed.reason, 'stopped by user');
  });

  test('isToolInterruptResult recognises its own output', () => {
    assert.strictEqual(isToolInterruptResult(interruptedToolResult()), true);
  });

  test('isToolInterruptResult rejects non-interrupt and non-JSON content', () => {
    assert.strictEqual(isToolInterruptResult(''), false);
    assert.strictEqual(isToolInterruptResult('plain text'), false);
    assert.strictEqual(isToolInterruptResult('{"interrupted":false}'), false);
    assert.strictEqual(isToolInterruptResult('{"ok":true}'), false);
    assert.strictEqual(isToolInterruptResult('{ not json'), false);
  });

  test('shouldInterruptTool only fires for an already-aborted signal', () => {
    assert.strictEqual(shouldInterruptTool(undefined), false);
    assert.strictEqual(shouldInterruptTool(null), false);
    assert.strictEqual(shouldInterruptTool({ aborted: false }), false);
    assert.strictEqual(shouldInterruptTool({ aborted: true }), true);
  });
});

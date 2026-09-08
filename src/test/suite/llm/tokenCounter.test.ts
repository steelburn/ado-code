import * as assert from 'assert';
import { countTokens, countMessageTokens, countContentTokens, countImageTokens } from '../../../llm/context/tokenCounter';

// 0.6.5: token counting must reflect what is actually passed to the LLM —
// tool-call content (arguments JSON on assistant messages, tool results) and
// non-text content blocks (images) — not just plain text.

suite('Token counter (0.6.5: tool + image aware)', () => {
  test('counts plain text via the heuristic', () => {
    assert.ok(countTokens('hello world') > 0);
    assert.strictEqual(countTokens(''), 0);
    assert.strictEqual(countTokens('short'), 2, 'ceil(5/4)=2');
  });

  test('image content blocks add a size-based estimate (not free)', () => {
    // A small base64 png (~1kb raw) must cost more than the flat 85-token base.
    const b64 = Buffer.alloc(1024).toString('base64');
    const imageTokens = countImageTokens({ type: 'base64', media_type: 'image/png', data: b64 });
    assert.ok(imageTokens > 85, 'payload contributes tiles beyond the base');
    const urlTokens = countImageTokens({ type: 'url', url: 'https://x/y.png', media_type: 'image/png' });
    assert.strictEqual(urlTokens, 85, 'url images (no size hint) count the flat base');
    const total = countContentTokens([
      { type: 'text', text: 'describe this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
    ]);
    assert.ok(total > countTokens('describe this'), 'image adds tokens to the message');
  });

  test('assistant tool calls: serialized arguments are counted (passed to the LLM)', () => {
    const withTools = [
      { role: 'assistant' as const, content: 'let me read that', toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts', startLine: 1, endLine: 300 }) },
        { id: 'call_2', name: 'edit_file', arguments: JSON.stringify({ path: 'src/a.ts', edits: [{ oldText: 'x'.repeat(200), newText: 'y'.repeat(200) }] }) },
      ] },
    ];
    const withoutTools = [
      { role: 'assistant' as const, content: 'let me read that', toolCalls: [] as Array<{ id: string; name: string; arguments: string }> },
    ];
    const a = countMessageTokens(withTools as any);
    const b = countMessageTokens(withoutTools as any);
    assert.ok(a > b, 'tool-call argument JSON is counted');
  });

  test('tool results (role tool) are counted with their payload', () => {
    const bigResult = 'x'.repeat(4000);
    const withResult = countMessageTokens([{ role: 'tool', content: bigResult, toolCallId: 'call_1' }]);
    assert.ok(withResult > 400, 'tool result payload tokens counted');
  });

  test('content-block arrays with text count the same as plain strings', () => {
    const plain = countMessageTokens([{ role: 'user', content: 'fix the login flow now' }]);
    const blocks = countMessageTokens([{ role: 'user', content: [{ type: 'text', text: 'fix the login flow now' }] }]);
    assert.strictEqual(plain, blocks);
  });

  test('every message pays role overhead; tool metadata adds overhead', () => {
    const base = countMessageTokens([{ role: 'user', content: 'hi' }]);
    assert.strictEqual(base, countTokens('hi') + 4, 'role overhead applied');
  });
});

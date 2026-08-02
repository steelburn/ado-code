import * as assert from 'assert';
import { AgentRegistry, AGENT_SPECS } from '../../../agents/registry';

suite('AgentRegistry', () => {
  test('reports installed agents with version', async () => {
    const registry = new AgentRegistry();
    const caps = await registry.detect();
    // Every spec yields a capability entry (installed or not) — no throws.
    assert.strictEqual(caps.length, Object.keys(AGENT_SPECS).length);
    // At least the binary running this test process (node) isn't in the list,
    // but every entry has the required shape.
    for (const c of caps) {
      assert.ok(['claude', 'codex', 'opencode', 'hermes', 'pi', 'openclaw', 'aider', 'gemini', 'cursor-agent'].includes(c.name));
      assert.strictEqual(typeof c.installed, 'boolean');
    }
  });

  test('getInstalled filters to installed only', async () => {
    const registry = new AgentRegistry();
    const installed = await registry.getInstalled();
    for (const c of installed) {
      assert.strictEqual(c.installed, true);
    }
  });

  test('detect caches results; clearCache resets', async () => {
    const registry = new AgentRegistry();
    const first = await registry.detect();
    const second = await registry.detect();
    assert.strictEqual(first, second); // same cached array reference
    registry.clearCache();
    const third = await registry.detect();
    assert.notStrictEqual(first, third); // fresh array after clear
  });

  test('AGENT_SPECS supportsSession drives modes', async () => {
    const registry = new AgentRegistry();
    const caps = await registry.detect();
    for (const spec of Object.values(AGENT_SPECS)) {
      const cap = caps.find(c => c.name === spec.name)!;
      assert.ok(cap);
      if (spec.supportsSession) {
        assert.deepStrictEqual(cap.modes, ['one-shot', 'session']);
      } else {
        assert.deepStrictEqual(cap.modes, ['one-shot']);
      }
    }
  });
});

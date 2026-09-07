import * as assert from 'assert';
import { AgentRegistry, AGENT_SPECS, DETECT_TTL_MS, migrateEnabledAgents, PRE_DSH_ENABLED_DEFAULT } from '../../../agents/registry';

suite('AgentRegistry', () => {
  test('reports installed agents with version', async () => {
    const registry = new AgentRegistry();
    const caps = await registry.detect();
    // Every spec yields a capability entry (installed or not) — no throws.
    assert.strictEqual(caps.length, Object.keys(AGENT_SPECS).length);
    // At least the binary running this test process (node) isn't in the list,
    // but every entry has the required shape.
    for (const c of caps) {
      assert.ok(['claude', 'codex', 'opencode', 'hermes', 'pi', 'openclaw', 'aider', 'gemini', 'cursor-agent', 'dsh'].includes(c.name));
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

  test('detect re-probes after the TTL so CLIs installed mid-session are found', async () => {
    let t = 1000;
    const registry = new AgentRegistry(() => t);
    const first = await registry.detect();
    // Same cached array while inside the TTL window…
    t += DETECT_TTL_MS - 1000;
    const second = await registry.detect();
    assert.strictEqual(first, second);
    // …but once the TTL elapses a fresh probe runs (a CLI installed after
    // VS Code started now shows up without reloading the window).
    t += DETECT_TTL_MS + 1000;
    const third = await registry.detect();
    assert.notStrictEqual(first, third);
  });

  test('AGENT_SPECS supportsSession drives modes (for installed agents)', async () => {
    const registry = new AgentRegistry();
    const caps = await registry.detect();
    for (const spec of Object.values(AGENT_SPECS)) {
      const cap = caps.find(c => c.name === spec.name)!;
      assert.ok(cap);
      // Uninstalled agents report ['one-shot'] (no session without a binary);
      // installed agents follow the spec.
      if (cap.installed) {
        if (spec.supportsSession) {
          assert.deepStrictEqual(cap.modes, ['one-shot', 'session']);
        } else {
          assert.deepStrictEqual(cap.modes, ['one-shot']);
        }
      }
    }
  });

  test('migrateEnabledAgents upgrades the stale pre-dsh default so dsh is probed', () => {
    const migrated = migrateEnabledAgents([...PRE_DSH_ENABLED_DEFAULT]);
    assert.ok(migrated.includes('dsh'), 'dsh added for users whose stored list predates it');
    assert.strictEqual(migrated.length, Object.keys(AGENT_SPECS).length, 'full current default after migration');
  });

  test('migrateEnabledAgents respects custom pruned lists (never overrides explicit pruning)', () => {
    assert.deepStrictEqual(migrateEnabledAgents(['claude']), ['claude']);
    assert.deepStrictEqual(migrateEnabledAgents(['claude', 'dsh']), ['claude', 'dsh']);
    assert.deepStrictEqual(migrateEnabledAgents([]), [], 'empty (unset) stays empty — default applies upstream');
  });
});

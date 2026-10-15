import * as assert from 'assert';
import { AgentRegistry, AGENT_SPECS, DETECT_TTL_MS, migrateEnabledAgents, PRE_DSH_ENABLED_DEFAULT } from '../../../agents/registry';

/**
 * Injected probes: which agents "exist" is decided by the test, not by the
 * machine. A real sweep spawns up to 30 child processes, and inside the Electron
 * test host every candidate was observed hitting the 5s probe timeout (~150s per
 * sweep), which made this suite blow its bound and fail the pre-commit gate.
 * Real probing / candidate order is covered by the resolveBin + adapters suites.
 */
const probeAllInstalled = async (bin: string): Promise<string> => {
  if (!bin) throw new Error('not installed');
  return '9.9.9';
};

const probeOnlyClaude = async (bin: string): Promise<string> => {
  if (!bin.startsWith('claude')) throw new Error('not installed: ' + bin);
  return '2.0.0';
};

suite('AgentRegistry', function () {
  this.timeout(30000);
  test('reports installed agents with version', async () => {
    const registry = new AgentRegistry(() => 1000, probeAllInstalled);
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
    const registry = new AgentRegistry(() => 1000, probeOnlyClaude);
    const installed = await registry.getInstalled();
    for (const c of installed) {
      assert.strictEqual(c.installed, true);
    }
  });

  test('detect caches results; clearCache resets', async () => {
    let probes = 0;
    const registry = new AgentRegistry(() => 1000, async () => {
      probes++;
      return '9.9.9';
    });
    const first = await registry.detect();
    const afterFirst = probes;
    assert.ok(afterFirst > 0, 'the first sweep probes candidates');
    const second = await registry.detect();
    assert.strictEqual(first, second); // same cached array reference
    assert.strictEqual(probes, afterFirst, 'a cache hit re-probes nothing');
    registry.clearCache();
    const third = await registry.detect();
    assert.notStrictEqual(first, third); // fresh array after clear
    assert.ok(probes > afterFirst, 'clearing the cache re-probes');
  });

  test('a sweep longer than the TTL is not born expired', async () => {
    // A cold win32 sweep (10 agents × up to 3 executable shapes) can take as
    // long as DETECT_TTL_MS. The clock below models that: the first read is
    // the entry check, every later read is past the TTL — i.e. what the clock
    // looks like by the time the sweep finishes. Stamping the cache at the
    // START of the sweep therefore stores an already-expired entry, and the
    // very next detect() re-probes (new array) instead of serving the cache.
    let reads = 0;
    const registry = new AgentRegistry(() => (reads++ === 0 ? 1000 : 1000 + DETECT_TTL_MS + 1), probeAllInstalled);
    const first = await registry.detect();
    const second = await registry.detect();
    assert.strictEqual(first, second, 'a slow sweep must still be cached once it completes');
  });

  test('detect re-probes after the TTL so CLIs installed mid-session are found', async () => {
    let t = 1000;
    const registry = new AgentRegistry(() => t, probeAllInstalled);
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
    const registry = new AgentRegistry(() => 1000, probeAllInstalled);
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

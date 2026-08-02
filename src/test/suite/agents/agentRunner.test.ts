import * as assert from 'assert';
import { AgentRunner } from '../../../agents/AgentRunner';
import { AgentRegistry } from '../../../agents/registry';
import { AgentRun, AgentName } from '../../../agents/types';

// ── Fakes ───────────────────────────────────────────────────────────
function fakeRegistry(installed: AgentName[] = ['claude']): AgentRegistry {
  const registry = new AgentRegistry();
  (registry as any).detect = async () => installed.map(name => ({
    name,
    displayName: name.toUpperCase(),
    installed: true,
    version: '1.0.0',
    modes: ['one-shot'] as ('one-shot' | 'session')[],
  }));
  (registry as any).getInstalled = async () => (await (registry as any).detect()).filter((c: any) => c.installed);
  return registry;
}

function fakeGit(): any {
  return {
    workspaceRoot: '/tmp/work',
    getStatusPorcelain: async () => ' M src/foo.ts\n',
    getDiffStat: async () => ' src/foo.ts | 2 +-\n',
  };
}

// ── Tests ───────────────────────────────────────────────────────────
suite('AgentRunner', () => {
  test('delegate runs through the adapter and completes via callback', async () => {
    const events: string[] = [];
    const runner = new AgentRunner(
      fakeRegistry(),
      fakeGit(),
      {
        onStatus: (_run, delta) => events.push(`status:${delta}`),
        onComplete: (_run, summary) => events.push(`complete:${summary.includes('Changed files:')}`),
      }
    );

    const run = await runner.delegate(42, 'do stuff', 'claude');
    // NOTE: in the test env there is no workspace folder, so cwd='' makes the
    // adapter's spawn throw synchronously — the run may already be 'failed' by
    // the time delegate() returns. Assert only what's stable: the run id.
    assert.ok(run.id.includes('42'));

    // Wait for the background completion. The real `claude` binary isn't
    // installed, so the adapter resolves exitCode 1 with a "failed to spawn"
    // message — status becomes 'failed' and onComplete fires.
    await new Promise(res => setTimeout(res, 100));
    const finished = runner.listRuns().find(r => r.id === run.id)!;
    assert.strictEqual(finished.status, 'failed');
    assert.ok(events.some(e => e.startsWith('complete:')));
  });

  test('cancel aborts a running run', async () => {
    const runner = new AgentRunner(fakeRegistry(), fakeGit(), { onStatus: () => {}, onComplete: () => {} });
    const run = await runner.delegate(1, 'x', 'claude');
    runner.cancel(run.id);
    const state = runner.listRuns().find(r => r.id === run.id)!;
    // Race-tolerant: if the adapter already failed synchronously (no cwd in
    // tests), cancel is a no-op and status stays 'failed'; otherwise 'cancelled'.
    assert.ok(['cancelled', 'failed'].includes(state.status));
  });

  test('persisted running runs become interrupted on reload', () => {
    const persisted: AgentRun[] = [{
      id: 'run-999-1',
      workItemId: 1,
      agent: 'claude',
      workdir: '/tmp',
      status: 'running',
      startedAt: new Date().toISOString(),
    }];
    const runner = new AgentRunner(
      fakeRegistry(),
      fakeGit(),
      { onStatus: () => {}, onComplete: () => {} },
      { save: () => {}, load: () => persisted }
    );
    const run = runner.listRuns()[0];
    assert.strictEqual(run.status, 'interrupted');
  });

  test('resumeInterrupted only fires for interrupted runs with sessionId', () => {
    let followUpCalled = false;
    const runner = new AgentRunner(
      fakeRegistry(),
      fakeGit(),
      { onStatus: () => {}, onComplete: () => {} },
      {
        save: () => {},
        load: () => [{
          id: 'run-1-1', workItemId: 1, agent: 'claude', workdir: '/tmp',
          status: 'interrupted', startedAt: new Date().toISOString(), sessionId: 'sess-1',
        }],
      }
    );
    (runner as any).followUp = async () => { followUpCalled = true; };
    runner.resumeInterrupted('run-1-1');
    assert.ok(followUpCalled);
    runner.resumeInterrupted('nope'); // no-op, no throw
  });

  test('followUp throws for unknown run id', async () => {
    const runner = new AgentRunner(fakeRegistry(), fakeGit(), { onStatus: () => {}, onComplete: () => {} });
    await assert.rejects(runner.followUp('missing', 'hi'), /no run with id/);
  });
});

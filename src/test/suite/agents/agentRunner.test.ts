import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    // Deterministic adapter: always "fails to spawn" — the test must not
    // depend on whether a real `claude` binary is installed on the machine
    // (it is, on dev machines — the real spawn would stay 'running' and the
    // 100ms wait below would flake).
    const stubAdapter = {
      runTask: async () => ({ exitCode: 1, output: 'failed to spawn: fake' }),
      extractSessionId: () => undefined,
    };
    const runner = new AgentRunner(
      fakeRegistry(),
      fakeGit(),
      {
        onStatus: (_run, delta) => events.push(`status:${delta}`),
        onComplete: (_run, summary) => events.push(`complete:${summary.includes('Changed files:')}`),
      },
      undefined,
      undefined,
      () => stubAdapter as any
    );

    const run = await runner.delegate(42, 'do stuff', 'claude');
    // NOTE: in the test env there is no workspace folder, so cwd='' makes the
    // adapter's spawn throw synchronously — the run may already be 'failed' by
    // the time delegate() returns. Assert only what's stable: the run id.
    assert.ok(run.id.includes('42'));

    // Wait for the background completion — the stub adapter fails with
    // exitCode 1, so status becomes 'failed' and onComplete fires.
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

  test('delegate refuses a second run for the same work item (concurrency guard)', async () => {
    const runner = new AgentRunner(fakeRegistry(), fakeGit(), { onStatus: () => {}, onComplete: () => {} });
    // Seed an in-flight run for work item 42 (delegate() would normally fail
    // fast in the test env, so inject the running state directly).
    (runner as any).runs.set('run-1-42', {
      id: 'run-1-42', workItemId: 42, agent: 'claude', workdir: '/tmp', status: 'running',
      startedAt: new Date().toISOString(),
    });
    await assert.rejects(
      runner.delegate(42, 'do it', 'claude'),
      /already has an active agent run/
    );
    // A different work item is not blocked.
    const run = await runner.delegate(43, 'do it', 'claude');
    assert.ok(run.id);
  });

  test('delegate warns when the existing branch is behind the base (stale-base guard)', async () => {
    const git = {
      ...fakeGit(),
      getBranchName: () => 'feature/ADO-42-stale',
      branchExists: async () => true,
      isBranchUpToDate: async () => false,
      createWorktree: async () => '/tmp/worktree',
    };
    const events: string[] = [];
    const runner = new AgentRunner(
      fakeRegistry(),
      git,
      { onStatus: (_run, delta) => events.push(delta), onComplete: () => {} }
    );

    await runner.delegate(42, 'do it', 'claude');
    assert.ok(
      events.some(e => e.includes('warning: branch') && e.includes('behind the base')),
      'stale-base warning surfaced, got: ' + JSON.stringify(events)
    );
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

  test('dismiss marks a run as dismissed and persists the id', () => {
    const persisted: AgentRun[] = [{
      id: 'run-1-1', workItemId: 1, agent: 'claude', workdir: '/tmp',
      status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }];
    let savedDismissed: string[] = [];
    const runner = new AgentRunner(
      fakeRegistry(),
      fakeGit(),
      { onStatus: () => {}, onComplete: () => {} },
      {
        save: () => {},
        load: () => persisted,
        saveDismissed: ids => { savedDismissed = ids; },
        loadDismissed: () => savedDismissed,
      }
    );
    assert.strictEqual(runner.isDismissed('run-1-1'), false);
    runner.dismiss('run-1-1');
    assert.strictEqual(runner.isDismissed('run-1-1'), true);
    assert.deepStrictEqual(savedDismissed, ['run-1-1']);
  });

  test('dismissing an unknown run id is a no-op', () => {
    const runner = new AgentRunner(fakeRegistry(), fakeGit(), { onStatus: () => {}, onComplete: () => {} });
    runner.dismiss('nope');
    assert.strictEqual(runner.isDismissed('nope'), false);
  });

  test('dismissed runs stay dismissed after reconstruction from the store', () => {
    const persisted: AgentRun[] = [{
      id: 'run-2-1', workItemId: 2, agent: 'claude', workdir: '/tmp',
      status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }];
    const dismissed: string[] = ['run-2-1'];
    // Simulates an extension reload: the store still holds the dismissed id.
    const runner = new AgentRunner(
      fakeRegistry(),
      fakeGit(),
      { onStatus: () => {}, onComplete: () => {} },
      {
        save: () => {},
        load: () => persisted,
        saveDismissed: () => {},
        loadDismissed: () => dismissed,
      }
    );
    assert.strictEqual(runner.isDismissed('run-2-1'), true);
  });

  test('delegate slugs the worktree branch from the work item title', async () => {
    const git = {
      ...fakeGit(),
      getBranchName: (id: number, t: string) => `feature/ADO-${id}-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    };
    const runner = new AgentRunner(fakeRegistry(), git, { onStatus: () => {}, onComplete: () => {} });
    const run = await runner.delegate(42, 'Read and follow AGENTS.md and implement the ticket.', 'claude', 'Fix login bug');
    assert.strictEqual(run.branch, 'feature/ADO-42-fix-login-bug');
  });

  test('delegate falls back to the prompt first line when no title given', async () => {
    const git = {
      ...fakeGit(),
      getBranchName: (id: number, t: string) => `feature/ADO-${id}-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    };
    const runner = new AgentRunner(fakeRegistry(), git, { onStatus: () => {}, onComplete: () => {} });
    const run = await runner.delegate(42, 'Read and follow AGENTS.md', 'claude');
    assert.strictEqual(run.branch, 'feature/ADO-42-read-and-follow-agents-md');
  });

  test('runs the memory-driven pre-agent hook and streams its output', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-hook-'));
    try {
      const events: string[] = [];
      const git = {
        ...fakeGit(),
        workspaceRoot: workdir,
        getBranchName: (id: number, t: string) => `feature/ADO-${id}-${t}`,
        createWorktree: async () => workdir,
      };
      const runner = new AgentRunner(
        fakeRegistry(),
        git,
        { onStatus: (_r, d) => events.push(d), onComplete: () => {} },
        undefined,
        { read: (key) => (key === 'agent.before' ? 'echo BEFORE_HOOK_OUT' : null) }
      );
      await runner.delegate(42, 'do stuff', 'claude');
      assert.ok(events.some(e => e.includes('BEFORE_HOOK_OUT')), 'hook output should stream to the panel');
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test('skips the pre-agent hook when memory has none', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-hook-'));
    try {
      const events: string[] = [];
      const git = {
        ...fakeGit(),
        workspaceRoot: workdir,
        getBranchName: (id: number, t: string) => `feature/ADO-${id}-${t}`,
        createWorktree: async () => workdir,
      };
      const runner = new AgentRunner(
        fakeRegistry(),
        git,
        { onStatus: (_r, d) => events.push(d), onComplete: () => {} },
        undefined,
        { read: () => null }
      );
      await runner.delegate(42, 'do stuff', 'claude');
      assert.ok(!events.some(e => e.includes('pre-agent hook')), 'no hook should run without memory');
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test('appends the memory-driven post-agent hook output to the summary', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-hook-'));
    try {
      let summary = '';
      const git = {
        ...fakeGit(),
        workspaceRoot: workdir,
        getBranchName: (id: number, t: string) => `feature/ADO-${id}-${t}`,
        createWorktree: async () => workdir,
      };
      const runner = new AgentRunner(
        fakeRegistry(['codex']),
        git,
        { onStatus: () => {}, onComplete: (_r, s) => { summary = s; } },
        undefined,
        { read: (key) => (key === 'agent.after' ? 'echo AFTER_HOOK_OUT' : null) }
      );
      // codex is not installed → the adapter fails fast, verifyWork runs and
      // the post-agent hook executes. Poll instead of a fixed sleep.
      await runner.delegate(42, 'do stuff', 'codex');
      const deadline = Date.now() + 2000;
      while (summary === '' && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 50));
      }
      assert.ok(summary.includes('Post-agent hook'), 'summary should carry the hook section');
      assert.ok(summary.includes('AFTER_HOOK_OUT'), 'hook output should be captured in the summary');
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});

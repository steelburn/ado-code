import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { cleanupMergedRun, hasMergedPullRequest, MergeCleanupDeps } from '../../../git/mergeCleanup';
import { GitService } from '../../../git/GitService';

function makeDeps(overrides?: Partial<MergeCleanupDeps>): {
  deps: MergeCleanupDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: MergeCleanupDeps = {
    git: {
      workspaceRoot: '/tmp/repo',
      removeWorktree: async (runId) => { calls.push(`remove:${runId}`); },
      deleteBranchIfMerged: async (branch) => { calls.push(`delete:${branch}`); return true; },
    },
    ado: {
      getPullRequestsBySourceBranch: async () => {
        calls.push('fetchPRs');
        return [{ pullRequestId: 7, status: 'completed', mergeStatus: 'succeeded', url: 'x' }];
      },
    },
    getRun: (runId) => (runId === 'run-1' ? { id: 'run-1', branch: 'feature/ado-42' } : undefined),
    ...overrides,
  };
  return { deps, calls };
}

suite('mergeCleanup', () => {
  test('cleanupMergedRun removes worktree and deletes branch when PR merged', async () => {
    const { deps, calls } = makeDeps();
    const res = await cleanupMergedRun('run-1', 'Proj', deps);
    assert.strictEqual(res.cleaned, true);
    assert.strictEqual(res.branchDeleted, true);
    assert.deepStrictEqual(calls, ['fetchPRs', 'remove:run-1', 'delete:feature/ado-42']);
  });

  test('cleanupMergedRun is a no-op while the PR is still active', async () => {
    const { deps, calls } = makeDeps({
      ado: {
        getPullRequestsBySourceBranch: async () => {
          calls.push('fetchPRs');
          return [{ pullRequestId: 7, status: 'active', mergeStatus: 'queued', url: 'x' }];
        },
      },
    });
    const res = await cleanupMergedRun('run-1', 'Proj', deps);
    assert.strictEqual(res.cleaned, false);
    assert.ok(String(res.reason).includes('not completed+merged'));
    assert.deepStrictEqual(calls, ['fetchPRs'], 'no remove/delete while PR active');
  });

  test('cleanupMergedRun no-ops when the PR was abandoned (never merged)', async () => {
    const { deps, calls } = makeDeps({
      ado: {
        getPullRequestsBySourceBranch: async () => {
          calls.push('fetchPRs');
          return [{ pullRequestId: 7, status: 'abandoned', mergeStatus: 'notSet', url: 'x' }];
        },
      },
    });
    const res = await cleanupMergedRun('run-1', 'Proj', deps);
    assert.strictEqual(res.cleaned, false);
    assert.deepStrictEqual(calls, ['fetchPRs']);
  });

  test('cleanupMergedRun no-ops for an unknown run', async () => {
    const { deps, calls } = makeDeps();
    const res = await cleanupMergedRun('run-missing', 'Proj', deps);
    assert.strictEqual(res.cleaned, false);
    assert.ok(String(res.reason).includes('not found'));
    assert.deepStrictEqual(calls, [], 'no ADO fetch for unknown run');
  });

  test('cleanupMergedRun no-ops when the run has no branch', async () => {
    const { deps, calls } = makeDeps({
      getRun: () => ({ id: 'run-1' }),
    });
    const res = await cleanupMergedRun('run-1', 'Proj', deps);
    assert.strictEqual(res.cleaned, false);
    assert.ok(String(res.reason).includes('no branch'));
    assert.deepStrictEqual(calls, []);
  });

  test('hasMergedPullRequest is false for missing run or branch', async () => {
    const { deps } = makeDeps();
    assert.strictEqual(await hasMergedPullRequest(undefined, 'Proj', deps), false);
    assert.strictEqual(await hasMergedPullRequest({ id: 'run-1' }, 'Proj', deps), false);
  });

  test('repo name resolves from workspaceRoot basename', async () => {
    let fetchedRepo = '';
    const { deps } = makeDeps({
      ado: {
        getPullRequestsBySourceBranch: async (_p, repo) => {
          fetchedRepo = repo;
          return [{ pullRequestId: 7, status: 'completed', mergeStatus: 'succeeded' }];
        },
      },
    });
    await cleanupMergedRun('run-1', 'Proj', deps);
    assert.strictEqual(fetchedRepo, 'repo');
  });

  // ── Real-repo integration (round-2 plan: "verify with a real bare remote
  //    + fake ADO fetch") ───────────────────────────────────────────────
  test('cleanupMergedRun removes the worktree and deletes a merged branch (real repo)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-cleanup-'));
    try {
      const git = new GitService(tmp);
      cp.execSync('git init', { cwd: tmp });
      cp.execSync('git config user.email test@test.com', { cwd: tmp });
      cp.execSync('git config user.name test', { cwd: tmp });
      cp.execSync('git commit --allow-empty -m "initial"', { cwd: tmp });

      // Agent worktree with its own branch.
      const wtPath = await git.createWorktree('run-1', 'feature/ado-42');
      fs.writeFileSync(path.join(wtPath, 'work.txt'), 'agent work\n');
      cp.execSync('git add . && git commit -m "ADO-42: agent work"', { cwd: wtPath });

      // Simulate the PR having merged: merge the branch into main locally.
      cp.execSync('git merge feature/ado-42 --no-edit', { cwd: tmp });

      // Fake ADO fetch: PR completed + merged.
      const calls: string[] = [];
      const deps: MergeCleanupDeps = {
        git,
        ado: {
          getPullRequestsBySourceBranch: async () => {
            calls.push('fetchPRs');
            return [{ pullRequestId: 7, status: 'completed', mergeStatus: 'succeeded' }];
          },
        },
        getRun: () => ({ id: 'run-1', branch: 'feature/ado-42' }),
      };

      const res = await cleanupMergedRun('run-1', 'Proj', deps);
      assert.strictEqual(res.cleaned, true);
      assert.strictEqual(res.branchDeleted, true, 'merged branch deleted');
      assert.deepStrictEqual(calls, ['fetchPRs']);

      // Worktree directory gone and git no longer lists it.
      assert.ok(!fs.existsSync(wtPath), 'worktree dir removed');
      const list = await git.listWorktrees();
      assert.ok(!list.some(w => w.runId === 'run-1'), 'worktree gone from git list');
      const branchExists = cp.execSync('git branch --list feature/ado-42', { cwd: tmp }).toString().trim();
      assert.strictEqual(branchExists, '', 'branch deleted');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cleanupMergedRun keeps an unmerged branch and reports it (real repo)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-cleanup2-'));
    try {
      const git = new GitService(tmp);
      cp.execSync('git init', { cwd: tmp });
      cp.execSync('git config user.email test@test.com', { cwd: tmp });
      cp.execSync('git config user.name test', { cwd: tmp });
      cp.execSync('git commit --allow-empty -m "initial"', { cwd: tmp });

      const wtPath = await git.createWorktree('run-2', 'feature/ado-43');
      fs.writeFileSync(path.join(wtPath, 'work.txt'), 'agent work\n');
      cp.execSync('git add . && git commit -m "ADO-43: agent work"', { cwd: wtPath });
      // Do NOT merge — branch stays unmerged.

      const deps: MergeCleanupDeps = {
        git,
        ado: {
          getPullRequestsBySourceBranch: async () => [{ pullRequestId: 8, status: 'completed', mergeStatus: 'succeeded' }],
        },
        getRun: () => ({ id: 'run-2', branch: 'feature/ado-43' }),
      };

      const res = await cleanupMergedRun('run-2', 'Proj', deps);
      assert.strictEqual(res.cleaned, true, 'worktree removed');
      assert.strictEqual(res.branchDeleted, false, 'unmerged branch kept');
      const branchExists = cp.execSync('git branch --list feature/ado-43', { cwd: tmp }).toString().trim();
      assert.strictEqual(branchExists, 'feature/ado-43', 'unmerged branch survived');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

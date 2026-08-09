import * as assert from 'assert';
import { WorktreesTreeProvider } from '../../../webview/WorktreesTreeProvider';
import { AgentRun } from '../../../agents/types';

const sampleRun: AgentRun = {
  id: 'run-1-42',
  workItemId: 42,
  agent: 'claude',
  workdir: '/wt',
  status: 'succeeded',
  startedAt: '2026-08-06T01:00:00.000Z',
  finishedAt: '2026-08-06T01:05:00.000Z',
};

suite('WorktreesTreeProvider', () => {
  test('renders a worktree root with run + git detail children', async () => {
    const git = {
      listWorktrees: async () => [
        { runId: 'run-1-42', path: '/wt', branch: 'feature/ADO-42-fix-login' },
      ],
      getWorktreeInfo: async () => ({
        dirty: true,
        changedFiles: 3,
        ahead: 1,
        behind: 0,
        lastCommit: 'abc1234 fix login',
      }),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    provider.setAgentRunner({ listRuns: () => [sampleRun] } as any);
    await provider.refresh();

    // getChildren() returns [rootNode]; worktree nodes are children of root
    const roots = provider.getChildren();
    assert.strictEqual(roots.length, 1);
    const rootNode = roots[0];
    assert.strictEqual(String(rootNode.label), 'Worktrees');

    const worktreeNodes = provider.getChildren(rootNode);
    assert.strictEqual(worktreeNodes.length, 1);
    const root = worktreeNodes[0];
    assert.strictEqual(root.label, 'feature/ADO-42-fix-login');
    assert.ok(String(root.description).includes('#ADO-42'));
    assert.ok(String(root.description).includes('claude'));
    assert.ok(String(root.description).includes('succeeded'));
    assert.strictEqual(root.contextValue, 'worktreeNode');

    const labels = provider.getChildren(root).map(c => String(c.label));
    assert.ok(labels.some(l => l.includes('Run: claude')));
    assert.ok(labels.some(l => l.includes('Files: 3 changed (dirty)')));
    assert.ok(labels.some(l => l.includes('Last commit: abc1234 fix login')));
    assert.ok(labels.some(l => l.includes('ahead 1')));
    assert.ok(labels.some(l => l.includes('/wt')));
  });

  test('shows clean state for a clean worktree', async () => {
    const git = {
      listWorktrees: async () => [
        { runId: 'run-2-7', path: '/wt2', branch: 'feature/ADO-7-x' },
      ],
      getWorktreeInfo: async () => ({
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      }),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    provider.setAgentRunner({ listRuns: () => [] } as any);
    await provider.refresh();

    const rootNode = provider.getChildren()[0];
    const worktreeNodes = provider.getChildren(rootNode);
    const root = worktreeNodes[0];
    assert.ok(String(root.description).includes('no run record'));
    const labels = provider.getChildren(root).map(c => String(c.label));
    assert.ok(labels.some(l => l.includes('Files: clean')));
    assert.ok(labels.some(l => l.includes('Last commit: (none yet)')));
    assert.ok(labels.some(l => l.includes('ahead 0 · behind 0')));
  });

  test('renders empty when no worktrees exist', async () => {
    const git = {
      listWorktrees: async () => [],
      getWorktreeInfo: async () => ({}),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    await provider.refresh();
    // Root node is always present; its children should be empty
    const rootNode = provider.getChildren()[0];
    assert.strictEqual(provider.getChildren(rootNode).length, 0);
  });

  test('refreshIfChanged reloads only on status transitions', async () => {
    let listCalls = 0;
    const git = {
      listWorktrees: async () => {
        listCalls += 1;
        return [{ runId: 'run-1-42', path: '/wt', branch: 'feature/ADO-42-x' }];
      },
      getWorktreeInfo: async () => ({
        dirty: false, changedFiles: 0, ahead: 0, behind: 0, lastCommit: null,
      }),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    provider.setAgentRunner({ listRuns: () => [sampleRun] } as any);

    // Seed the last-seen status (constructor reload + this seed reload).
    await provider.refreshIfChanged({ ...sampleRun, status: 'succeeded' });
    const afterSeed = listCalls;

    // Same status → no additional reload.
    await provider.refreshIfChanged({ ...sampleRun, status: 'succeeded' });
    assert.strictEqual(listCalls, afterSeed);

    // New status (running) → exactly one more reload.
    await provider.refreshIfChanged({ ...sampleRun, status: 'running' });
    assert.strictEqual(listCalls, afterSeed + 1);
  });
});

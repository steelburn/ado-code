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

  test('lists changed files with the meta the review commands need', async () => {
    const git = {
      listWorktrees: async () => [
        { runId: 'run-1-42', path: '/wt', branch: 'feature/ADO-42-fix-login' },
      ],
      getWorktreeInfo: async () => ({
        dirty: true,
        changedFiles: 2,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      }),
      listWorktreeChanges: async () => ({
        base: 'abc1234def',
        changes: [
          { path: 'src/a.ts', status: 'M' as const, pending: true },
          { path: 'src/new.ts', status: 'A' as const, pending: false },
        ],
      }),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    provider.setAgentRunner({ listRuns: () => [sampleRun] } as any);
    await provider.refresh();

    const root = provider.getChildren(provider.getChildren()[0])[0];
    const group = provider
      .getChildren(root)
      .find((c) => c.contextValue === 'worktreeChangesNode');
    assert.ok(group, 'expected a Changes group');
    assert.ok(String(group!.label).includes('2 files'));
    assert.ok(String(group!.label).includes('1 uncommitted'));

    const files = provider.getChildren(group);
    assert.deepStrictEqual(
      files.map((f) => f.label),
      ['src/a.ts', 'src/new.ts']
    );
    assert.strictEqual(files[0].contextValue, 'worktreeFileNode');
    assert.strictEqual(files[0].command?.command, 'adoCode.worktreeOpenFileDiff');
    const meta = files[0].meta as any;
    assert.strictEqual(meta.path, '/wt');
    assert.strictEqual(meta.filePath, 'src/a.ts');
    assert.strictEqual(meta.base, 'abc1234def');
    assert.strictEqual(meta.pending, true);
    assert.ok(String(files[0].description).includes('uncommitted'));
    assert.ok(!String(files[1].description).includes('uncommitted'));
  });

  test('marks a file this workspace already holds as applied', async () => {
    const git = {
      listWorktrees: async () => [
        { runId: 'run-1-42', path: '/wt', branch: 'feature/ADO-42-fix-login' },
      ],
      getWorktreeInfo: async () => ({
        dirty: true,
        changedFiles: 1,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      }),
      listWorktreeChanges: async () => ({
        base: 'abc1234def',
        changes: [
          { path: 'src/a.ts', status: 'M' as const, pending: true, applied: true },
        ],
      }),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    provider.setAgentRunner({ listRuns: () => [sampleRun] } as any);
    await provider.refresh();

    const root = provider.getChildren(provider.getChildren()[0])[0];
    const group = provider
      .getChildren(root)
      .find((c) => c.contextValue === 'worktreeChangesNode');
    assert.ok(String(group!.label).includes('1 applied'), 'summary counts the accept');
    assert.ok(String(root.description).includes('1/1 applied'), 'worktree row shows progress');

    const file = provider.getChildren(group!)[0];
    assert.ok(String(file.description).includes('applied'));
    assert.strictEqual((file.meta as any).applied, true);
    assert.ok(String(file.tooltip).includes('already holds this exact content'));
  });

  test('renders an empty Changes group when git cannot list changes', async () => {
    const git = {
      listWorktrees: async () => [
        { runId: 'run-3-9', path: '/wt3', branch: 'feature/ADO-9-y' },
      ],
      getWorktreeInfo: async () => ({
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      }),
      listWorktreeChanges: async () => {
        throw new Error('git exploded');
      },
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    await provider.refresh();

    const root = provider.getChildren(provider.getChildren()[0])[0];
    const group = provider
      .getChildren(root)
      .find((c) => c.contextValue === 'worktreeChangesNode');
    assert.ok(group);
    assert.strictEqual(String(group!.label), 'Changes: no changes');
    assert.deepStrictEqual(provider.getChildren(group), []);
  });

  test('reports the worktree count so the view-title review buttons can be gated', async () => {
    const git = {
      listWorktrees: async () => [
        { runId: 'run-1-42', path: '/wt/run-1-42', branch: 'feature/ADO-42-fix-login' },
        { runId: 'run-2-7', path: '/wt/run-2-7', branch: 'feature/ADO-7-thing' },
      ],
      getWorktreeInfo: async () => ({}),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    const counts: number[] = [];
    provider.onWorktreeCountChanged = (count) => counts.push(count);
    await provider.refresh();
    assert.ok(counts.length > 0, 'hook fires on reload');
    assert.strictEqual(counts[counts.length - 1], 2);
    assert.strictEqual(provider.getWorktreeCount(), 2);
  });

  test('reports zero worktrees when the listing fails, hiding the review buttons', async () => {
    const git = {
      listWorktrees: async (): Promise<unknown[]> => {
        throw new Error('git exploded');
      },
      getWorktreeInfo: async () => ({}),
    };
    const provider = new WorktreesTreeProvider({ git } as any);
    const counts: number[] = [];
    provider.onWorktreeCountChanged = (count) => counts.push(count);
    await provider.refresh();
    assert.ok(counts.length > 0, 'hook fires on the failure path too');
    assert.strictEqual(counts[counts.length - 1], 0);
    assert.strictEqual(provider.getWorktreeCount(), 0);
  });
});

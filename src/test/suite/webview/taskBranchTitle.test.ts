import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

// Bug #26935 regression — the task branch was slugged from ambient state.
//
// `startTaskWithAgent` used to run its git pre-flight BEFORE it activated the
// work item, so `ensureGitReady` resolved the branch title from
// `this.activeWorkItem?.title`: whichever item was active BEFORE the handoff,
// or the `Work item <id>` fallback on a fresh session. The runner, meanwhile,
// was handed the freshly fetched title — so the task branch and the run's
// worktree branch pointed at different names for the same run.
//
// The title now travels as an argument (`resolveWorkItemTitle(detail.fields, …)`)
// and the read-only detail fetch happens before the pre-flight, so a stale
// active item can no longer leak into either name.

interface Scenario {
  /** Value of System.Title the fakes report — may be missing/blank. */
  title?: unknown;
}

function makeSessionContext(): any {
  const data = new Map<string, any>();
  return {
    workspaceState: {
      get: (k: string, d?: any) => (data.has(k) ? data.get(k) : d),
      update: async (k: string, v: any) => { data.set(k, v); },
    },
  };
}

/** Records every createTaskBranch(workItemId, title) the provider makes. */
function makeServices(scenario: Scenario, branchCalls: any[]): any {
  const detail = () => ({
    id: 42,
    fields: {
      'System.Title': scenario.title,
      'System.State': 'New',
      'System.Description': 'plain detail text',
      'Microsoft.VSTS.Common.AcceptanceCriteria': 'AC text',
      'System.WorkItemType': 'Task',
    },
  });
  return {
    todos: {
      setActiveSession() { /* noop */ },
      rename() { /* noop */ },
      removeSession() { /* noop */ },
      removeAll() { /* noop */ },
      setGoal() { /* noop */ },
    },
    memory: { toPromptString: () => '' },
    workspaceMemory: { list: () => [], read: () => null },
    understanding: undefined,
    git: {
      isGitRepo: async () => true,
      hasUncommittedChanges: async () => false,
      branchExists: async () => false,
      getCurrentBranch: async () => 'main',
      createTaskBranch: async (workItemId: number | undefined, title: string) => {
        branchCalls.push({ workItemId, title });
        return `feature/ADO-${workItemId}-branch`;
      },
    },
    ado: {
      getWorkItemWithDiscussion: async () => ({ detail: detail(), comments: [] }),
      getWorkItemDetail: async () => detail(),
      getDescendantWorkItems: async () => [],
      updateWorkItem: async () => undefined,
      addComment: async () => ({ id: 1 }),
      resolveImagesInHtml: async (html: string) => html,
    },
  };
}

function makeProvider(scenario: Scenario, branchCalls: any[]): any {
  const provider: any = new ChatViewProvider(
    {} as any,
    makeServices(scenario, branchCalls),
    makeSessionContext()
  );
  provider._view = { webview: { postMessage: () => { /* noop */ } } };
  return provider;
}

/** Records each delegate() call and returns a started run. */
function makeFakeRunner(calls: any[]): any {
  return {
    delegate: async (
      workItemId: number | undefined,
      prompt: string,
      agent?: string,
      title?: string,
      childIds?: number[],
    ) => {
      calls.push({ workItemId, prompt, agent, title, childIds });
      return { id: 'run-26935', workItemId, agent: agent ?? 'fake', status: 'running', childIds: childIds ?? [] };
    },
  };
}

/**
 * Pin the git pre-flight settings so a polluted test profile (or a user's real
 * Global settings) cannot silently skip branch creation, then restore.
 */
async function withGitSettings(run: () => Promise<void>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('adoCode');
  await cfg.update('git.createBranchOnTaskStart', true, vscode.ConfigurationTarget.Global);
  await cfg.update('git.requireGitRepo', true, vscode.ConfigurationTarget.Global);
  await cfg.update('git.requireCleanTree', false, vscode.ConfigurationTarget.Global);
  try {
    await run();
  } finally {
    await cfg.update('git.createBranchOnTaskStart', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('git.requireGitRepo', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('git.requireCleanTree', undefined, vscode.ConfigurationTarget.Global);
  }
}

suite('ChatViewProvider — task branch title (bug #26935)', () => {
  test('startTaskWithAgent names the branch and the run from the item being started, not the stale active item', async () => {
    const branchCalls: any[] = [];
    const delegateCalls: any[] = [];
    await withGitSettings(async () => {
      const provider = makeProvider({ title: 'Fresh ADO subject' }, branchCalls);
      provider.setAgentRunner(makeFakeRunner(delegateCalls));
      // The defect's precondition: a DIFFERENT item is still the active one when
      // the handoff starts.
      provider.activeWorkItem = { id: 999, title: 'Stale story from before the handoff' };

      await provider.startTaskWithAgent(42);

      assert.deepStrictEqual(
        branchCalls,
        [{ workItemId: 42, title: 'Fresh ADO subject' }],
        'the task branch is slugged from the item being started'
      );
      assert.notStrictEqual(branchCalls[0].title, 'Stale story from before the handoff');
      assert.strictEqual(delegateCalls.length, 1, 'the run started');
      assert.strictEqual(delegateCalls[0].workItemId, 42);
      assert.strictEqual(
        delegateCalls[0].title,
        'Fresh ADO subject',
        'the run title matches the branch title (one run, one name)'
      );
    });
  });

  test('startTask names the branch from the fetched detail even when handed a stale label', async () => {
    const branchCalls: any[] = [];
    await withGitSettings(async () => {
      const provider = makeProvider({ title: 'Fresh ADO subject' }, branchCalls);
      // No UI in tests: answer the ADO status-change confirmation.
      provider.requestConfirmation = async () => 'start';

      await provider.startTask(42, 'Stale tree label');

      assert.deepStrictEqual(
        branchCalls,
        [{ workItemId: 42, title: 'Fresh ADO subject' }],
        'the branch follows the fetched detail, not the caller-supplied label'
      );
    });
  });

  test('a work item with no System.Title falls back to a neutral title, never undefined', async () => {
    const branchCalls: any[] = [];
    const delegateCalls: any[] = [];
    await withGitSettings(async () => {
      const provider = makeProvider({ title: undefined }, branchCalls);
      provider.setAgentRunner(makeFakeRunner(delegateCalls));

      await provider.startTaskWithAgent(42);

      assert.strictEqual(branchCalls[0].title, 'Work item 42');
      assert.strictEqual(delegateCalls[0].title, 'Work item 42');
    });
  });
});

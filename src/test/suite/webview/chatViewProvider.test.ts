import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';
import { AgentProgressPanel } from '../../../webview/AgentProgressPanel';
import {
  isSessionAutoApproved,
  addSessionToolApproval,
  addSessionCommandApproval,
  clearSessionAutoApprovals,
} from '../../../llm/tool-approval-ui';

/** Fake ExtensionContext whose workspaceState backs a Map (like the real one). */
function makeSessionContext(): any {
  const data = new Map<string, any>();
  return {
    workspaceState: {
      get: (k: string, d?: any) => (data.has(k) ? data.get(k) : d),
      update: async (k: string, v: any) => { data.set(k, v); },
    },
  };
}

suite('ChatViewProvider', () => {
  test('can be instantiated', () => {
    // C-6 fix: Task 8 changed the signature to (extensionUri, services, context, onItemsFetched?).
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    assert.ok(provider);
  });

  test('requestConsent posts a consentRequest card and resolves on approval', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };
    const args = { path: 'a.ts', oldText: 'a', newText: 'b' };
    const decision = provider.requestConsent('edit_file', args);
    const req = posted.find(m => m.type === 'consentRequest');
    assert.ok(req, 'consentRequest message was posted to the webview');
    assert.strictEqual(req.tool, 'edit_file');
    assert.deepStrictEqual(req.args, args);
    assert.ok(req.requestId);
    assert.ok(typeof req.expiresAt === 'number' && req.expiresAt > Date.now(), 'card gets an expiresAt deadline to count down to');
    // Simulate the webview's consentResponse handler (message switch → broker).
    (provider as any).consentBroker.resolve(req.requestId, true);
    assert.strictEqual(await decision, true);
    assert.strictEqual((provider as any).consentBroker.pending, null);
  });

  test('requestConsent denies when the webview rejects', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };
    const decision = provider.requestConsent('add_comment', { id: 5, text: 'hi' });
    const req = posted.find(m => m.type === 'consentRequest');
    (provider as any).consentBroker.resolve(req.requestId, false);
    assert.strictEqual(await decision, false);
  });

  test('setWorking tracks depth and shows/hides the status-bar indicator', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    let shown = 0;
    let hidden = 0;
    const bar: any = { show: () => shown++, hide: () => hidden++, text: '', tooltip: '' };
    provider.setWorkingStatusBar(bar);

    provider.setWorking(true);   // depth 1 → show
    provider.setWorking(true);   // depth 2 → still shown
    provider.setWorking(false);  // depth 1 → still shown
    provider.setWorking(false);  // depth 0 → hide
    assert.strictEqual(shown, 1, 'indicator shown once while any work is in flight');
    assert.strictEqual(hidden, 1, 'indicator hidden once all work finished');

    // Over-drain clamps at 0 — no crash, no redundant hide.
    provider.setWorking(false);
    assert.strictEqual(hidden, 1, 'no extra hide once already idle');
  });

  test('setWorking shows a spinner text while active and clears it when idle', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const bar: any = { show: () => {}, hide: () => {}, text: '', tooltip: '' };
    provider.setWorkingStatusBar(bar);

    provider.setWorking(true);
    assert.ok(bar.text.includes('Working'), 'spinner text set while working');
    provider.setWorking(false);
    assert.strictEqual(bar.text, '', 'text cleared when idle');
  });

  test('first user message auto-creates a session named from the message', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, makeSessionContext());
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };

    await (provider as any).ensureSession('fix the login bug');
    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1, 'one session created');
    assert.strictEqual(sessions[0].name, 'fix the login bug', 'named from the first message');
    assert.strictEqual((provider as any).getActiveSessionId(), sessions[0].id, 'session set active');

    const listMsg = posted.find((m: any) => m.type === 'sessionList');
    assert.ok(listMsg, 'sessionList posted after creation');
    assert.strictEqual(listMsg.sessions.length, 1);
    assert.strictEqual(listMsg.activeId, sessions[0].id);

    // Subsequent messages must NOT stack new sessions.
    await (provider as any).ensureSession('another message');
    assert.strictEqual((provider as any).getSessions().length, 1, 'no second session on later messages');
  });

  test('ensureSession is a no-op when an active session already exists', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, makeSessionContext());
    await provider.createNewSession();
    await (provider as any).ensureSession('hello');
    assert.strictEqual((provider as any).getSessions().length, 1);
    assert.strictEqual((provider as any).getActiveSessionId(), (provider as any).getSessions()[0].id);
  });

  test('requestConsent skips the prompt for a session-approved tool', async () => {
    clearSessionAutoApprovals();
    addSessionToolApproval('edit_file');
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };

    const decision = await provider.requestConsent('edit_file', { path: 'a.ts', oldText: 'a', newText: 'b' });
    assert.strictEqual(decision, true, 'session-approved tool auto-approves');
    assert.ok(!posted.find((m: any) => m.type === 'consentRequest'), 'no consent card posted');
  });

  test('requestConsent skips the prompt for a session-approved terminal command (inline mode)', async () => {
    clearSessionAutoApprovals();
    addSessionCommandApproval('npm test');
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const posted: any[] = [];
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };

    const decision = await provider.requestConsent('run_terminal_command', { command: 'npm test' });
    assert.strictEqual(decision, true, 'session-approved command auto-approves');
    assert.ok(!posted.find((m: any) => m.type === 'consentRequest'), 'no consent card posted');
  });

  test('sendMessage (choice-card answer) routes to handleUserMessage — never dropped', async () => {
    // Regression: the webview posts {type:'sendMessage'} when the user picks
    // an option on an AI-posed question. The host switch had no such case, so
    // the answer was silently dropped and the chat went stale (spinner on, no
    // LLM turn). Drive the REAL message switch and assert routing.
    const provider = new ChatViewProvider(vscode.Uri.file('/tmp/ext'), {} as any, makeSessionContext());
    const handlers: Array<(msg: any) => void> = [];
    const webviewView: any = {
      onDidDispose: () => {},
      onDidChangeVisibility: () => {},
      webview: {
        options: {},
        html: '',
        postMessage: () => {},
        asWebviewUri: (u: any) => u,
        onDidReceiveMessage: (h: (msg: any) => void) => { handlers.push(h); },
      },
    };
    // Stub the LLM turn so the test only verifies ROUTING, not the API call.
    let routed: string | null = null;
    (provider as any).handleUserMessage = async (content: string) => { routed = content; };

    await (provider as any).resolveWebviewView(webviewView, {}, {});

    assert.strictEqual(handlers.length, 1, 'message handler was registered');
    await handlers[0]({ type: 'sendMessage', content: 'Option B — use the refactor' });
    assert.strictEqual(routed, 'Option B — use the refactor', 'sendMessage content reached handleUserMessage');
  });

  test('userMessage still routes content + images to handleUserMessage', async () => {
    const provider = new ChatViewProvider(vscode.Uri.file('/tmp/ext'), {} as any, makeSessionContext());
    const handlers: Array<(msg: any) => void> = [];
    const webviewView: any = {
      onDidDispose: () => {},
      onDidChangeVisibility: () => {},
      webview: {
        options: {},
        html: '',
        postMessage: () => {},
        asWebviewUri: (u: any) => u,
        onDidReceiveMessage: (h: (msg: any) => void) => { handlers.push(h); },
      },
    };
    const routed: any[] = [];
    (provider as any).handleUserMessage = async (content: string, images?: any[]) => { routed.push({ content, images }); };

    await (provider as any).resolveWebviewView(webviewView, {}, {});

    await handlers[0]({ type: 'userMessage', content: 'hi', images: [{ dataUrl: 'data:image/png;base64,x' }] });
    assert.strictEqual(routed.length, 1);
    assert.strictEqual(routed[0].content, 'hi');
    assert.strictEqual(routed[0].images.length, 1);
  });

  test('createNewSession clears session approvals (no leak into the new chat)', async () => {
    clearSessionAutoApprovals();
    addSessionToolApproval('edit_file');
    const provider = new ChatViewProvider({} as any, {} as any, makeSessionContext());

    await provider.createNewSession();
    assert.strictEqual(isSessionAutoApproved('edit_file'), false, 'approvals reset on new session');
  });

  test('commit_worktree refuses failed runs unless allowFailed overrides', async () => {
    let committed = 0;
    const services: any = {
      git: { commitWorktreeChanges: async () => { committed++; return { committed: true, hash: 'abc1234' }; } },
    };
    const provider = new ChatViewProvider({} as any, services, {} as any);
    (provider as any).agentRunner = { listRuns: () => [{ id: 'run-1', workItemId: 42, title: 'Fix login', status: 'failed' }] };
    provider.setAgentRunner((provider as any).agentRunner);
    (provider as any).executor.setMode('act');

    const denied = await (provider as any).executor.execute('commit_worktree', { runId: 'run-1' });
    const deniedObj = JSON.parse(denied);
    assert.strictEqual(deniedObj.committed, false, 'failed run blocked by default');
    assert.ok(String(deniedObj.reason).includes('failed'), 'reason names the failed status');
    assert.strictEqual(committed, 0, 'no commit attempted for the failed run');

    const allowed = await (provider as any).executor.execute('commit_worktree', { runId: 'run-1', allowFailed: true });
    assert.strictEqual(JSON.parse(allowed).committed, true, 'allowFailed commits anyway');
    assert.strictEqual(committed, 1);
  });

  test('commit_worktree still refuses running runs (regression)', async () => {
    const services: any = {
      git: { commitWorktreeChanges: async () => ({ committed: true, hash: 'abc' }) },
    };
    const provider = new ChatViewProvider({} as any, services, {} as any);
    (provider as any).agentRunner = { listRuns: () => [{ id: 'run-1', status: 'running' }] };
    provider.setAgentRunner((provider as any).agentRunner);
    (provider as any).executor.setMode('act');

    const res = await (provider as any).executor.execute('commit_worktree', { runId: 'run-1' });
    assert.strictEqual(JSON.parse(res).committed, false, 'running run still blocked');
  });

  test('create_pull_request refuses protected base branches', async () => {
    const cfg = vscode.workspace.getConfiguration('adoCode');
    const prev = cfg.get<string[]>('git.protectedBranches', ['main', 'master']);
    try {
      await cfg.update('git.protectedBranches', ['main'], vscode.ConfigurationTarget.Global);
      let prCalled = false;
      const services: any = {
        git: { workspaceRoot: '/tmp/repo', getBaseBranch: async () => 'main' },
        ado: { createPullRequest: async () => { prCalled = true; return { pullRequestId: 1, url: 'x' }; } },
      };
      const provider = new ChatViewProvider({} as any, services, {} as any);
      (provider as any).agentRunner = { listRuns: () => [{ id: 'run-1', branch: 'feature/ado-42', workItemId: 42, title: 'Fix', status: 'succeeded' }] };
      provider.setAgentRunner((provider as any).agentRunner);
      (provider as any).executor.setMode('act');

      const res = await (provider as any).executor.execute('create_pull_request', { runId: 'run-1' });
      assert.ok(String(res).includes('protected branch'), 'refusal names the protected branch');
      assert.strictEqual(prCalled, false, 'createPullRequest never called for a protected base');
    } finally {
      await cfg.update('git.protectedBranches', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('create_pull_request passes for a normal base branch', async () => {
    const services: any = {
      git: { workspaceRoot: '/tmp/repo', getBaseBranch: async () => 'develop' },
      ado: { createPullRequest: async () => ({ pullRequestId: 7, url: 'https://dev.azure.com/x' }) },
    };
    const provider = new ChatViewProvider({} as any, services, {} as any);
    (provider as any).agentRunner = { listRuns: () => [{ id: 'run-1', branch: 'feature/ado-42', workItemId: 42, title: 'Fix', status: 'succeeded' }] };
    provider.setAgentRunner((provider as any).agentRunner);
    (provider as any).executor.setMode('act');

    const res = await (provider as any).executor.execute('create_pull_request', { runId: 'run-1' });
    assert.ok(String(res).includes('pullRequestId'), 'PR created for a normal base');
  });
});

// ── refreshWorkItems hierarchy expansion ────────────────────────────
function workItem(id: number, parentId?: number, type = 'Task', assignedTo = 'Me'): any {
  const fields: Record<string, any> = {
    'System.Id': id,
    'System.Title': `Item ${id}`,
    'System.State': 'Active',
    'System.AssignedTo': { displayName: assignedTo, uniqueName: `${assignedTo.replace(/\s+/g, '')}@org.com` },
    'System.WorkItemType': type,
  };
  if (parentId !== undefined) fields['System.Parent'] = { id: parentId };
  return { id, fields, _links: {} };
}

function makeRefreshProvider(services: any) {
  const treeItems: any[] = [];
  const posts: any[] = [];
  const provider = new ChatViewProvider(
    {} as any,
    services,
    { workspaceState: { get: () => undefined, update: async () => {} } } as any,
    (items: any[]) => treeItems.push(...items)
  );
  (provider as any).postMessage = (m: any) => posts.push(m);
  (provider as any)._view = {};
  return { provider, treeItems, posts };
}

async function withAdoSettings<T>(fn: () => Promise<T>): Promise<T> {
  const cfg = vscode.workspace.getConfiguration('adoCode');
  await cfg.update('adoOrganization', 'testorg', vscode.ConfigurationTarget.Global);
  await cfg.update('adoProject', 'Proj', vscode.ConfigurationTarget.Global);
  await cfg.update('adoPat', 'pat', vscode.ConfigurationTarget.Global);
  try {
    return await fn();
  } finally {
    await cfg.update('adoOrganization', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('adoProject', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('adoPat', undefined, vscode.ConfigurationTarget.Global);
  }
}

suite('ChatViewProvider refreshWorkItems', () => {
  test('expands hierarchy for the trees and marks non-base items as context', async () => {
    const baseTask = workItem(3, 2, 'Task');
    const parentStory = workItem(2, undefined, 'User Story', 'Other');
    const services: any = {
      ado: {
        getWorkItemsAssignedTo: async () => [baseTask],
        getUnassignedWorkItems: async () => [],
        expandHierarchy: async (_p: string, base: any[]) => [...base, parentStory],
      },
    };
    const { provider, treeItems } = makeRefreshProvider(services);

    await withAdoSettings(async () => {
      await (provider as any).refreshWorkItems();
    });

    assert.strictEqual(treeItems.length, 2, 'tree receives base + expanded items');
    const task = treeItems.find((t: any) => t.id === 3);
    const story = treeItems.find((t: any) => t.id === 2);
    assert.strictEqual(task.isContext, false, 'base item is not context');
    assert.strictEqual(story.isContext, true, 'expanded parent is marked context');
    assert.strictEqual(task.parentId, 2, 'parentId preserved for nesting');
  });

  test('falls back to the base set when hierarchy expansion fails', async () => {
    const baseTask = workItem(3, 2, 'Task');
    const services: any = {
      ado: {
        getWorkItemsAssignedTo: async () => [baseTask],
        getUnassignedWorkItems: async () => [],
        expandHierarchy: async () => { throw new Error('boom'); },
      },
    };
    const { provider, treeItems } = makeRefreshProvider(services);

    await withAdoSettings(async () => {
      await (provider as any).refreshWorkItems();
    });

    assert.strictEqual(treeItems.length, 1, 'base items still reach the tree');
    assert.strictEqual(treeItems[0].id, 3);
    assert.strictEqual(treeItems[0].isContext, false);
  });

  test('maps bare-number System.Parent into parentId', async () => {
    // Some ADO orgs serialize System.Parent as a plain integer — the summary
    // mapping must still produce a parentId so the tree can nest.
    const baseTask = {
      id: 3,
      fields: {
        'System.Id': 3,
        'System.Title': 'My task',
        'System.State': 'Active',
        'System.AssignedTo': { displayName: 'Me', uniqueName: 'me@org.com' },
        'System.WorkItemType': 'Task',
        'System.Parent': 2,
      },
      _links: {},
    };
    const services: any = {
      ado: {
        getWorkItemsAssignedTo: async () => [baseTask],
        getUnassignedWorkItems: async () => [],
        expandHierarchy: async (_p: string, base: any[]) => base,
      },
    };
    const { provider, treeItems } = makeRefreshProvider(services);

    await withAdoSettings(async () => {
      await (provider as any).refreshWorkItems();
    });

    assert.strictEqual(treeItems[0].parentId, 2, 'bare-number parent becomes parentId');
  });

  test('setWorkItemsMode switches which dataset the tree fetches', async () => {
    const called: string[] = [];
    const services: any = {
      ado: {
        getWorkItemsAssignedTo: async () => { called.push('mine'); return []; },
        getUnassignedWorkItems: async () => { called.push('unassigned'); return []; },
        getAllWorkItems: async () => { called.push('all'); return []; },
        expandHierarchy: async (_p: string, base: any[]) => base,
      },
    };
    const { provider } = makeRefreshProvider(services);

    await withAdoSettings(async () => {
      // Default mode is 'mine'
      await (provider as any).refreshWorkItems();
      await (provider as any).setWorkItemsMode('unassigned');
      await (provider as any).setWorkItemsMode('all');
      // Same mode again — must not re-fetch
      await (provider as any).setWorkItemsMode('all');
    });

    assert.strictEqual(provider.getWorkItemsMode(), 'all', 'mode persisted');
    assert.deepStrictEqual(called, ['mine', 'unassigned', 'all'], 'one fetch per distinct mode');
  });

  test('refreshWorkItems in all mode fetches every open item', async () => {
    const assigned = workItem(1, undefined, 'Feature', 'Me');
    const unassignedTask = workItem(2, 1, 'Task', '');
    const services: any = {
      ado: {
        getAllWorkItems: async () => [assigned, unassignedTask],
        expandHierarchy: async (_p: string, base: any[]) => base,
      },
    };
    const { provider, treeItems } = makeRefreshProvider(services);

    await withAdoSettings(async () => {
      await (provider as any).setWorkItemsMode('all');
    });

    assert.strictEqual(treeItems.length, 2, 'assigned + unassigned both visible in all mode');
    const task = treeItems.find((t: any) => t.id === 2);
    assert.strictEqual(task.isContext, false, 'base items are not context in all mode');
  });

  test('openAgentProgress opens the live progress panel for a run', async () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const fakeRunner: any = {
      listRuns: () => [{
        id: 'run-1-42', workItemId: 42, agent: 'claude', workdir: '/tmp',
        status: 'running', startedAt: new Date().toISOString(),
      }],
      getRunOutput: (id: string) => (id === 'run-1-42' ? 'streamed output' : ''),
    };
    (provider as any).agentRunner = fakeRunner;

    const shown: Array<{ run: any; output: any }> = [];
    const originalShow = (AgentProgressPanel as any).show;
    (AgentProgressPanel as any).show = (_ctx: any, run: any, output: any) => { shown.push({ run, output }); };
    try {
      await provider.handleAgentMessage({ type: 'openAgentProgress', runId: 'run-1-42' } as any);
      assert.strictEqual(shown.length, 1, 'panel opened once');
      assert.strictEqual(shown[0].run.id, 'run-1-42');
      assert.strictEqual(shown[0].output, 'streamed output', 'backfilled with accumulated output');

      await provider.handleAgentMessage({ type: 'openAgentProgress', runId: 'missing' } as any);
      assert.strictEqual(shown.length, 1, 'missing run opens nothing');
    } finally {
      (AgentProgressPanel as any).show = originalShow;
    }
  });
});

suite('ChatViewProvider proposed-tasks parsing', () => {
  const JSON_TASK = {
    workItemType: 'Task', title: 'T1', description: 'd',
    acceptanceCriteria: 'a', assignedTo: '', tags: '',
  };

  test('parseProposedTasks extracts tasks from the exact JSON fence', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const text = 'Breakdown reasoning here.\n## PROPOSED_TASKS\n```json\n' +
      JSON.stringify([JSON_TASK]) + '\n```';
    const r = (provider as any).parseProposedTasks(text);
    assert.ok(r, 'JSON fence must be parsed');
    assert.strictEqual(r.tasks.length, 1);
    assert.strictEqual(r.tasks[0].title, 'T1');
    assert.ok(r.analysis.includes('Breakdown'));
  });

  test('parseProposedTasks falls back to a numbered list when the model skips JSON', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const text = '## PROPOSED_TASKS\n' +
      '1. **Set up CI** — add pipeline\n' +
      '2. Write tests\n' +
      '3. Add docs';
    const r = (provider as any).parseProposedTasks(text);
    assert.ok(r, 'numbered list must be parsed');
    assert.strictEqual(r.tasks.length, 3);
    assert.strictEqual(r.tasks[0].title, 'Set up CI — add pipeline', 'bold markers stripped');
    assert.strictEqual(r.tasks[0].workItemType, 'Task', 'defaults to Task type');
    assert.strictEqual(r.tasks[2].title, 'Add docs');
  });

  test('parseProposedTasks tolerates fence casing, bare fences, and missing fences', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const json = JSON.stringify([JSON_TASK]);
    for (const block of [
      '```JSON\n' + json + '\n```',
      '```\n' + json + '\n```',
      json, // no fence at all
    ]) {
      const r = (provider as any).parseProposedTasks('## PROPOSED_TASKS\n' + block);
      assert.ok(r, 'block must be parsed');
      assert.strictEqual(r.tasks.length, 1);
    }
  });

  test('parseProposedTasks returns null without a heading or with no tasks', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    assert.strictEqual((provider as any).parseProposedTasks('1. foo\n2. bar'), null);
    assert.strictEqual((provider as any).parseProposedTasks('## PROPOSED_TASKS\n(nothing here)'), null);
  });

  test('parseCheckedTasks preserves multi-line fields with numbered items and skips unchecked', () => {
    const provider = new ChatViewProvider({} as any, {} as any, {} as any);
    const content = [
      '# Proposed Tasks for #1: Story',
      '',
      '## [x] Task 1: Add login',
      '- **Type:** Task',
      '- **Description:** Implement the form.',
      '  1. Add fields',
      '  2. Add validation',
      '- **Acceptance Criteria:** User can log in.',
      '  - With a sub-bullet',
      '',
      '## [ ] Task 2: skipped',
      '- **Type:** Task',
      '- **Description:** nope',
      '',
      '## [x] Task 3: Last',
      '- **Type:** Bug',
      '- **Description:** tail field no newline',
    ].join('\n');
    const tasks = (provider as any).parseCheckedTasks(content);
    assert.strictEqual(tasks.length, 2, 'unchecked sections are skipped');
    assert.strictEqual(tasks[0].title, 'Add login');
    assert.strictEqual(
      tasks[0].description,
      'Implement the form.\n  1. Add fields\n  2. Add validation',
      'numbered sub-items survive the round-trip'
    );
    assert.strictEqual(tasks[0].acceptanceCriteria, 'User can log in.\n  - With a sub-bullet');
    assert.strictEqual(tasks[1].workItemType, 'Bug');
  });

  test('maximizeWizard hides sibling sidebar views on wizard open and restores them on close', async () => {
    const provider = new ChatViewProvider(vscode.Uri.file('/tmp/ext'), {} as any, makeSessionContext());
    const handlers: Array<(msg: any) => void> = [];
    const webviewView: any = {
      onDidDispose: () => {},
      onDidChangeVisibility: () => {},
      webview: {
        options: {},
        html: '',
        postMessage: () => {},
        asWebviewUri: (u: any) => u,
        onDidReceiveMessage: (h: (msg: any) => void) => { handlers.push(h); },
      },
    };
    const executed: string[] = [];
    const orig = vscode.commands.executeCommand;
    (vscode.commands as any).executeCommand = async (id: string) => { executed.push(id); };
    try {
      await (provider as any).resolveWebviewView(webviewView, {}, {});
      const toggles = () => executed.filter(id => id.endsWith('.toggleVisibility'));

      await handlers[0]({ type: 'maximizeWizard', active: true });
      assert.deepStrictEqual(toggles(), [
        'adoCode.workItems.toggleVisibility',
        'adoCode.status.toggleVisibility',
        'adoCode.worktrees.toggleVisibility',
      ], 'all three sibling views hidden when a wizard opens');

      // Repeated open while already open must not double-toggle.
      await handlers[0]({ type: 'maximizeWizard', active: true });
      assert.strictEqual(toggles().length, 3, 'no duplicate toggles for a repeated open');

      await handlers[0]({ type: 'maximizeWizard', active: false });
      assert.deepStrictEqual(toggles().slice(3), toggles().slice(0, 3), 'close restores exactly the views that were hidden');
    } finally {
      (vscode.commands as any).executeCommand = orig;
    }
  });

  /** Build a resolvable webview stub that records posts + visibility changes. */
  function makeTrackedWebview() {
    const handlers: Array<(msg: any) => void> = [];
    const visibilityHandlers: Array<() => void> = [];
    const posted: any[] = [];
    const webviewView: any = {
      visible: true,
      onDidDispose: () => {},
      onDidChangeVisibility: (h: () => void) => visibilityHandlers.push(h),
      webview: {
        options: {},
        html: '',
        postMessage: (m: any) => posted.push(m),
        asWebviewUri: (u: any) => u,
        onDidReceiveMessage: (h: (msg: any) => void) => { handlers.push(h); },
      },
    };
    return { webviewView, handlers, visibilityHandlers, posted };
  }

  test('prompt timeouts pause while the chat view is hidden and resume when it returns', async () => {
    const provider = new ChatViewProvider(vscode.Uri.file('/tmp/ext'), {} as any, makeSessionContext());
    const { webviewView, visibilityHandlers, posted } = makeTrackedWebview();
    await (provider as any).resolveWebviewView(webviewView, {}, {});

    const decision = provider.requestConsent('edit_file', { path: 'a.ts' });
    const consentBroker = (provider as any).consentBroker;
    assert.strictEqual(consentBroker.paused, false, 'not paused while the view is visible');

    // Switch away → frozen.
    webviewView.visible = false;
    await visibilityHandlers[0]();
    assert.strictEqual(consentBroker.paused, true, 'consent timer frozen while the view is hidden');

    // Return → resumed with a re-posted deadline.
    webviewView.visible = true;
    await visibilityHandlers[0]();
    assert.strictEqual(consentBroker.paused, false, 'consent timer resumes when the view returns');
    const repost = posted.filter((m: any) => m.type === 'consentRequest').pop();
    assert.ok(repost, 'pending consent card re-posted on return');
    assert.ok(typeof repost.expiresAt === 'number' && repost.expiresAt > Date.now(), 're-posted with a fresh countdown deadline');

    consentBroker.resolve(repost.requestId, true);
    assert.strictEqual(await decision, true);
  });

  test('pending confirmations pause while the chat view is hidden and re-post on return', async () => {
    const provider = new ChatViewProvider(vscode.Uri.file('/tmp/ext'), {} as any, makeSessionContext());
    const { webviewView, visibilityHandlers, posted } = makeTrackedWebview();
    await (provider as any).resolveWebviewView(webviewView, {}, {});

    const decision = provider.requestConfirmation('Delete Session', 'Really?', [
      { label: 'Delete', value: 'confirm' },
      { label: 'Cancel', value: 'cancel' },
    ]);
    const confirmBroker = (provider as any).confirmBroker;
    webviewView.visible = false;
    await visibilityHandlers[0]();
    assert.strictEqual(confirmBroker.paused, true, 'confirmation timer frozen while the view is hidden');

    webviewView.visible = true;
    await visibilityHandlers[0]();
    assert.strictEqual(confirmBroker.paused, false, 'confirmation timer resumes when the view returns');
    const repost = posted.filter((m: any) => m.type === 'confirmationRequest').pop();
    assert.ok(repost && repost.title === 'Delete Session', 'pending confirmation re-posted on return');
    assert.ok(repost.expiresAt > Date.now(), 're-posted with a fresh countdown deadline');
    (provider as any).confirmBroker.resolve(repost.requestId, 'confirm');
    assert.strictEqual(await decision, 'confirm');
  });

  test('opening a full-page wizard pauses pending prompts; closing it resumes and re-posts', async () => {
    const provider = new ChatViewProvider(vscode.Uri.file('/tmp/ext'), {} as any, makeSessionContext());
    const { webviewView, handlers, posted } = makeTrackedWebview();
    await (provider as any).resolveWebviewView(webviewView, {}, {});

    const decision = provider.requestConsent('add_comment', { id: 1, text: 'hi' });
    const consentBroker = (provider as any).consentBroker;

    // Wizard opens (Configuration page / project creation) → freeze.
    await handlers[0]({ type: 'maximizeWizard', active: true });
    assert.strictEqual(consentBroker.paused, true, 'consent frozen while the wizard is open');

    // User presses Back → resume + re-post the card with the remaining time.
    await handlers[0]({ type: 'maximizeWizard', active: false });
    assert.strictEqual(consentBroker.paused, false, 'consent resumes when the wizard closes');
    const repost = posted.filter((m: any) => m.type === 'consentRequest').pop();
    assert.ok(repost, 'pending consent re-posted after the wizard closes');
    assert.ok(repost.expiresAt > Date.now(), 're-posted with a fresh countdown deadline');

    consentBroker.resolve(repost.requestId, true);
    assert.strictEqual(await decision, true);
  });

  test("kebab 'Configuration…' routes to the in-webview Configuration page", async () => {
    const provider = new ChatViewProvider(vscode.Uri.file('/tmp/ext'), {} as any, makeSessionContext());
    const handlers: Array<(msg: any) => void> = [];
    const posted: any[] = [];
    const webviewView: any = {
      onDidDispose: () => {},
      onDidChangeVisibility: () => {},
      webview: {
        options: {},
        html: '',
        postMessage: (m: any) => posted.push(m),
        asWebviewUri: (u: any) => u,
        onDidReceiveMessage: (h: (msg: any) => void) => { handlers.push(h); },
      },
    };
    await (provider as any).resolveWebviewView(webviewView, {}, {});
    await handlers[0]({ type: 'openSettings' });
    const openMsg = posted.find(m => m.type === 'openSettings');
    assert.ok(openMsg, 'host posts openSettings back to the webview (in-app Configuration page)');
  });
});

// ── AGENTS.md sync flow (checkAgentsMd) ────────────────────────────────────
// Uses the real pure evaluator against a temp workspace and drives the
// in-chat confirmation card through the broker, mirroring the webview.

suite('ChatViewProvider · AGENTS.md sync', () => {
  const tmpDirs: string[] = [];

  function makeWorkspace(pkg: Record<string, any>, extra: Record<string, string> = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-agentsmd-flow-'));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg), 'utf8');
    for (const [rel, content] of Object.entries(extra)) {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    }
    return root;
  }

  /** Provider whose webview posts messages to `posted` and whose
   *  confirmation cards are answered through the confirmBroker. Context
   *  can be shared across providers to mirror real per-workspace state. */
  function makeProvider(root: string, context?: any): { provider: ChatViewProvider; posted: any[] } {
    const posted: any[] = [];
    const provider = new ChatViewProvider(
      vscode.Uri.file(root),
      {
        git: { workspaceRoot: root },
        understanding: { ensureFresh: async () => true, getRepoSummary: () => '', getKnowledge: () => '' },
      } as any,
      context ?? makeSessionContext()
    );
    (provider as any)._view = { webview: { postMessage: (m: any) => posted.push(m) } };
    return { provider, posted };
  }

  /** Wait until the async check posts its confirmation card. */
  async function waitForCard(posted: any[]): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!posted.some(m => m.type === 'confirmationRequest')) {
      if (Date.now() > deadline) throw new Error('no confirmation card was posted');
      await new Promise(r => setTimeout(r, 5));
    }
  }

  function answerCard(posted: any[], provider: ChatViewProvider, value: string): void {
    const req = posted.filter(m => m.type === 'confirmationRequest').pop();
    assert.ok(req, 'a confirmation card was posted');
    (provider as any).confirmBroker.resolve(req.requestId, value);
  }

  suiteTeardown(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test('missing AGENTS.md → card → generate writes a managed file and remembers it', async () => {
    const root = makeWorkspace({ name: 'demo', description: 'Demo', scripts: { compile: 'tsc' } });
    const { provider, posted } = makeProvider(root);

    const done = (provider as any).checkAgentsMd(root);
    await waitForCard(posted);
    answerCard(posted, provider, 'generate');
    await done;

    const md = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes('<!-- ado-code:managed -->'), 'managed file generated');
    assert.ok(md.includes('- `npm run compile`'), 'build command from package.json');
    const prior = (provider as any)._context.workspaceState.get('adoCode.agentsMdSyncPrior');
    assert.ok(prior && prior.declines === 0, 'generation remembered (acceptance clears declines)');
  });

  test('stale managed file → card → update rewrites the block in place', async () => {
    const root = makeWorkspace({ name: 'demo', description: 'Demo', scripts: { compile: 'tsc' } });
    const context = makeSessionContext();
    const first = makeProvider(root, context);
    const done = (first.provider as any).checkAgentsMd(root);
    await waitForCard(first.posted);
    answerCard(first.posted, first.provider, 'generate');
    await done;
    // A custom note lives outside the managed block.
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\n## My Conventions\n- Hand-written rule.\n');

    // The project gains a test script — AGENTS.md is now outdated.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', description: 'Demo', scripts: { compile: 'tsc', test: 'mocha' } }),
      'utf8'
    );

    const { provider, posted } = makeProvider(root, context);
    const sync = (provider as any).checkAgentsMd(root);
    await waitForCard(posted);
    answerCard(posted, provider, 'update');
    await sync;

    const md = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes('- `npm test`'), 'new command synced into the block');
    assert.ok(md.includes('## My Conventions\n- Hand-written rule.'), 'user content outside markers preserved');
  });

  test('declining an offer stops the next check from re-asking for the same state', async () => {
    const root = makeWorkspace({ name: 'demo', description: 'Demo', scripts: { compile: 'tsc' } });
    const context = makeSessionContext();
    const { provider, posted } = makeProvider(root, context);
    const done = (provider as any).checkAgentsMd(root);
    await waitForCard(posted);
    answerCard(posted, provider, 'generate');
    await done;

    // Drift the file (new script) but decline the update.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', description: 'Demo', scripts: { compile: 'tsc', lint: 'eslint' } }),
      'utf8'
    );
    const again = (provider as any).checkAgentsMd(root);
    await waitForCard(posted);
    answerCard(posted, provider, 'keep');
    await again;
    const prior = (provider as any)._context.workspaceState.get('adoCode.agentsMdSyncPrior');
    assert.ok(prior && prior.declines === 1, 'decline remembered');

    // Same state, another check: no card, no change.
    const { provider: p2, posted: posted2 } = makeProvider(root, context);
    await (p2 as any).checkAgentsMd(root);
    await new Promise(r => setTimeout(r, 20));
    const cards = posted2.filter(m => m.type === 'confirmationRequest');
    assert.strictEqual(cards.length, 0, 'no re-offer for an already-declined candidate');
  });
});

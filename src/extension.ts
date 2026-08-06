import * as vscode from 'vscode';
import * as os from 'os';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { StatusPanelProvider } from './webview/StatusPanelProvider';
import { WorkItemDetailPanel } from './webview/WorkItemDetailPanel';
import { AgentSummaryPanel } from './webview/AgentSummaryPanel';
import { WorkItemsTreeProvider, WorkItemNode } from './ado/WorkItemsTreeProvider';
import { createServices, Services } from './services';
import { selectActiveOrganization, getSettings, getActiveOrg } from './config/settings';
import { WorkItemStatesCache } from './ado/WorkItemStatesCache';
import { GitService } from './git/GitService';
import { AgentRunner } from './agents/AgentRunner';
import { AgentRun } from './agents/types';
import { logger } from './services/logger';

let chatProvider: ChatViewProvider;
let treeProvider: WorkItemsTreeProvider;
let unassignedTreeProvider: WorkItemsTreeProvider;

// H-10 fix: activate is async — the Q7 resume QuickPick (Task 24) awaits it,
// and VS Code supports returning a Promise from activate().
export async function activate(context: vscode.ExtensionContext) {
  logger.activate(context);
  let services = createServices(context);
  // Connect MCP servers on startup (fire-and-forget; errors are logged)
  services.mcp.connectAll().catch(err => {
    logger.error('MCP: failed to connect servers', err);
  });
  // Per-project cache of work-item-type states — fetched once per project,
  // refreshable via the state picker's "Refresh states from ADO" entry.
  // The lazy getter re-reads `services` so an org switch picks up the new
  // AdoClient without rebuilding the cache.
  const statesCache = new WorkItemStatesCache(() => services.ado);
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    services,
    context,
    (items) => treeProvider?.refresh(items),
    (items) => unassignedTreeProvider?.refresh(items)
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider
    ),
    // Secondary side bar: same chat provider, different view ID
    vscode.window.registerWebviewViewProvider(
      'adoCode.chatSecondary',
      chatProvider
    )
  );

  // Status Panel: tree view showing mode, memory, MCP, and agent status.
  const statusProvider = new StatusPanelProvider(services);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('adoCode.status', statusProvider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.refreshStatus', () => {
      statusProvider.refresh();
    })
  );

  // Wire memory change events → debounced status refresh (no shell calls).
  // Disposables are tracked so they can be torn down on service rebuild.
  let memorySubscriptions: vscode.Disposable[] = [];
  function wireMemoryEvents(svc: Services): void {
    for (const d of memorySubscriptions) d.dispose();
    memorySubscriptions = [
      svc.memory.onDidChange(() => statusProvider.debouncedRefresh()),
      svc.workspaceMemory.onDidChange(() => statusProvider.debouncedRefresh()),
    ];
  }
  wireMemoryEvents(services);

  // Task 4.1: token usage status bar (right-aligned, shows approximate token count)
  const tokenStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  tokenStatusBar.text = '$(pulse) Tokens: —';
  tokenStatusBar.tooltip = 'Token usage in current conversation';
  tokenStatusBar.command = 'adoCode.showTokenUsage';
  tokenStatusBar.show();
  context.subscriptions.push(tokenStatusBar);
  // Wire to the chat provider so it can update after each LLM turn
  chatProvider.setTokenStatusBar(tokenStatusBar);

  // Task 4.1: show token usage in the output channel
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.showTokenUsage', () => {
      const channel = logger.getChannel();
      if (channel) {
        channel.appendLine(`[Token Usage] Mode: ${getSettings().mode}`);
        channel.show();
      }
    })
  );

  treeProvider = new WorkItemsTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('adoCode.workItems', treeProvider)
  );

  // Unassigned Work Items: same provider class, distinct node contextValue so
  // its context menu (Take Ownership, Reassign…) is gated to this view.
  unassignedTreeProvider = new WorkItemsTreeProvider('unassignedWorkItemNode');
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('adoCode.unassignedWorkItems', unassignedTreeProvider)
  );

  // Register command to refresh work items
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.refreshWorkItems', () => {
      chatProvider.refreshWorkItems();
    })
  );

  // Task 9: tree-item commands (node-first signature — H4). The methods they
  // dispatch to land in Task 10 (startTask) and Task 13 (selectWorkItem).
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.selectWorkItem', (node: WorkItemNode) => {
      chatProvider.selectWorkItem(node.workItemId);
      // Highlight the selected item in both trees
      treeProvider.setSelected(node.workItemId);
      unassignedTreeProvider.setSelected(node.workItemId);
    }),
    vscode.commands.registerCommand('adoCode.unselectWorkItem', () => {
      chatProvider.clearActiveWorkItem();
      treeProvider.setSelected(undefined);
      unassignedTreeProvider.setSelected(undefined);
      vscode.window.showInformationMessage('ADO Code: work item deselected.');
    }),
    vscode.commands.registerCommand('adoCode.startTask', (node: WorkItemNode) => {
      chatProvider.startTask(node.workItemId, node.workItemTitle);
    })
  );

  // C10 fix: register the org-switch command (Q1) — rebuild services and the
  // provider so the AdoClient is recreated against the new org.
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.switchOrganization', async () => {
      await selectActiveOrganization(context);
      services = createServices(context);
      chatProvider.setServices(services);
      statesCache.clearAll();
      await chatProvider.refreshWorkItems();
      vscode.window.showInformationMessage('ADO Code: switched organization.');
    })
  );

  // Generate Commit Message: staged-diff → LLM → clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.generateCommitMessage', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('ADO Code: No workspace open');
        return;
      }
      const rootPath = workspaceFolders[0].uri.fsPath;
      const git = new GitService(rootPath);

      const hasStaged = await git.hasStagedChanges();
      if (!hasStaged) {
        vscode.window.showWarningMessage('ADO Code: No staged changes. Stage files first.');
        return;
      }

      const diff = await git.getStagedDiff();
      if (!diff) {
        vscode.window.showWarningMessage('ADO Code: Could not read staged diff.');
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.SourceControl,
        title: 'Generating commit message...',
        cancellable: false,
      }, async () => {
        const settings = getSettings();
        const apiUrl = settings.llmApiUrl || 'https://api.openai.com/v1';
        const apiKey = settings.llmApiKey;
        const model = settings.llmModel || 'gpt-4o';

        if (!apiKey) {
          vscode.window.showErrorMessage('ADO Code: No API key configured. Set llmApiKey in settings.');
          return;
        }

        const prompt = `Generate a concise git commit message for the following staged changes.

Rules:
- Use conventional commits format: type(scope): description
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build
- Keep the subject line under 72 characters
- Use imperative mood ("add feature" not "added feature")
- Don't include a body unless the changes are complex
- Focus on WHAT changed and WHY, not HOW

Staged changes:
${diff.substring(0, 8000)}

Generate ONLY the commit message, nothing else.`;

        try {
          const response = await fetch(`${apiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 200,
              temperature: 0.3,
            }),
          });

          if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
          }

          const data: any = await response.json();
          const message = data.choices?.[0]?.message?.content?.trim();

          if (message) {
            await vscode.env.clipboard.writeText(message);
            vscode.window.showInformationMessage(`ADO Code: Commit message copied to clipboard: ${message}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`ADO Code: Failed to generate commit message: ${err instanceof Error ? err.message : err}`);
        }
      });
    })
  );

  // Task 17: chat focus command (keybinding target)
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.chat.focus', () => chatProvider.focus())
  );

  // ── Task 3.1+3.2: memory commands ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.showMemory', () => {
      const entries = services.memory.getAll();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('No user memory entries stored.');
        return;
      }
      const items = entries.map(e => ({
        label: e.key,
        description: `[${e.category}]`,
        detail: e.content,
      }));
      vscode.window.showQuickPick(items, {
        placeHolder: 'Select a memory entry to view',
        matchOnDescription: true,
        matchOnDetail: true,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.editMemory', async () => {
      const entries = services.memory.getAll();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('No user memory entries to edit.');
        return;
      }
      const items = entries.map(e => ({
        label: e.key,
        description: `[${e.category}]`,
        entry: e,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a memory entry to edit',
      });
      if (!picked) return;
      const newContent = await vscode.window.showInputBox({
        prompt: `Edit memory "${picked.entry.key}"`,
        value: picked.entry.content,
      });
      if (newContent !== undefined) {
        services.memory.set(picked.entry.key, picked.entry.category, newContent);
        vscode.window.showInformationMessage(`Memory "${picked.entry.key}" updated.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.clearMemory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all user memory entries?',
        { modal: true },
        'Clear'
      );
      if (confirm === 'Clear') {
        services.memory.clear();
        vscode.window.showInformationMessage('All user memory cleared.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.showWorkspaceMemory', () => {
      const keys = services.workspaceMemory.list();
      if (keys.length === 0) {
        vscode.window.showInformationMessage('No workspace memory entries.');
        return;
      }
      const items = keys.map(key => ({
        label: key,
        detail: services.workspaceMemory.read(key) ?? '',
      }));
      vscode.window.showQuickPick(items, {
        placeHolder: 'Select a workspace memory entry to view',
      });
    })
  );

  // ── Task 5.1: setMode command ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.setMode', async () => {
      const modes = [
        { label: 'Inline', value: 'inline', description: 'Direct code edits with consent' },
        { label: 'Plan', value: 'plan', description: 'Read-only planning, no edits' },
        { label: 'Act', value: 'act', description: 'Full auto-approve mode' },
      ];
      const picked = await vscode.window.showQuickPick(modes, {
        placeHolder: 'Select a mode',
      });
      if (picked) {
        const config = vscode.workspace.getConfiguration('adoCode');
        await config.update('mode', picked.value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Mode set to ${picked.label}`);
      }
    })
  );

  // ── Task 6.1: listCheckpoints command ────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.listCheckpoints', async () => {
      const taskId = await vscode.window.showInputBox({
        prompt: 'Enter task ID to list checkpoints for',
        placeHolder: 'task-id',
      });
      if (!taskId) return;
      const checkpoints = services.checkpoints.listCheckpoints(taskId);
      if (checkpoints.length === 0) {
        vscode.window.showInformationMessage('No checkpoints found for this task.');
        return;
      }
      const items = checkpoints.map(cp => ({
        label: cp.id,
        description: `${Object.keys(cp.files).length} files`,
        detail: new Date(cp.timestamp).toLocaleString(),
        checkpoint: cp,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a checkpoint to restore',
      });
      if (!picked) return;
      const confirm = await vscode.window.showWarningMessage(
        `Restore checkpoint ${picked.checkpoint.id}? This will overwrite current files.`,
        { modal: true },
        'Restore'
      );
      if (confirm === 'Restore') {
        const restored = services.checkpoints.restore(picked.checkpoint.id, taskId);
        vscode.window.showInformationMessage(`Restored ${restored.length} files from checkpoint.`);
      }
    })
  );

  // Task 25: delegate / assign-to-agent commands (context menu on work item nodes)
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.delegateToAgent', async (node?: WorkItemNode) => {
      if (!node) return;
      await chatProvider.startTaskWithAgent(node.workItemId, undefined);
    }),
    vscode.commands.registerCommand('adoCode.startTaskWithAgent', async (node?: WorkItemNode) => {
      if (!node) return;
      // QuickPick of installed agents, then hand off
      const installed = await services.agents.getInstalled();
      if (installed.length === 0) {
        vscode.window.showWarningMessage('ADO Code: no external agent CLIs installed (claude, codex, opencode, hermes, pi, openclaw, aider, gemini, cursor-agent).');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        installed.map(a => ({ label: `${a.displayName} (${a.name})`, description: a.version })),
        { placeHolder: 'Which agent should implement this task?' }
      );
      if (!pick) return;
      const agentName = installed.find(a => `${a.displayName} (${a.name})` === pick.label)?.name;
      await chatProvider.startTaskWithAgent(node.workItemId, agentName);
    })
  );

  // Task 28: review/clarification commands (context menu on work item nodes)
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.reviewTaskDetail', (node: WorkItemNode) => chatProvider.reviewTaskDetail(node.workItemId)),
    vscode.commands.registerCommand('adoCode.requestClarification', async (node: WorkItemNode) => {
      const question = await vscode.window.showInputBox({
        prompt: `Clarification request for ADO-${node.workItemId}: what detail do you need?`,
        placeHolder: 'e.g. What is the expected behavior when the user cancels?',
        ignoreFocusOut: true,
      });
      if (question) await chatProvider.requestClarification(node.workItemId, question);
    }),
    vscode.commands.registerCommand('adoCode.checkTaskReplies', (node: WorkItemNode) => chatProvider.checkTaskReplies(node.workItemId)),
    vscode.commands.registerCommand('adoCode.showWorkItemDetail', (node: WorkItemNode) => {
      WorkItemDetailPanel.show(context, services.ado, node.workItemId);
    })
  );

  // Change Item Status: fetch the item TYPE's states from ADO (cached once per
  // project), pick one, PATCH the work item, then refresh the tree.
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.changeWorkItemState', async (node?: WorkItemNode) => {
      if (!node) return;
      const active = getActiveOrg(context, getSettings());
      if (!active.name || !active.project || !getSettings().adoPat) {
        vscode.window.showWarningMessage('ADO Code: configure organization, project and PAT first.');
        return;
      }
      try {
        for (;;) {
          const states = await statesCache.getStates(active.project, node.workItemType);
          const refreshEntry: vscode.QuickPickItem = {
            label: '$(refresh) Refresh states from ADO',
            description: 're-fetch from the server (clears the per-project cache)',
          };
          const pick = await vscode.window.showQuickPick(
            [
              ...states.map(s => ({
                label: s,
                description: s === node.state ? '✓ current' : undefined,
              })),
              refreshEntry,
            ],
            { placeHolder: `Set state for #${node.workItemId} (${node.workItemType}) — currently ${node.state}` }
          );
          if (!pick) return; // cancelled
          if (pick === refreshEntry) {
            statesCache.refresh(active.project, node.workItemType);
            continue;
          }
          if (pick.label === node.state) {
            vscode.window.showInformationMessage(`ADO Code: #${node.workItemId} is already in '${node.state}'.`);
            return;
          }
          await services.ado.updateWorkItem(active.project, node.workItemId, [
            { op: 'add', path: '/fields/System.State', value: pick.label },
          ]);
          vscode.window.showInformationMessage(`ADO Code: #${node.workItemId} → ${pick.label}`);
          await chatProvider.refreshWorkItems();
          return;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`ADO Code: failed to change state for #${node.workItemId}: ${err instanceof Error ? err.message : err}`);
      }
    })
  );

  // Take Ownership (Unassigned Work Items): assign the item to the
  // authenticated user, then refresh both trees (it moves from Unassigned to
  // My Work Items).
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.takeOwnership', async (node?: WorkItemNode) => {
      if (!node) return;
      const active = getActiveOrg(context, getSettings());
      if (!active.name || !active.project || !getSettings().adoPat) {
        vscode.window.showWarningMessage('ADO Code: configure organization, project and PAT first.');
        return;
      }
      try {
        const me = await services.ado.getMe();
        await services.ado.updateWorkItem(active.project, node.workItemId, [
          { op: 'add', path: '/fields/System.AssignedTo', value: me.emailAddress },
        ]);
        vscode.window.showInformationMessage(`ADO Code: #${node.workItemId} assigned to ${me.displayName} (you).`);
        await chatProvider.refreshWorkItems();
      } catch (err) {
        vscode.window.showErrorMessage(`ADO Code: failed to take ownership of #${node.workItemId}: ${err instanceof Error ? err.message : err}`);
      }
    })
  );

  // Reassign To… (both trees): pick a project member, reassign, refresh.
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.reassignWorkItem', async (node?: WorkItemNode) => {
      if (!node) return;
      const active = getActiveOrg(context, getSettings());
      if (!active.name || !active.project || !getSettings().adoPat) {
        vscode.window.showWarningMessage('ADO Code: configure organization, project and PAT first.');
        return;
      }
      try {
        const members = await services.ado.getProjectTeamMembers(active.project);
        if (members.length === 0) {
          vscode.window.showWarningMessage(`ADO Code: no team members found for project '${active.project}'.`);
          return;
        }
        const pick = await vscode.window.showQuickPick(
          members.map(m => ({ label: m.displayName, description: m.uniqueName })),
          { placeHolder: `Reassign #${node.workItemId} (${node.workItemType}) to…` }
        );
        if (!pick) return; // cancelled
        const member = members.find(m => m.uniqueName === pick.description)!;
        await services.ado.updateWorkItem(active.project, node.workItemId, [
          { op: 'add', path: '/fields/System.AssignedTo', value: member.uniqueName },
        ]);
        vscode.window.showInformationMessage(`ADO Code: #${node.workItemId} → ${member.displayName}`);
        await chatProvider.refreshWorkItems();
      } catch (err) {
        vscode.window.showErrorMessage(`ADO Code: failed to reassign #${node.workItemId}: ${err instanceof Error ? err.message : err}`);
      }
    })
  );

  // Task 17: status-bar branch indicator
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'adoCode.refreshWorkItems';
  statusBar.tooltip = 'ADO Code: current task branch';
  statusBar.show();

  // Update it whenever the git branch changes (poll on window focus + workspace events)
  async function updateBranchStatus(): Promise<void> {
    const branch = await services.git.getCurrentBranch();
    statusBar.text = branch ? `$(git-branch) ${branch}` : '$(git-branch) (no repo)';
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(() => updateBranchStatus()),
    vscode.workspace.onDidChangeConfiguration(() => updateBranchStatus())
  );
  void updateBranchStatus();

  // Task 24 (H5): construct AgentRunner AFTER both services and chatProvider
  // exist, then hand it to the provider (which builds the tool executor).
  const agentRunner = new AgentRunner(
    services.agents,
    services.git,
    {
      onStatus: (run, delta) => {
        chatProvider.postMessage({ type: 'agentStatus', run, delta });
        // Update tree view with agent status
        if (run.workItemId) {
          treeProvider.updateAgentStatus(run.workItemId, run.agent, run.status);
        }
      },
      onComplete: (run, summary) => {
        chatProvider.postMessage({ type: 'agentResult', run, summary });
        // Clear agent status from tree view
        if (run.workItemId) {
          treeProvider.updateAgentStatus(run.workItemId, run.agent, 'completed');
        }
        // Open the agent's summary in the editor area so the result is
        // visible outside the chat panel (markdown tab, preview mode).
        void openSummaryInEditor(context, run, summary);
      },
    },
    {
      save: runs => context.workspaceState.update('adoCode.agentRuns', runs),
      load: () => context.workspaceState.get<import('./agents/types').AgentRun[]>('adoCode.agentRuns', []),
    }
  );
  chatProvider.setAgentRunner(agentRunner);

  // Q7: offer to resume interrupted runs (with a session id) after reload.
  const interrupted = agentRunner.listRuns().filter(r => r.status === 'interrupted' && r.sessionId);
  if (interrupted.length > 0) {
    const pick = await vscode.window.showQuickPick(
      interrupted.map(r => ({ label: `Resume ADO-${r.workItemId} (${r.agent})`, description: r.id })),
      { placeHolder: 'An agent run was interrupted by the restart. Resume it?' }
    );
    if (pick) agentRunner.resumeInterrupted(pick.description!, 'Continue where you left off and report status.');
  }

  // Auto-fetch work items on activation if already configured
  const settings = getSettings();
  if (settings.adoOrganization && settings.adoProject && settings.adoPat) {
    chatProvider.refreshWorkItems();
  }

  // ── Status Panel context menu commands ──────────────────────────

  // Memory commands
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.deleteMemory', (item: any) => {
      const meta = item?.meta;
      if (!meta) return;
      if (meta.source === 'user') {
        services.memory.delete(meta.key);
        vscode.window.showInformationMessage(`ADO Code: deleted user memory "${meta.key}".`);
      } else {
        services.workspaceMemory.delete(meta.key);
        vscode.window.showInformationMessage(`ADO Code: deleted workspace memory "${meta.key}".`);
      }
      statusProvider.refreshLight();
    }),
    vscode.commands.registerCommand('adoCode.moveToWorkspaceMemory', (item: any) => {
      const meta = item?.meta;
      if (!meta || meta.source !== 'user') return;
      services.workspaceMemory.write(meta.key, meta.content);
      services.memory.delete(meta.key);
      vscode.window.showInformationMessage(`ADO Code: moved "${meta.key}" to workspace memory.`);
      statusProvider.refreshLight();
    }),
    vscode.commands.registerCommand('adoCode.moveToUserMemory', (item: any) => {
      const meta = item?.meta;
      if (!meta || meta.source !== 'workspace') return;
      const content = services.workspaceMemory.read(meta.key);
      if (content) {
        services.memory.set(meta.key, 'context', content);
        services.workspaceMemory.delete(meta.key);
        vscode.window.showInformationMessage(`ADO Code: moved "${meta.key}" to user memory.`);
        statusProvider.refreshLight();
      }
    })
  );

  // Agent commands
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.openAgentInTerminal', (item: any) => {
      const meta = item?.meta;
      if (!meta) return;
      const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const terminal = vscode.window.createTerminal({
        name: `${meta.displayName} (${projectRoot})`,
        cwd: projectRoot,
      });
      terminal.show();
      // Type the agent command so user can add their prompt
      terminal.sendText(`${meta.name} `, false);
    }),
    vscode.commands.registerCommand('adoCode.copyAgentName', (item: any) => {
      const meta = item?.meta;
      if (!meta) return;
      vscode.env.clipboard.writeText(meta.name);
      vscode.window.showInformationMessage(`ADO Code: copied "${meta.name}" to clipboard.`);
    })
  );

  // Worktree commands
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.openWorktreeInTerminal', (item: any) => {
      const meta = item?.meta;
      if (!meta?.path) return;
      const terminal = vscode.window.createTerminal({
        name: `Worktree: ${meta.branch}`,
        cwd: meta.path,
      });
      terminal.show();
    }),
    vscode.commands.registerCommand('adoCode.openWorktreeInExplorer', (item: any) => {
      const meta = item?.meta;
      if (!meta?.path) return;
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(meta.path), false);
    }),
    vscode.commands.registerCommand('adoCode.removeWorktree', async (item: any) => {
      const meta = item?.meta;
      if (!meta?.runId) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove worktree for ${meta.branch}? Uncommitted changes will be lost.`,
        'Remove', 'Cancel'
      );
      if (confirm !== 'Remove') return;
      await services.git.removeWorktree(meta.runId);
      vscode.window.showInformationMessage(`ADO Code: worktree ${meta.branch} removed.`);
      statusProvider.refreshLight();
    })
  );

  // Keep services in sync with settings / workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('adoCode')) {
        // Only rebuild services (and re-detect agents) when ADO/org/PAT
        // or agent-relevant config changes. Mode-only changes are debounced.
        const rebuildKeys = [
          'adoCode.adoOrganization',
          'adoCode.adoProject',
          'adoCode.adoPat',
          'adoCode.adoServerUrl',
          'adoCode.mcp.servers',
          'adoCode.agents',
        ];
        const needsRebuild = rebuildKeys.some(k => e.affectsConfiguration(k));
        if (needsRebuild) {
          services = createServices(context);
          chatProvider.setServices(services);
          // Re-subscribe memory events to the new service instances
          wireMemoryEvents(services);
          statusProvider.refresh();
        } else {
          statusProvider.debouncedRefresh();
        }
      }
    })
  );
}

export function deactivate() {}

/**
 * Open the agent's summary in a formatted webview panel in the editor area
 * (beside the active editor), rendered as a nicely formatted HTML page.
 */
async function openSummaryInEditor(
  ctx: vscode.ExtensionContext, run: AgentRun, summary: string
): Promise<void> {
  AgentSummaryPanel.show(ctx, run, summary);
}

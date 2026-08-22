import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { WORK_ITEMS_MODES } from './shared/workItemsMode';
import { StatusPanelProvider } from './webview/StatusPanelProvider';
import { WorktreesTreeProvider } from './webview/WorktreesTreeProvider';
import { WorkItemDetailPanel } from './webview/WorkItemDetailPanel';
import { AgentSummaryPanel } from './webview/AgentSummaryPanel';
import { AgentProgressPanel, agentDisplayName } from './webview/AgentProgressPanel';
import { AgentDetailPanel } from './webview/AgentDetailPanel';
import { WorkItemsTreeProvider, WorkItemNode } from './ado/WorkItemsTreeProvider';
import { createServices, Services } from './services';
import { selectActiveOrganization, getSettings, getActiveOrg } from './config/settings';
import { WorkItemStatesCache } from './ado/WorkItemStatesCache';
import { GitService } from './git/GitService';
import { cleanupMergedRun, hasMergedPullRequest } from './git/mergeCleanup';
import { gitErrorMessage } from './git/gitError';
import { AgentRunner } from './agents/AgentRunner';
import { AgentRun } from './agents/types';
import { logger } from './services/logger';

let chatProvider: ChatViewProvider;
let treeProvider: WorkItemsTreeProvider;

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
    (items) => treeProvider?.refresh(items)
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

  // Worktrees Panel: dedicated view of agent worktrees with per-worktree
  // details (run status, dirty files, last commit, ahead/behind).
  const worktreesProvider = new WorktreesTreeProvider(services);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('adoCode.worktrees', worktreesProvider),
    vscode.commands.registerCommand('adoCode.refreshWorktrees', () => {
      worktreesProvider.refresh();
    }),
    vscode.commands.registerCommand('adoCode.worktreesRemoveAllCompleted', async () => {
      const removed = await worktreesProvider.removeAllCompleted();
      if (removed === 0) {
        vscode.window.showInformationMessage('ADO Code: no completed worktrees to remove.');
      } else {
        vscode.window.showInformationMessage(`ADO Code: removed ${removed} completed worktree(s).`);
      }
    })
  );

  // Post-merge cleanup auto-offer (round-2 guardrail Task 3): when the
  // Worktrees view reloads and a finished run's branch has a completed +
  // merged PR on ADO, offer "Clean Up After Merge" (remove worktree +
  // delete branch). Throttled per run so a refresh storm never hammers ADO.
  const cleanupOfferAt = new Map<string, number>();
  const CLEANUP_OFFER_COOLDOWN_MS = 10 * 60 * 1000; // re-offer once per 10 min
  worktreesProvider.onReloaded = (entries) => {
    void (async () => {
      try {
        const project = getActiveOrg(context, getSettings()).project;
        const now = Date.now();
        for (const e of entries) {
          const run = e.run;
          // Only finished runs with a branch can have a merged PR worth
          // offering cleanup for.
          if (!run?.branch || run.status === 'running') continue;
          const last = cleanupOfferAt.get(run.id) ?? 0;
          if (now - last < CLEANUP_OFFER_COOLDOWN_MS) continue;
          cleanupOfferAt.set(run.id, now);
          const merged = await hasMergedPullRequest(run, project, {
            git: services.git,
            ado: services.ado,
            getRun: (id) => agentRunner.listRuns().find(r => r.id === id),
          });
          if (!merged) continue;
          const pick = await vscode.window.showInformationMessage(
            `ADO Code: PR for ${run.branch} was merged — clean up the worktree?`,
            'Clean Up After Merge', 'Later'
          );
          if (pick === 'Clean Up After Merge') {
            await vscode.commands.executeCommand('adoCode.cleanupWorktree', { meta: { runId: run.id, branch: run.branch } });
          }
        }
      } catch (err) {
        logger.error('Worktrees: post-merge cleanup offer failed', err);
      }
    })();
  };

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

  // Working indicator: status-bar spinner while an LLM turn or agent run is
  // in flight — stays visible when the chat view is hidden/away.
  const workingBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  context.subscriptions.push(workingBar);
  chatProvider.setWorkingStatusBar(workingBar);

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

  // The merged Work Items view shows ONE dataset at a time; the toolbar
  // toggle (adoCode.workItemsToggleMode) switches between My / All /
  // Unassigned. Context menus gate per ITEM (assigned vs unassigned), so
  // Take Ownership etc. work in every mode.
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.workItemsToggleMode', async () => {
      const current = chatProvider.getWorkItemsMode();
      const pick = await vscode.window.showQuickPick(
        WORK_ITEMS_MODES.map(m => ({
          label: m.label,
          description: m.value === current ? '● current' : m.description,
        })),
        { placeHolder: 'Work Items view' }
      );
      if (!pick) return; // cancelled
      const mode = WORK_ITEMS_MODES.find(m => m.label === pick.label);
      if (mode) {
        // Update the header row immediately, then refetch the dataset.
        treeProvider.setMode(mode.value);
        await chatProvider.setWorkItemsMode(mode.value);
      }
    })
  );

  // Register command to refresh work items
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.refreshWorkItems', () => {
      chatProvider.refreshWorkItems();
    })
  );

  // ── Work Item Filters ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.workItemsFilter', async () => {
      // Gather all work items from the provider's internal list via a
      // temporary snapshot. We call refresh with the same data to get
      // a fresh snapshot — the provider stores them internally.
      // Instead, we peek at what's available by reading the unfiltered
      // count from the tree. Since the provider doesn't expose the raw
      // array, we temporarily clear filters to collect unique values.
      const hasFilters = treeProvider.hasActiveFilters();
      if (hasFilters) {
        treeProvider.clearFilters();
      }

      // We need the full item list. Ask chatProvider to re-fetch,
      // which will call treeProvider.refresh() and populate it.
      // Instead, use a simpler approach: capture items via refreshWorkItems
      // and read unique values after it settles. But that's async.
      // Best approach: add a method to get unique values.
      // For now, we'll use a helper that reads from the provider.
      const allItems = treeProvider.getUniqueFilterValues();

      if (allItems.length === 0) {
        vscode.window.showInformationMessage('ADO Code: No work items loaded. Refresh first.');
        return;
      }

      // Collect unique states and types
      const allStates = [...new Set(allItems.map(i => i.state))].sort();
      const allTypes = [...new Set(allItems.map(i => i.workItemType))].sort();

      // Step 1: Pick states
      const stateItems: vscode.QuickPickItem[] = [
        { label: '$(check) All States', description: 'Show all states (clear filter)' },
        ...allStates.map(s => ({
          label: s,
          picked: treeProvider.getActiveFilters().states.length === 0 ||
                  treeProvider.getActiveFilters().states.includes(s),
        })),
      ];
      const pickedStates = await vscode.window.showQuickPick(stateItems, {
        placeHolder: 'Select work item states to show',
        canPickMany: true,
        matchOnDescription: true,
      });
      if (pickedStates === undefined) return; // cancelled

      // Step 2: Pick types
      const typeItems: vscode.QuickPickItem[] = [
        { label: '$(check) All Types', description: 'Show all types (clear filter)' },
        ...allTypes.map(t => ({
          label: t,
          picked: treeProvider.getActiveFilters().types.length === 0 ||
                  treeProvider.getActiveFilters().types.includes(t),
        })),
      ];
      const pickedTypes = await vscode.window.showQuickPick(typeItems, {
        placeHolder: 'Select work item types to show',
        canPickMany: true,
        matchOnDescription: true,
      });
      if (pickedTypes === undefined) return; // cancelled

      // Apply state filter
      const hasAllStates = pickedStates.some(p => p.label === '$(check) All States');
      const selectedStates = hasAllStates
        ? []
        : pickedStates.map(p => p.label).filter(l => l !== '$(check) All States');
      treeProvider.setFilterState(selectedStates);

      // Apply type filter
      const hasAllTypes = pickedTypes.some(p => p.label === '$(check) All Types');
      const selectedTypes = hasAllTypes
        ? []
        : pickedTypes.map(p => p.label).filter(l => l !== '$(check) All Types');
      treeProvider.setFilterType(selectedTypes);

      // Show info
      const total = allItems.length;
      const showing = treeProvider.getVisibleCount();
      if (treeProvider.hasActiveFilters()) {
        vscode.window.showInformationMessage(
          `ADO Code: Showing ${showing} of ${total} work items (filtered)`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.workItemsSearch', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Filter work items by title',
        placeHolder: 'Type to search work item titles...',
        value: treeProvider.getActiveFilters().text,
      });
      if (text === undefined) return; // cancelled

      treeProvider.setFilterText(text);

      if (text.length > 0) {
        const allItems = treeProvider.getUniqueFilterValues();
        const total = allItems.length;
        const showing = treeProvider.getVisibleCount();
        vscode.window.showInformationMessage(
          `ADO Code: Showing ${showing} of ${total} work items matching "${text}"`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.workItemsClearFilters', () => {
      treeProvider.clearFilters();
      vscode.window.showInformationMessage('ADO Code: all work item filters cleared.');
    })
  );

  // Task 9: tree-item commands (node-first signature — H4). The methods they
  // dispatch to land in Task 10 (startTask) and Task 13 (selectWorkItem).
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.selectWorkItem', (node: WorkItemNode) => {
      chatProvider.selectWorkItem(node.workItemId);
      // Highlight the selected item in the tree
      treeProvider.setSelected(node.workItemId);
      // Show the title-bar + context-menu "Deselect Work Item" affordances
      // only while a selection exists (keeps the cramped view title bar clean).
      void vscode.commands.executeCommand('setContext', 'adoCode.workItemSelected', true);
    }),
    vscode.commands.registerCommand('adoCode.unselectWorkItem', () => {
      chatProvider.clearActiveWorkItem();
      treeProvider.setSelected(undefined);
      void vscode.commands.executeCommand('setContext', 'adoCode.workItemSelected', false);
      vscode.window.showInformationMessage('ADO Code: work item deselected.');
    }),
    vscode.commands.registerCommand('adoCode.startTask', (node: WorkItemNode) => {
      chatProvider.startTask(node.workItemId, node.workItemTitle);
    }),
    vscode.commands.registerCommand('adoCode.generateTasks', (node: WorkItemNode) => {
      // First select the work item so the AI has context, then inject the
      // generate-tasks prompt into the chat.
      chatProvider.selectWorkItem(node.workItemId);
      treeProvider.setSelected(node.workItemId);
      void vscode.commands.executeCommand('setContext', 'adoCode.workItemSelected', true);
      const msg = `Generate child tasks for the active user story: #${node.workItemId} — "${node.workItemTitle}". Read the user story details (description, acceptance criteria) using get_work_item. Break it down into actionable child work items (Tasks, Bugs, etc.).

IMPORTANT: Do NOT use the create_work_item tool. Instead, output a JSON block under a "## PROPOSED_TASKS" heading with all proposed tasks. Format:
## PROPOSED_TASKS
\`\`\`json
[
  {
    "workItemType": "Task",
    "title": "Task title",
    "description": "Detailed description",
    "acceptanceCriteria": "Criteria",
    "assignedTo": "",
    "tags": ""
  }
]
\`\`\`

First analyze the user story and explain your breakdown reasoning, then output the PROPOSED_TASKS JSON block. The user will review and select which tasks to create.`;
      chatProvider.injectChatMessage(msg);
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

  // ── Memory Search: QuickPick to search/filter all memory entries ──
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.memorySearch', async () => {
      const items: (vscode.QuickPickItem & { detail?: string })[] = [];

      // User memories
      for (const entry of services.memory.getAll()) {
        items.push({
          label: `[${entry.category}] ${entry.key}`,
          description: entry.content.substring(0, 80),
          detail: entry.content,
        });
      }

      // Workspace memories
      for (const key of services.workspaceMemory.list()) {
        const content = services.workspaceMemory.read(key) ?? '';
        items.push({
          label: `[workspace] ${key}`,
          description: content.substring(0, 80),
          detail: content,
        });
      }

      if (items.length === 0) {
        vscode.window.showInformationMessage('No memory entries stored.');
        return;
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Search memories...',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (picked?.detail) {
        vscode.window.showInformationMessage(picked.detail, { modal: true });
      }
    })
  );

  // ── Memory Import/Export ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.memoryExport', async () => {
      // Gather all user memories
      const userEntries = services.memory.getAll();

      // Gather all workspace memories
      const workspaceKeys = services.workspaceMemory.list();
      const workspaceEntries: Record<string, string> = {};
      for (const key of workspaceKeys) {
        const value = services.workspaceMemory.read(key);
        if (value !== null) {
          workspaceEntries[key] = value;
        }
      }

      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        userMemory: userEntries,
        workspaceMemory: workspaceEntries,
      };

      // Show save dialog
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('ado-code-memory.json'),
        filters: { 'JSON': ['json'] },
      });

      if (!uri) return; // cancelled

      try {
        const json = JSON.stringify(exportData, null, 2);
        fs.writeFileSync(uri.fsPath, json, 'utf8');
        vscode.window.showInformationMessage(
          `Exported ${userEntries.length} user + ${workspaceKeys.length} workspace memories`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to export memories: ${err instanceof Error ? err.message : err}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.memoryImport', async () => {
      // Show open dialog
      const uris = await vscode.window.showOpenDialog({
        filters: { 'JSON': ['json'] },
        canSelectFiles: true,
        canSelectMany: false,
      });

      if (!uris || uris.length === 0) return; // cancelled

      const filePath = uris[0].fsPath;

      // Read and parse the JSON file
      let data: any;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        data = JSON.parse(content);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to read JSON file: ${err instanceof Error ? err.message : err}`
        );
        return;
      }

      // Validate structure
      if (!data.version || (!data.userMemory && !data.workspaceMemory)) {
        vscode.window.showErrorMessage(
          'Invalid memory file: missing version or memory data'
        );
        return;
      }

      // Choose import mode
      const importMode = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Keep existing memories, add/update from file' },
          { label: 'Replace', description: 'Clear existing memories first, then import' },
        ],
        { placeHolder: 'How should memories be imported?' }
      );

      if (!importMode) return; // cancelled

      // If replace mode, clear existing memories first
      if (importMode.label === 'Replace') {
        services.memory.clear();
      }

      // Import user memories
      let userImported = 0;
      if (Array.isArray(data.userMemory)) {
        for (const entry of data.userMemory) {
          if (entry.key && entry.category && entry.content) {
            services.memory.set(entry.key, entry.category, entry.content);
            userImported++;
          }
        }
      }

      // Import workspace memories
      let wsImported = 0;
      if (data.workspaceMemory && typeof data.workspaceMemory === 'object') {
        for (const [key, value] of Object.entries(data.workspaceMemory)) {
          if (typeof value === 'string') {
            services.workspaceMemory.write(key, value);
            wsImported++;
          }
        }
      }

      // Refresh status panel
      statusProvider.refreshLight();

      vscode.window.showInformationMessage(
        `Imported ${userImported} user + ${wsImported} workspace memories`
      );
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

  // ── Cycle Mode: right-click on Status Mode item ─────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.cycleMode', async () => {
      const cycle = ['inline', 'plan', 'act'] as const;
      const current = getSettings().mode;
      const idx = cycle.indexOf(current as typeof cycle[number]);
      const next = cycle[(idx + 1) % cycle.length];
      const config = vscode.workspace.getConfiguration('adoCode');
      await config.update('mode', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Mode: ${next}`);
      statusProvider.refreshLight();
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

  // Take Ownership (Unassigned items, any mode): assign the item to the
  // authenticated user, then refresh the tree (in Unassigned mode it moves
  // out of the pool; in All mode it just gains an assignee).
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

  // Reassign To… (any mode): pick a project member, reassign, refresh.
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
  // Last observed status per run id — drives the working indicator on
  // transitions (running → spin, terminal → stop) without reacting to every
  // streamed chunk.
  const agentRunStatus = new Map<string, string>();
  // Runs whose live progress panel was auto-opened (progressView = 'editor') —
  // open ONCE per run so a user-closed panel does not keep popping back.
  const autoOpenedProgress = new Set<string>();
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
        // Working indicator: only on status TRANSITIONS (onStatus also fires
        // per streamed chunk) — running → spin, terminal → stop.
        const prevStatus = agentRunStatus.get(run.id);
        if (prevStatus !== run.status) {
          agentRunStatus.set(run.id, run.status);
          chatProvider.setWorking(run.status === 'running');
        }
        // Worktrees view: reload only when the run status actually changes
        // (start / cancel / complete) — cheap guard per streamed chunk.
        worktreesProvider.refreshIfChanged(run);
        // Live editor progress panel: stream every chunk into the open panel
        // (cheap no-op when closed). With adoCode.agents.progressView='editor'
        // auto-open the panel once per run so progress is visible outside the
        // chat sidebar; a user-closed panel does not pop back (autoOpened set).
        try {
          AgentProgressPanel.update(run, delta);
          const progressView = vscode.workspace.getConfiguration('adoCode').get<string>('agents.progressView', 'chat');
          if (progressView === 'editor' && run.status === 'running' && !autoOpenedProgress.has(run.id)) {
            autoOpenedProgress.add(run.id);
            AgentProgressPanel.show(context, run, agentRunner.getRunOutput(run.id));
          }
        } catch {
          // Panel failures must never break the run stream.
        }
      },
      onComplete: (run, summary) => {
        chatProvider.postMessage({ type: 'agentResult', run, summary });
        // Clear agent status from tree view
        if (run.workItemId) {
          treeProvider.updateAgentStatus(run.workItemId, run.agent, 'completed');
        }
        // Editor-area result display: when a LIVE progress panel is open for
        // this run (auto-opened in 'editor' mode or opened manually from the
        // chat panel / command), the summary renders inside that panel. In
        // 'chat' mode (or when the live panel was never opened) show the
        // static summary panel as before.
        try {
          if (AgentProgressPanel.has(run.id)) {
            AgentProgressPanel.complete(run, summary);
          } else {
            const progressView = vscode.workspace.getConfiguration('adoCode').get<string>('agents.progressView', 'chat');
            if (progressView !== 'editor') {
              void openSummaryInEditor(context, run, summary);
            }
          }
        } catch {
          // Panel failures must never break the completion flow.
        }
        // Terminal status → stop the working indicator (covers cancel paths
        // where no onStatus transition was observed).
        const prevStatus = agentRunStatus.get(run.id);
        if (prevStatus !== run.status) {
          agentRunStatus.set(run.id, run.status);
          chatProvider.setWorking(run.status === 'running');
        }
        worktreesProvider.refreshIfChanged(run);
        // Auto-review: stream an LLM code review for succeeded runs.
        if (run.status === 'succeeded') {
          void chatProvider.reviewAgentRun(run);
        }
      },
    },
    {
      save: runs => context.workspaceState.update('adoCode.agentRuns', runs),
      load: () => context.workspaceState.get<import('./agents/types').AgentRun[]>('adoCode.agentRuns', []),
      saveDismissed: ids => context.workspaceState.update('adoCode.dismissedAgentRuns', ids),
      loadDismissed: () => context.workspaceState.get<string[]>('adoCode.dismissedAgentRuns', []),
    },
    // Memory-driven pre/post agent hooks (workspace memory `agent.before` /
    // `agent.after`) — run shell commands around each agent invocation.
    services.workspaceMemory
  );
  chatProvider.setAgentRunner(agentRunner);
  worktreesProvider.setAgentRunner(agentRunner);
  statusProvider.setAgentRunner(agentRunner);

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
    }),
    vscode.commands.registerCommand('adoCode.agentViewDetail', (item: any) => {
      const meta = item?.meta;
      if (!meta?.name) return;
      const agentName = meta.name as import('./agents/types').AgentName;
      services.agents.detect().then(capabilities => {
        const capability = capabilities.find(c => c.name === agentName);
        if (capability) {
          AgentDetailPanel.show(agentName, capability);
        } else {
          vscode.window.showWarningMessage(`ADO Code: agent "${agentName}" not found.`);
        }
      });
    })
  );

  // Run commands
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.runViewSummary', (item: any) => {
      const meta = item?.meta;
      if (!meta) return;
      const summary = meta.summary;
      if (summary) {
        vscode.window.showInformationMessage(`Summary: ${summary}`);
      } else {
        vscode.window.showInformationMessage('No summary available');
      }
    }),
    vscode.commands.registerCommand('adoCode.runOpenWorktree', (item: any) => {
      const meta = item?.meta;
      if (!meta?.worktreePath) return;
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(meta.worktreePath), false);
    }),
    vscode.commands.registerCommand('adoCode.runCopyId', (item: any) => {
      const meta = item?.meta;
      if (!meta) return;
      vscode.env.clipboard.writeText(meta.runId);
      vscode.window.showInformationMessage(`ADO Code: copied run ID "${meta.runId}" to clipboard.`);
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
    vscode.commands.registerCommand('adoCode.commitWorktree', async (item: any) => {
      const meta = item?.meta;
      if (!meta?.runId) return;
      const run = agentRunner.listRuns().find(r => r.id === meta.runId);
      const msg = `ADO-${run?.workItemId ?? '?'}: ${run?.title || 'agent changes'}`;
      try {
        const commit = await services.git.commitWorktreeChanges(meta.runId, msg);
        if (!commit.committed) {
          vscode.window.showInformationMessage(`ADO Code: nothing to commit in ${meta.branch} (worktree is clean).`);
          return;
        }
        const push = await services.git.pushWorktreeBranch(meta.runId);
        if (!push.pushed) {
          vscode.window.showWarningMessage(`ADO Code: committed ${commit.hash ?? ''} but push failed — ${push.reason}`);
          return;
        }
        vscode.window.showInformationMessage(
          `ADO Code: committed ${commit.hash ?? ''} and pushed ${push.branch} → origin.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`ADO Code: commit/push failed — ${gitErrorMessage(err, services.git.resolveWorktreePath(meta.runId))}`);
      } finally {
        worktreesProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('adoCode.removeWorktree', async (item: any) => {
      const meta = item?.meta;
      if (!meta?.runId) return;
      // Guardrail: removing a worktree with uncommitted changes discards the
      // agent's work. Offer Commit & Push first; only remove anyway on
      // explicit choice; delete the branch afterwards only if it was merged.
      let dirty = false;
      try {
        dirty = (await services.git.getWorktreeInfoForRun(meta.runId)).dirty;
      } catch {
        // Worktree may not exist as a git worktree — fall through.
      }
      if (dirty) {
        const pick = await vscode.window.showWarningMessage(
          `Worktree ${meta.branch} has UNCOMMITTED changes — removing it will discard them.`,
          'Commit & Push, then Remove', 'Remove Anyway', 'Cancel'
        );
        if (!pick || pick === 'Cancel') return;
        if (pick === 'Commit & Push, then Remove') {
          const run = agentRunner.listRuns().find(r => r.id === meta.runId);
          const msg = `ADO-${run?.workItemId ?? '?'}: ${run?.title || 'agent changes'}`;
          try {
            const commit = await services.git.commitWorktreeChanges(meta.runId, msg);
            if (commit.committed) {
              await services.git.pushWorktreeBranch(meta.runId);
            }
          } catch (err) {
            vscode.window.showErrorMessage(`ADO Code: commit/push before remove failed — ${gitErrorMessage(err, services.git.resolveWorktreePath(meta.runId))}`);
            return;
          }
        }
      }
      await services.git.removeWorktree(meta.runId);
      // Branch cleanup: only when fully merged into the base (safe).
      const deleted = await services.git.deleteBranchIfMerged(meta.branch);
      vscode.window.showInformationMessage(
        `ADO Code: worktree ${meta.branch} removed.${deleted ? ' Merged branch deleted.' : ' Branch kept (not merged).'}`
      );
      statusProvider.refreshLight();
      worktreesProvider.refresh();
    }),
    // Post-merge cleanup: remove the worktree + delete the branch when the
    // run's PR was completed and merged on ADO. Invoked from the Worktrees
    // view context menu ("Clean Up After Merge") and the auto-offer below.
    vscode.commands.registerCommand('adoCode.cleanupWorktree', async (item: any) => {
      const meta = item?.meta;
      if (!meta?.runId) return;
      try {
        const project = getActiveOrg(context, getSettings()).project;
        const result = await cleanupMergedRun(meta.runId, project, {
          git: services.git,
          ado: services.ado,
          getRun: (id) => agentRunner.listRuns().find(r => r.id === id),
        });
        if (!result.cleaned) {
          vscode.window.showInformationMessage(`ADO Code: nothing to clean up — ${result.reason}`);
          return;
        }
        vscode.window.showInformationMessage(
          `ADO Code: worktree ${meta.branch ?? ''} removed.${result.branchDeleted ? ' Merged branch deleted.' : ' Branch kept (not merged).'}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`ADO Code: cleanup failed — ${gitErrorMessage(err, services.git.resolveWorktreePath(meta.runId))}`);
      } finally {
        statusProvider.refreshLight();
        worktreesProvider.refresh();
      }
    }),
    // Re-open the agent summary editor panel for a finished run (e.g. from
    // the Worktrees view context menu after the panel was closed).
    vscode.commands.registerCommand('adoCode.showAgentOutput', (item: any) => {
      const runId = typeof item === 'string' ? item : item?.meta?.runId ?? item?.runId;
      const run = agentRunner.listRuns().find(r => r.id === runId);
      if (!run) {
        vscode.window.showInformationMessage('ADO Code: agent run not found.');
        return;
      }
      if (!run.summary) {
        vscode.window.showInformationMessage('ADO Code: no summary captured for this run.');
        return;
      }
      AgentSummaryPanel.show(context, run, run.summary);
    }),
    // Open the LIVE progress panel in the editor area — from the palette
    // (QuickPick of active + recent runs) or with an explicit run id / item
    // (context menus). Works for running runs (streaming view) and finished
    // runs (summary inside the same panel).
    vscode.commands.registerCommand('adoCode.openAgentProgress', async (item?: any) => {
      let runId = typeof item === 'string' ? item : item?.meta?.runId ?? item?.runId;
      if (!runId) {
        const runs = agentRunner.listRuns().sort((a, b) => {
          if (a.status === 'running' && b.status !== 'running') return -1;
          if (b.status === 'running' && a.status !== 'running') return 1;
          return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
        });
        if (runs.length === 0) {
          vscode.window.showInformationMessage('ADO Code: no agent runs yet — delegate a work item first.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          runs.map(r => ({
            label: `🤖 ${agentDisplayName(r.agent)} — ADO-${r.workItemId ?? '?'} (${r.status})`,
            description: r.branch ?? '',
            detail: r.id,
          })),
          { placeHolder: 'Select an agent run to open its live progress panel' }
        );
        if (!pick) return;
        runId = pick.detail;
      }
      const run = agentRunner.listRuns().find(r => r.id === runId);
      if (!run) {
        vscode.window.showInformationMessage('ADO Code: agent run not found.');
        return;
      }
      AgentProgressPanel.show(context, run, agentRunner.getRunOutput(run.id));
    })
  );

  // Worktree Show Changes: open VS Code diff editor for changed files
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.worktreeShowChanges', async (item: any) => {
      const meta = item?.meta;
      const worktreePath = meta?.path ?? meta?.worktreePath;
      if (!worktreePath) {
        vscode.window.showWarningMessage('ADO Code: no worktree path available for this item.');
        return;
      }

      const workspaceRoot = services.git.workspaceRoot;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('ADO Code: no workspace root available.');
        return;
      }

      try {
        // Get changed files in the worktree (uncommitted + untracked)
        const statusOutput = await services.git.gitInWorktree(worktreePath, [
          'status', '--porcelain', '--no-renames',
        ]);
        if (!statusOutput.trim()) {
          vscode.window.showInformationMessage('ADO Code: no changes in this worktree.');
          return;
        }

        // Parse porcelain status: "XY filename" (2-char status + space + path)
        const files: Array<{ status: string; filePath: string }> = [];
        for (const line of statusOutput.split('\n')) {
          if (!line.trim()) continue;
          const status = line.substring(0, 2).trim();
          const filePath = line.substring(3).trim();
          if (filePath && !filePath.endsWith('/')) {
            files.push({ status, filePath });
          }
        }

        if (files.length === 0) {
          vscode.window.showInformationMessage('ADO Code: no changes in this worktree.');
          return;
        }

        // For a single file, open diff directly
        if (files.length === 1) {
          const f = files[0];
          const baseUri = vscode.Uri.file(path.join(workspaceRoot, f.filePath));
          const worktreeUri = vscode.Uri.file(path.join(worktreePath, f.filePath));
          const title = `${f.filePath} — worktree changes`;
          if (f.status === 'A') {
            // New file: show empty vs worktree
            await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(''), worktreeUri, title);
          } else {
            await vscode.commands.executeCommand('vscode.diff', baseUri, worktreeUri, title);
          }
          return;
        }

        // Multiple files: show QuickPick to select which file to diff
        const items: (vscode.QuickPickItem & { filePath: string; status: string })[] = files.map(f => {
          const statusLabel = f.status === 'A' ? '+ Added' :
            f.status === 'D' ? '- Deleted' :
            f.status === 'M' ? '~ Modified' :
            f.status === '??' ? '? Untracked' :
            f.status;
          return {
            label: f.filePath,
            description: statusLabel,
            filePath: f.filePath,
            status: f.status,
          };
        });

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `${files.length} file(s) changed — pick a file to diff`,
          matchOnDescription: true,
        });

        if (!picked) return;

        const baseUri = vscode.Uri.file(path.join(workspaceRoot, picked.filePath));
        const worktreeUri = vscode.Uri.file(path.join(worktreePath, picked.filePath));
        const title = `${picked.filePath} — worktree changes`;
        if (picked.status === 'A') {
          await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(''), worktreeUri, title);
        } else {
          await vscode.commands.executeCommand('vscode.diff', baseUri, worktreeUri, title);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `ADO Code: failed to show worktree changes — ${err instanceof Error ? err.message : err}`
        );
      }
    })
  );

  // MCP server commands (Status Panel context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.mcpDisconnect', async (item: any) => {
      const meta = item?.meta;
      if (!meta?.name) return;
      const disconnected = await services.mcp.disconnectServer(meta.name);
      if (disconnected) {
        vscode.window.showInformationMessage(`ADO Code: disconnected from MCP server "${meta.name}".`);
      } else {
        vscode.window.showWarningMessage(`ADO Code: MCP server "${meta.name}" not found.`);
      }
      statusProvider.refreshLight();
    }),
    vscode.commands.registerCommand('adoCode.mcpReconnect', async (item: any) => {
      const meta = item?.meta;
      if (!meta?.name) return;
      vscode.window.showInformationMessage(`ADO Code: reconnecting to MCP server "${meta.name}"...`);
      const success = await services.mcp.reconnectServer(meta.name);
      if (success) {
        vscode.window.showInformationMessage(`ADO Code: reconnected to MCP server "${meta.name}".`);
      } else {
        vscode.window.showErrorMessage(`ADO Code: failed to reconnect to MCP server "${meta.name}".`);
      }
      statusProvider.refreshLight();
    }),
    vscode.commands.registerCommand('adoCode.mcpViewDetails', (item: any) => {
      const meta = item?.meta;
      if (!meta?.name) return;
      const config = services.mcp.getServerConfig(meta.name);
      if (!config) {
        vscode.window.showWarningMessage(`ADO Code: no configuration found for MCP server "${meta.name}".`);
        return;
      }
      const details = [
        `Name: ${config.name}`,
        `Command: ${config.command}`,
        `Args: ${(config.args ?? []).join(' ') || '(none)'}`,
        `Timeout: ${config.timeout ?? 30000}ms`,
        config.env ? `Env: ${Object.keys(config.env).join(', ')}` : 'Env: (none)',
      ].join('\n');
      vscode.window.showInformationMessage(details, { modal: true });
    })
  );

  // ── Right-click context menu: send to chat ──────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.sendSelectionToChat', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('ADO Code: No active editor.');
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showWarningMessage('ADO Code: No text selected.');
        return;
      }
      chatProvider.sendTextToChat("```\n" + selection + "\n```");
    }),
    vscode.commands.registerCommand('adoCode.sendFileToChat', async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showWarningMessage('ADO Code: No file selected.');
        return;
      }
      try {
        const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const fileName = uri.path.split('/').pop() || uri.path;
        chatProvider.sendFileToChat(fileName, content);
      } catch (err) {
        vscode.window.showErrorMessage(`ADO Code: Failed to read file: ${err instanceof Error ? err.message : err}`);
      }
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

  // ── Show changelog once after package update ────────────────────
  const currentVersion = context.extension.packageJSON.version as string;
  const lastSeenVersion = context.globalState.get<string>('adoCode.lastSeenVersion', '');
  if (lastSeenVersion && lastSeenVersion !== currentVersion) {
    try {
      const changelogPath = path.join(context.extensionPath, 'CHANGELOG.md');
      const changelog = fs.readFileSync(changelogPath, 'utf8');
      // Find the section for the current version
      const versionRegex = new RegExp(`## \\[${currentVersion.replace(/\./g, '\\.')}\\]([\\s\\S]*?)(?=## \\[|$)`);
      const match = changelog.match(versionRegex);
      if (match) {
        const entry = match[1].trim();
        const action = await vscode.window.showInformationMessage(
          `ADO Code updated to ${currentVersion}`,
          'Show Changelog',
          'Dismiss'
        );
        if (action === 'Show Changelog') {
          const panel = vscode.window.createWebviewPanel(
            'adoCodeChangelog',
            `ADO Code ${currentVersion} — What's New`,
            vscode.ViewColumn.One,
            { enableScripts: false }
          );
          panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; line-height: 1.6; }
    h2 { color: var(--vscode-charts-green); }
    h3 { margin-top: 16px; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; }
    strong { color: var(--vscode-charts-blue); }
  </style>
</head>
<body>
  <h2>ADO Code ${currentVersion}</h2>
  ${entry.split('\n').map(line => {
    if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
    if (line.startsWith('- **')) return `<li>${line.slice(2).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</li>`;
    if (line.startsWith('- ')) return `<li>${line.slice(2)}</li>`;
    return '';
  }).join('\n')}
</body>
</html>`;
        }
      }
    } catch {
      // Changelog read failed — silently skip
    }
  }
  // Always update the stored version
  await context.globalState.update('adoCode.lastSeenVersion', currentVersion);
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

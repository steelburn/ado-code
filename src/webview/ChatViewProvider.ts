import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { WebviewToExtensionMessage, WorkItemSummary, WorkItemContext } from '../shared/messages';
import { Services } from '../services';
import { getSettings, getActiveOrg, llmConfigFromSettings } from '../config/settings';
import { LlmClient } from '../llm/client';
import { LlmMessage } from '../llm/types';
import { buildSystemPrompt, buildAgentPrompt } from '../llm/prompts';
import { createToolExecutor, ToolExecutor } from '../llm/tools';
import { runAgenticChat } from '../llm/agentic';
import { AgentRunner } from '../agents/AgentRunner';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'adoCode.chat';
  private _view?: vscode.WebviewView;
  // Task 24 (H5): wired via setAgentRunner AFTER both exist (services built
  // before the provider in activate()).
  private agentRunner?: AgentRunner;
  private executor?: ToolExecutor;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly services: Services,
    // H11: the provider needs ExtensionContext for workspaceState (Q4 history,
    // org switching) and for the tree-refresh callback (C7).
    private readonly _context: vscode.ExtensionContext,
    private readonly onItemsFetched?: (items: any[]) => void
  ) {}

  /** C10: swap the services bundle after org switch / config change. */
  public setServices(services: Services): void {
    (this as any).services = services;
    // H-5 fix: rebuild the executor too — it captured the OLD services closure.
    if (this.agentRunner) this.setAgentRunner(this.agentRunner);
  }

  /** H10 fix: wire the tool executor concretely once the runner exists. */
  public setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
    // Executor depends on the runner — build it once both are available.
    this.executor = createToolExecutor(this.services, this._context, {
      onUpdateState: (id, state) => this.updateWorkItemState(id, state),
      onDelegate: (prompt, agent) => this.delegateToAgent(prompt, agent),
      onApprove: async (name, args) => {
        const pick = await vscode.window.showQuickPick(['Approve', 'Reject'], {
          placeHolder: `Allow tool '${name}' with ${JSON.stringify(args)}?`,
        });
        return pick === 'Approve';
      },
    });
    this.executor.setMode(getSettings().mode);
  }

  /** Task 24 (M-4): delegate to an external agent; result streams async via webview. */
  async delegateToAgent(prompt: string, agent?: string): Promise<string> {
    if (!this.agentRunner) throw new Error('agent runner not wired');
    if (!this.activeWorkItem) throw new Error('select a work item first');
    const run = await this.agentRunner.delegate(this.activeWorkItem.id, prompt, agent as any);
    // Result is delivered async via agentStatus/agentResult messages; return a
    // placeholder so the tool executor sees the run started.
    return JSON.stringify({ ok: true, runId: run.id, status: run.status });
  }

  /** Task 24: agent-related message handlers. */
  public async handleAgentMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'delegateToAgent':
        await this.delegateToAgent(message.prompt, message.agent);
        break;
      case 'agentFollowUp': {
        // Empty runId from the webview means "most recent run".
        let runId = message.runId;
        if (!runId) {
          const runs = this.agentRunner?.listRuns() ?? [];
          const last = runs[runs.length - 1];
          if (!last) break;
          runId = last.id;
        }
        await this.agentRunner?.followUp(runId, message.prompt);
        break;
      }
      case 'agentCancel':
        this.agentRunner?.cancel(message.runId);
        break;
      case 'listAgents': {
        const agents = await this.services.agents.detect();
        this.postMessage({ type: 'agentList', agents });
        break;
      }
    }
  }

  /** H-4 fix: resolve the ACTIVE project from workspaceState (org switch). */
  private activeProject(): string {
    return getActiveOrg(this._context, getSettings()).project;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Task 19: React app decides welcome-vs-chat from the sanitized config payload
    this.postMessage({ type: 'config', config: this._sanitizedConfig() });

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'userMessage':
            await this.handleUserMessage(message.content);
            break;
          case 'fetchWorkItems':
            await this.refreshWorkItems();
            break;
          case 'getConfig':
            this.postMessage({ type: 'config', config: this._sanitizedConfig() });
            break;
          case 'updateConfig':
            await this.applyConfigUpdate(message.config);
            this.postMessage({ type: 'config', config: this._sanitizedConfig() });
            break;
          case 'delegateToAgent':
          case 'agentFollowUp':
          case 'agentCancel':
          case 'listAgents':
            await this.handleAgentMessage(message);
            break;
        }
      },
      undefined,
      []
    );
  }

  public postMessage(message: any) {
    this._view?.webview.postMessage(message);
  }

  /** Task 19: never send adoPat/llmApiKey to the webview — secrets stay in the host. */
  private _sanitizedConfig() {
    const s = getSettings();
    return {
      adoOrganization: s.adoOrganization,
      adoProject: s.adoProject,
      llmProvider: s.llmProvider,
      llmApiUrl: s.llmApiUrl,
      llmModel: s.llmModel,
      configured: Boolean(s.adoOrganization && s.adoProject && s.adoPat && s.llmApiKey),
    };
  }

  /** Task 19: persist config from the welcome screen (never echo secrets back). */
  private async applyConfigUpdate(config: any): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('adoCode');
    const keys: Array<[string, string]> = [
      ['adoOrganization', 'adoOrganization'],
      ['adoProject', 'adoProject'],
      ['adoPat', 'adoPat'],
      ['llmProvider', 'llmProvider'],
      ['llmApiUrl', 'llmApiUrl'],
      ['llmApiKey', 'llmApiKey'],
      ['llmModel', 'llmModel'],
      ['git.requireGitRepo', 'gitRequireGitRepo'],
      ['git.createBranchOnTaskStart', 'gitCreateBranchOnTaskStart'],
      ['changelog.enabled', 'changelogEnabled'],
      ['changelog.postToAdo', 'changelogPostToAdo'],
    ];
    for (const [settingKey, prop] of keys) {
      const value = (config as any)[prop];
      if (value !== undefined) {
        await cfg.update(settingKey, value, vscode.ConfigurationTarget.Global);
      }
    }
  }

  async refreshWorkItems(): Promise<void> {
    // C10 fix: resolve the ACTIVE org from workspaceState (getActiveOrg), not raw settings.
    const active = getActiveOrg(this._context, getSettings());
    if (!active.name || !getSettings().adoPat || !active.project) {
      vscode.window.showWarningMessage('ADO Code: configure organization, project and PAT first.');
      return;
    }
    this.postMessage({ type: 'loading', loading: true });
    try {
      const items = await this.services.ado.getWorkItemsAssignedTo(active.project);
      // M5 fix: map AdoWorkItem → WorkItemSummary (protocol shape) before posting.
      const summaries: WorkItemSummary[] = items.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] ?? '',
        state: i.fields['System.State'] ?? '',
        assignedTo: i.fields['System.AssignedTo']?.displayName ?? '',
        workItemType: i.fields['System.WorkItemType'] ?? '',
      }));
      // To webview (chat / task list)
      this.postMessage({ type: 'workItems', items: summaries });
      // To the sidebar tree view (built in Task 9) — via injected callback (C7)
      this.onItemsFetched?.(summaries);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(`ADO Code: ${message}`);
    } finally {
      this.postMessage({ type: 'loading', loading: false });
    }
  }

  // C-4 fix: declared HERE (Task 10), once — Tasks 11/13 refine it but must
  // NOT re-declare (TS2300 duplicate member).
  private activeWorkItem?: WorkItemContext;

  /** H3: git pre-flight shared by startTask (Task 10) and startTaskWithAgent (Task 25).
   *  Returns true if it's safe to proceed. */
  private async ensureGitReady(workItemId: number): Promise<boolean> {
    const settings = getSettings();
    // 1) Git repo required?
    if (settings.gitRequireGitRepo && !(await this.services.git.isGitRepo())) {
      vscode.window.showWarningMessage('ADO Code requires a git-enabled workspace. Open a folder inside a git repository to pick up tasks.');
      return false;
    }
    // 2) Uncommitted changes?
    if (settings.gitRequireCleanTree && await this.services.git.hasUncommittedChanges()) {
      const choice = await vscode.window.showWarningMessage('ADO Code: you have uncommitted changes. Switch branches anyway?', { modal: true }, 'Yes');
      if (choice !== 'Yes') return false;
    }
    // 3) Create the task branch
    if (settings.gitCreateBranchOnTaskStart) {
      const title = this.activeWorkItem?.title ?? `Work item ${workItemId}`;
      const created = await this.services.git.createTaskBranch(workItemId, title);
      this.postMessage({ type: 'gitStatus', isGitRepo: true, currentBranch: await this.services.git.getCurrentBranch(), branchCreated: created });
    }
    return true;
  }

  async startTask(workItemId: number, title: string): Promise<void> {
    this.activeWorkItem = this.activeWorkItem ?? { id: workItemId, title };
    const ok = await this.ensureGitReady(workItemId);
    if (!ok) return;
    vscode.window.showInformationMessage(`ADO Code: task ADO-${workItemId} picked up. Happy coding!`);
  }

  /** Task 25: one-click handoff — git pre-flight, fetch detail+thread, build prompt, delegate. */
  async startTaskWithAgent(workItemId: number, agent?: string): Promise<void> {
    // 1) Git: repo check + branch creation (reuse Task 10 flow)
    const gitOk = await this.ensureGitReady(workItemId);
    if (!gitOk) return;

    // 2) Fetch the full work item + discussion thread (clarification Q&A included)
    const project = this.activeProject(); // H-4
    const { detail, comments } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);
    this.activeWorkItem = {
      id: detail.id,
      title: detail.fields['System.Title'],
      state: detail.fields['System.State'],
      description: detail.fields['System.Description'] || '',
      acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
      tags: detail.fields['System.Tags'] || '',
      comments: comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate })),
    };

    // 3) Build the prompt — includes the thread, so the agent gets the
    //    clarified spec the developer collected via Task 28
    const branch = await this.services.git.getCurrentBranch();
    const prompt = buildAgentPrompt(this.activeWorkItem, branch ?? 'unknown');

    // 4) Delegate (Task 24) — status + result stream back to the webview.
    // H-3 fix: the runner is wired via setAgentRunner (Task 24), NOT on Services.
    if (!this.agentRunner) throw new Error('agent runner not wired yet (Task 24)');
    await this.agentRunner.delegate(workItemId, prompt, agent as any);
  }

  /** Task 13: real detail fetch + thread → activeWorkItem → system prompt. */
  async selectWorkItem(workItemId: number): Promise<void> {
    try {
      const project = this.activeProject(); // H-4
      const { detail, comments } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);
      this.activeWorkItem = {
        id: detail.id,
        title: detail.fields['System.Title'],
        description: detail.fields['System.Description'] || '',
        acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
        tags: detail.fields['System.Tags'] || '',
        comments: comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate })),
      };
      this.postMessage({ type: 'workItemDetail', item: {
        id: this.activeWorkItem.id,
        title: this.activeWorkItem.title,
        state: detail.fields['System.State'],
        assignedTo: detail.fields['System.AssignedTo']?.displayName ?? '',
        workItemType: detail.fields['System.WorkItemType'],
        description: this.activeWorkItem.description,
        acceptanceCriteria: this.activeWorkItem.acceptanceCriteria,
        tags: this.activeWorkItem.tags,
        areaPath: detail.fields['System.AreaPath'] ?? '',
        iterationPath: detail.fields['System.IterationPath'] ?? '',
        comments: this.activeWorkItem.comments ?? [],
      }});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
    }
  }

  // ── Task 13: LLM wiring ────────────────────────────────────────────
  private llmAbort?: AbortController;
  // `conversation` is extended in Task 26 (multi-turn); declared here for Task 24.
  private conversation: LlmMessage[] = [];

  /** Fresh client from current settings (avoids stale config after changes). */
  private llmClient(): LlmClient {
    return new LlmClient(llmConfigFromSettings());
  }

  private async handleUserMessage(content: string): Promise<void> {
    // Task 14: slash-command parsing BEFORE sending to the LLM
    const statusMatch = content.match(/^\/status\s+(\S+)/);
    if (statusMatch) {
      if (this.activeWorkItem) {
        await this.updateWorkItemState(this.activeWorkItem.id, statusMatch[1]);
      } else {
        vscode.window.showWarningMessage('ADO Code: select a work item first (tree view → Select Work Item).');
      }
      return; // do not send slash command to the LLM
    }

    const commentMatch = content.match(/^\/comment\s+([\s\S]+)/);
    if (commentMatch) {
      if (this.activeWorkItem) {
        const project = this.activeProject(); // H-4
        await this.services.ado.addComment(project, this.activeWorkItem.id, commentMatch[1].trim());
        vscode.window.showInformationMessage(`ADO Code: comment added to ADO-${this.activeWorkItem.id}.`);
      } else {
        vscode.window.showWarningMessage('ADO Code: select a work item first.');
      }
      return;
    }

    // Task 16: inject active file + selection context into the user message
    const contextBlock = this.buildEditorContext();
    const finalContent = contextBlock ? `${contextBlock}\n\n[User message:]\n${content}` : content;

    // Cancel any in-flight stream before starting a new one
    this.llmAbort?.abort();
    const abort = new AbortController();
    this.llmAbort = abort;

    // ── Task 24: mode-aware dispatch (Q8) ────────────────────────────
    const mode = getSettings().mode;
    if (mode === 'plan' || mode === 'act') {
      if (!this.executor) {
        this.postMessage({ type: 'error', message: 'Tool executor not wired — run the extension from a fresh activation.' });
        return;
      }
      const budget = getSettings().actToolBudget;
      // conversation is [] for now; Task 26 extends it with history.
      const messages: LlmMessage[] = [
        { role: 'system', content: buildSystemPrompt(this.activeWorkItem) },
        { role: 'user', content: finalContent },
      ];
      try {
        const result = await runAgenticChat(this.llmClient(), this.executor, messages, abort.signal, budget);
        this.postMessage({ type: 'assistantMessage', content: result.text, done: true });
        if (mode === 'plan') this.postMessage({ type: 'planReady', plan: result.text });
      } catch (err) {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        this.postMessage({ type: 'error', message });
      }
      return;
    }

    // inline mode: plain streaming chat (Task 13)
    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemPrompt(this.activeWorkItem) },
      { role: 'user', content: finalContent },
    ];

    try {
      for await (const chunk of this.llmClient().streamChat(messages, abort.signal)) {
        this.postMessage({ type: 'assistantMessage', content: chunk.content, done: chunk.done });
        if (chunk.done) break;
      }
    } catch (err) {
      if (abort.signal.aborted) return; // cancelled by a newer message
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
    }
  }

  /** Task 16: format the active editor file + selection as an LLM context block. */
  private buildEditorContext(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const doc = editor.document;
    const parts: string[] = [];
    parts.push(`[Context: file: ${vscode.workspace.asRelativePath(doc.uri)}, language: ${doc.languageId}]`);
    if (!editor.selection.isEmpty) {
      parts.push(`[Selected code:]`);
      parts.push(doc.getText(editor.selection));
      parts.push(`[/Selected code]`);
    }
    return parts.join('\n');
  }

  /** Task 17 (H12 fix): reveal the adoCode view container + focus the chat view. */
  public focus(): void {
    vscode.commands.executeCommand('workbench.view.extension.adoCode');
    this._view?.show?.(true);
  }

  /** Mode selector (Q8) — updates the setting AND the executor when wired (Task 24). */
  public async pickMode(): Promise<void> {
    const pick = await vscode.window.showQuickPick(['inline', 'plan', 'act'], { placeHolder: `Mode: ${getSettings().mode}` });
    if (pick) {
      await vscode.workspace.getConfiguration('adoCode').update('mode', pick, vscode.ConfigurationTarget.Global);
      this.executor?.setMode(pick as any); // executor wired in Task 24; optional here
      this.postMessage({ type: 'modeChanged', mode: pick as any });
    }
  }

  /** Update a work item's state; on Done/Closed, run the changelog completion hook. */
  async updateWorkItemState(workItemId: number, newState: string): Promise<void> {
    const settings = getSettings();
    const project = this.activeProject(); // H-4: active org project, not stale settings

    // C9 fix: System.History is READ-ONLY in the ADO work-item API (it's the
    // system revision log) — PATCHing it returns 400. Only patch System.State;
    // the "state changed" note goes in a discussion comment instead.
    await this.services.ado.updateWorkItem(project, workItemId, [
      { op: 'add', path: '/fields/System.State', value: newState },
    ]);
    await this.services.ado.addComment(project, workItemId, `ADO Code: state changed to **${newState}**.`);

    if (newState !== 'Done' && newState !== 'Closed') {
      this.postMessage({ type: 'workItemDetail', item: undefined as any }); // refresh not needed
      return;
    }

    // ── completion hook ─────────────────────────────────────────────
    // Q6: resolve implementing branch + short commit hash at completion time.
    const [branch, commitHash] = await Promise.all([
      this.services.git.getCurrentBranch().catch(() => null),
      this.services.git.getShortCommitHash().catch(() => null),
    ]);
    const entry = {
      workItemId,
      title: this.activeWorkItem?.title ?? `Work item ${workItemId}`,
      state: newState,
      date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
      workItemUrl: `https://dev.azure.com/${settings.adoOrganization}/${project}/_workitems/edit/${workItemId}`,
      branch: branch ?? undefined,
      commitHash: commitHash ?? undefined,
    };

    // 1) Local CHANGELOG.md (idempotent via hasEntry)
    if (settings.changelogEnabled && !this.services.changelog.hasEntry(workItemId)) {
      const filePath = await this.services.changelog.addEntry(entry);
      if (settings.changelogAutoCommit) {
        await this.services.git.commitChangelog(filePath, workItemId, entry.title);
      }
    }

    // 2) Post entry to ADO discussion thread (independent of local changelog;
    //    idempotent via comment-marker check)
    if (settings.changelogPostToAdo) {
      const comments = await this.services.ado.getComments(project, workItemId);
      const alreadyPosted = comments.some(c => c.text.includes('Changelog entry added'));
      if (!alreadyPosted) {
        await this.services.ado.addComment(project, workItemId, this.services.changelog.formatForAdo(entry));
      }
    }

    // 3) Q5: offer to push the branch + create a PR via gh CLI (opt-in)
    if (settings.gitPrOnCompletion) {
      await this.offerPushAndPr(workItemId, entry.title, branch);
    }

    this.postMessage({ type: 'changelogUpdated', filePath: 'CHANGELOG.md' });
    vscode.window.showInformationMessage(`ADO Code: ADO-${workItemId} completed — changelog updated.`);
  }

  /** Q5: push current branch and offer to create a PR (gh CLI). */
  private async offerPushAndPr(workItemId: number, title: string, branch: string | null): Promise<void> {
    if (!branch) return;
    const choice = await vscode.window.showQuickPick(['Push branch & create PR', 'Push only', 'Skip'], {
      placeHolder: `Branch '${branch}' ready. Push / create PR?`,
      ignoreFocusOut: true,
    });
    if (!choice || choice === 'Skip') return;

    try {
      // M10 fix: check gh is installed + authenticated before offering the PR path.
      if (choice === 'Push branch & create PR') {
        await new Promise<void>((resolve, reject) => {
          execFile('gh', ['auth', 'status'], { cwd: this.services.git.workspaceRoot }, err => err ? reject(new Error('gh not installed or not authenticated — run `gh auth login`')) : resolve());
        });
      }
      await new Promise<void>((resolve, reject) => {
        execFile('git', ['push', '-u', 'origin', branch], { cwd: this.services.git.workspaceRoot }, err => err ? reject(err) : resolve());
      });
      if (choice === 'Push branch & create PR') {
        await new Promise<void>((resolve, reject) => {
          execFile('gh', ['pr', 'create', '--title', `ADO-${workItemId}: ${title}`, '--body', `Completes ADO-${workItemId} — see work item for details.`], { cwd: this.services.git.workspaceRoot }, err => err ? reject(err) : resolve());
        });
        vscode.window.showInformationMessage(`ADO Code: pushed ${branch} and created PR.`);
      } else {
        vscode.window.showInformationMessage(`ADO Code: pushed ${branch}.`);
      }
    } catch (err) {
      vscode.window.showWarningMessage(`ADO Code: push/PR failed — do it manually (${err instanceof Error ? err.message : err}).`);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview-ui-dist', 'webview.js')
    );
    // CSP: default-src 'none' + explicit allowlists. Without this, VS Code logs
    // a warning and any HTML injected into the webview (e.g. markdown render of
    // LLM output) can execute scripts. The nonce on the script tag makes the
    // inline CSP workable.
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <title>ADO Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { WebviewToExtensionMessage, WorkItemSummary, WorkItemContext } from '../shared/messages';
import { AdoClient } from '../ado/client';
import { Services } from '../services';
import { getSettings, getActiveOrg, llmConfigFromSettings } from '../config/settings';
import { LlmClient } from '../llm/client';
import { LlmMessage, LlmProviderType } from '../llm/types';
import { buildSystemPrompt, buildAgentPrompt } from '../llm/prompts';
import { logger } from '../services/logger';
import { createToolExecutor, ToolExecutor } from '../llm/tools';
import { runAgenticChat } from '../llm/agentic';
import { createConsentBroker } from '../llm/consent';
import { AgentRunner } from '../agents/AgentRunner';
import { parseSlashCommand, SLASH_COMMANDS } from '../shared/slashCommands';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'adoCode.chat';
  private _view?: vscode.WebviewView;
  // Task 24 (H5): wired via setAgentRunner AFTER both exist (services built
  // before the provider in activate()).
  private agentRunner?: AgentRunner;
  private executor?: ToolExecutor;
  // Consent broker for inline-mode mutating tools: tracks the in-flight
  // approve/reject request so the agentic loop never hangs on a missed prompt.
  private readonly consentBroker = createConsentBroker();
  // Auto-refresh timer for work items
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly services: Services,
    // H11: the provider needs ExtensionContext for workspaceState (Q4 history,
    // org switching) and for the tree-refresh callback (C7).
    private readonly _context: vscode.ExtensionContext,
    private readonly onItemsFetched?: (items: any[]) => void,
    // Unassigned Work Items tree: fed by the same refresh cycle.
    private readonly onUnassignedFetched?: (items: any[]) => void
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
      // Consent: inline mode mutating tools flow through the webview consent
      // card (Approve/Reject), with a native QuickPick fallback when the
      // webview isn't available, and a hard timeout so the agentic loop can
      // never block on an unanswered prompt.
      onApprove: async (name, args) => this.requestConsent(name, args),
    });
    this.executor.setMode(getSettings().mode);
  }

  /**
   * Request user consent for a mutating tool (inline mode). Renders an
   * Approve/Reject card in the chat webview and waits for the answer; falls
   * back to a native QuickPick when the webview is unavailable. The broker
   * times out and denies after 120s, and rejectAll() on webview dispose / chat
   * clear / turn abort, so the agentic loop can never hang on a missed prompt.
   */
  async requestConsent(tool: string, args: Record<string, any>): Promise<boolean> {
    const { requestId, decision } = this.consentBroker.request({ tool, args });
    if (this._view) {
      this.postMessage({ type: 'consentRequest', requestId, tool, args });
    } else {
      // No webview (e.g. invoked before resolve or after disposal): native pick.
      const pick = await vscode.window.showQuickPick(['Approve', 'Reject'], {
        placeHolder: `Allow tool '${tool}' with ${JSON.stringify(args)}?`,
      });
      this.consentBroker.resolve(requestId, pick === 'Approve');
    }
    // A newer user message aborts the turn — the pending prompt must not
    // outlive it (the abort also kills the LLM fetch; this kills the wait).
    const abort = this.llmAbort;
    if (abort) {
      return await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          this.consentBroker.resolve(requestId, false);
          resolve(false);
        };
        if (abort.signal.aborted) {
          onAbort();
          return;
        }
        abort.signal.addEventListener('abort', onAbort, { once: true });
        decision.then((approved) => {
          abort.signal.removeEventListener('abort', onAbort);
          resolve(approved);
        });
      });
    }
    return decision;
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
        // Auto-select agent if only one installed, or prompt for default if multiple
        const installed = agents.filter(a => a.installed);
        const cfg = vscode.workspace.getConfiguration('adoCode');
        const currentDefault = cfg.get<string>('agents.autoSelect', '');
        if (installed.length === 1 && !currentDefault) {
          // Only one agent installed — auto-select it
          await cfg.update('agents.autoSelect', installed[0].name, vscode.ConfigurationTarget.Global);
        } else if (installed.length > 1 && !currentDefault) {
          // Multiple agents, no default set — prompt user
          const pick = await vscode.window.showQuickPick(
            installed.map(a => ({ label: a.displayName, description: a.name })),
            { placeHolder: 'Multiple agents installed. Select a default agent for delegation.' }
          );
          if (pick) {
            await cfg.update('agents.autoSelect', pick.description, vscode.ConfigurationTarget.Global);
          }
        }
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
    // If the chat panel closes while the agent waits for consent, deny the
    // pending prompt so the agentic loop can finish (or abort) instead of
    // blocking until the 120s timeout.
    webviewView.onDidDispose(() => this.consentBroker.rejectAll());

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Task 19: React app decides welcome-vs-chat from the sanitized config payload
    this.postMessage({ type: 'config', config: this._sanitizedConfig() });

    // Auto-refresh work items every 5 minutes if configured
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      const s = getSettings();
      if (s.adoOrganization && s.adoProject && s.adoPat) {
        this.refreshWorkItems();
      }
    }, 5 * 60 * 1000);

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
            // Auto-fetch work items after config save if fully configured
            if (this._sanitizedConfig().configured) {
              await this.refreshWorkItems();
            }
            break;
          case 'delegateToAgent':
          case 'agentFollowUp':
          case 'agentCancel':
          case 'listAgents':
            await this.handleAgentMessage(message);
            break;
          case 'clearConversation':
            // Full reset: abort any in-flight LLM stream and clear the loading
            // state too — a stuck spinner must not leave the input bar dead
            // after clearing. Any pending consent prompt is denied as well.
            this.llmAbort?.abort();
            this.consentBroker.rejectAll();
            this.conversation = [];
            this.persistConversation();
            this.postMessage({ type: 'historyRestored', messages: [] });
            this.postMessage({ type: 'loading', loading: false });
            break;
          case 'reviewTaskDetail':
            await this.reviewTaskDetail(message.workItemId);
            break;
          case 'requestClarification':
            try {
              await this.requestClarification(message.workItemId, message.question, message.mentionCreator);
            } catch (err) {
              this.postMessage({ type: 'error', message: `Failed to post clarification: ${err instanceof Error ? err.message : err}` });
            }
            break;
          case 'checkTaskReplies':
            try {
              await this.checkTaskReplies(message.workItemId);
            } catch (err) {
              this.postMessage({ type: 'error', message: `Failed to check replies: ${err instanceof Error ? err.message : err}` });
            }
            break;
          case 'getEditorContext':
            this.postMessage({ type: 'editorContext', text: this.buildEditorContext() ?? '' });
            break;
          case 'pickFiles':
            await this.pickFilesForChat();
            break;
          case 'searchFiles': {
            const query = message.query.toLowerCase();
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
              this.postMessage({ type: 'fileSearchResults', results: [] });
              break;
            }
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 200);
            const results = files
              .map(uri => {
                const relativePath = vscode.workspace.asRelativePath(uri, false);
                const name = relativePath.split('/').pop() || '';
                return { path: relativePath, name };
              })
              .filter(f => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
              .slice(0, 10);
            this.postMessage({ type: 'fileSearchResults', results });
            break;
          }
          case 'pickMode':
            await this.pickMode();
            break;
          case 'rerunWizard':
            // Reset config so the welcome screen re-appears
            this.postMessage({ type: 'config', config: { ...this._sanitizedConfig(), configured: false } });
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'adoCode');
            break;
          case 'cycleMode': {
            const modes = ['inline', 'plan', 'act'] as const;
            const current = getSettings().mode;
            const next = modes[(modes.indexOf(current) + 1) % modes.length];
            await vscode.workspace.getConfiguration('adoCode').update('mode', next, vscode.ConfigurationTarget.Global);
            this.executor?.setMode(next);
            this.postMessage({ type: 'modeChanged', mode: next });
            break;
          }
          case 'selectMode': {
            const selected = message.mode;
            await vscode.workspace.getConfiguration('adoCode').update('mode', selected, vscode.ConfigurationTarget.Global);
            this.executor?.setMode(selected);
            this.postMessage({ type: 'modeChanged', mode: selected });
            break;
          }
          case 'fetchProjects': {
            try {
              const projects = await this.fetchProjects(message);
              this.postMessage({
                type: 'projectList',
                projects: projects.map(p => ({ id: p.id, name: p.name, state: p.state })),
              });
            } catch (err) {
              this.postMessage({ type: 'error', message: `Failed to fetch projects: ${err instanceof Error ? err.message : err}` });
            }
            break;
          }
          case 'fetchModels': {
            try {
              const models = await this.fetchModels(message);
              this.postMessage({ type: 'modelList', models });
            } catch (err) {
              this.postMessage({ type: 'error', message: `Failed to fetch models: ${err instanceof Error ? err.message : err}` });
            }
            break;
          }
          case 'selectProject': {
            await vscode.workspace.getConfiguration('adoCode').update('adoProject', message.projectName, vscode.ConfigurationTarget.Global);
            // Keep workspaceState in sync: getActiveOrg (used by
            // refreshWorkItems) reads 'adoCode.activeProject' from
            // workspaceState FIRST — after the org-switcher command has run,
            // a stale stored value would silently override the setting.
            await this._context.workspaceState.update('adoCode.activeProject', message.projectName);
            this.postMessage({ type: 'config', config: this._sanitizedConfig() });
            // Auto-refresh work items with new project
            await this.refreshWorkItems();
            break;
          }
          case 'consentResponse':
            this.consentBroker.resolve(message.requestId, message.approved);
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

  /**
   * Resolve the org project list. The welcome wizard types org+PAT BEFORE
   * saving them, so `services.ado` (built from saved settings) would throw
   * "AdoClient requires organization and PAT". When the webview supplies
   * unsaved credentials, fetch with a temporary client built from those;
   * otherwise fall back to the configured client.
   */
  private async fetchProjects(message: { organization?: string; pat?: string }) {
    if (message.organization && message.pat) {
      const temp = new AdoClient(message.organization, message.pat);
      return temp.getProjects();
    }
    return this.services.ado.getProjects();
  }

  /**
   * Resolve model ids for the wizard's model picker. Like fetchProjects, the
   * wizard types provider/URL/key BEFORE saving them, so use the typed values
   * when supplied; otherwise fall back to saved settings.
   */
  private async fetchModels(message: { provider?: string; apiUrl?: string; apiKey?: string }): Promise<string[]> {
    const s = getSettings();
    const config = {
      provider: (message.provider as LlmProviderType) || s.llmProvider,
      apiUrl: message.apiUrl || s.llmApiUrl,
      apiKey: message.apiKey || s.llmApiKey,
      model: s.llmModel,
    };
    return new LlmClient(config).listModels();
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
      mode: s.mode,
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
    // Wizard saves must also write workspaceState so getActiveOrg (workspaceState
    // first) resolves the same project the wizard just chose.
    if ((config as any).adoProject !== undefined) {
      await this._context.workspaceState.update('adoCode.activeProject', (config as any).adoProject);
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
    // Both trees are fed from one refresh cycle — fetch assigned + unassigned
    // in parallel; a failure in one branch doesn't sink the other.
    const [assignedResult, unassignedResult] = await Promise.allSettled([
      this.services.ado.getWorkItemsAssignedTo(active.project),
      this.services.ado.getUnassignedWorkItems(active.project),
    ]);

    if (assignedResult.status === 'fulfilled') {
      // M5 fix: map AdoWorkItem → WorkItemSummary (protocol shape) before posting.
      const summaries: WorkItemSummary[] = assignedResult.value.map(i => ({
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
    } else {
      this.postMessage({ type: 'error', message: `Failed to fetch assigned work items: ${assignedResult.reason instanceof Error ? assignedResult.reason.message : assignedResult.reason}` });
    }

    if (unassignedResult.status === 'fulfilled') {
      const unassignedSummaries: WorkItemSummary[] = unassignedResult.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] ?? '',
        state: i.fields['System.State'] ?? '',
        assignedTo: i.fields['System.AssignedTo']?.displayName ?? '',
        workItemType: i.fields['System.WorkItemType'] ?? '',
      }));
      this.onUnassignedFetched?.(unassignedSummaries);
    } else {
      this.postMessage({ type: 'error', message: `Failed to fetch unassigned work items: ${unassignedResult.reason instanceof Error ? unassignedResult.reason.message : unassignedResult.reason}` });
    }

    this.postMessage({ type: 'loading', loading: false });
  }

  // C-4 fix: declared HERE (Task 10), once — Tasks 11/13 refine it but must
  // NOT re-declare (TS2300 duplicate member).
  private activeWorkItem?: WorkItemContext;

  /** H3: git pre-flight shared by startTask (Task 10) and startTaskWithAgent (Task 25).
   *  Returns true if it's safe to proceed. */
  private async ensureGitReady(workItemId: number): Promise<boolean> {
    const settings = getSettings();
    // Task 28 (M16): pre-flight guard — underspecified task warning FIRST.
    const specified = await this.ensureTaskSpecified(workItemId);
    if (!specified) return false;
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
        creator: detail.fields['System.CreatedBy']?.displayName ?? '',
        comments: this.activeWorkItem.comments ?? [],
      }});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
    }
  }

  /** Task 28: full-detail review — fetch work item + discussion, post both to the webview. */
  async reviewTaskDetail(workItemId: number): Promise<void> {
    this.postMessage({ type: 'loading', loading: true });
    try {
      const project = this.activeProject(); // H-4
      const { detail, comments, creator } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);
      this.activeWorkItem = {
        id: detail.id,
        title: detail.fields['System.Title'],
        description: detail.fields['System.Description'] || '',
        acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
        tags: detail.fields['System.Tags'] || '',
        comments: comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate })),
      };
      this.postMessage({
        type: 'workItemDetail',
        item: {
          id: detail.id,
          title: detail.fields['System.Title'],
          state: detail.fields['System.State'],
          assignedTo: detail.fields['System.AssignedTo']?.displayName ?? '',
          workItemType: detail.fields['System.WorkItemType'],
          description: detail.fields['System.Description'] ?? '',
          acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '',
          tags: detail.fields['System.Tags'] ?? '',
          areaPath: detail.fields['System.AreaPath'] ?? '',
          iterationPath: detail.fields['System.IterationPath'] ?? '',
          creator: creator?.displayName ?? '',
          comments: this.activeWorkItem.comments ?? [],
          reproSteps: detail.fields['Microsoft.VSTS.TCM.ReproSteps'] ?? '',
          systemInfo: detail.fields['Microsoft.VSTS.TCM.SystemInfo'] ?? '',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
    } finally {
      this.postMessage({ type: 'loading', loading: false });
    }
  }

  /** Task 28: ask the creator (or whoever) for clarification on the discussion thread. */
  async requestClarification(workItemId: number, question: string, mentionCreator = true): Promise<void> {
    const project = this.activeProject(); // H-4
    const { creator } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);

    // Mention syntax: ADO renders `<@uniqueName>` as a clickable @mention in the
    // web UI discussion. Fall back to plain displayName + email if mention fails.
    const mention = creator && mentionCreator
      ? `@${creator.displayName} <@${creator.uniqueName}>`
      : '';

    const text = [
      mention ? `**Clarification requested from ${creator?.displayName ?? 'the task owner'}:**` : '**Clarification requested:**',
      ``,
      // The mention itself must be IN the comment for the @-notification to fire.
      mention,
      question,
      ``,
      `_Requested via ADO Code — please reply on this thread._`,
    ].join('\n');

    await this.services.ado.addComment(project, workItemId, text);

    // Optionally move to a "needs info" state so it shows up in triage
    const needsInfoState = vscode.workspace.getConfiguration('adoCode').get<string>('ado.clarificationState', 'Blocked');
    if (needsInfoState) {
      try {
        // C9 fix: System.History is read-only; only patch System.State.
        await this.services.ado.updateWorkItem(project, workItemId, [
          { op: 'add', path: '/fields/System.State', value: needsInfoState },
        ]);
      } catch (err) {
        // State change is best-effort (may not be a valid transition for this
        // work item type/process template); the comment is the source of truth.
        vscode.window.showWarningMessage(`ADO Code: comment posted, but state change to '${needsInfoState}' failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    vscode.window.showInformationMessage(`ADO Code: clarification request posted to ADO-${workItemId}.`);
  }

  /** Task 28: check back for replies on the thread. */
  async checkTaskReplies(workItemId: number): Promise<void> {
    const project = this.activeProject(); // H-4
    const comments = await this.services.ado.getComments(project, workItemId);
    this.postMessage({ type: 'taskReplies', workItemId, comments });
    // Refresh the active work item's thread so the next system prompt / agent
    // prompt picks up the clarification Q&A that just arrived.
    if (this.activeWorkItem?.id === workItemId) {
      this.activeWorkItem.comments = comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate }));
    }
  }

  /** Task 28 (M16): warn before starting an underspecified task (no desc AND no AC). */
  private async ensureTaskSpecified(workItemId: number): Promise<boolean> {
    const settings = getSettings();
    if (!settings.adoWarnOnSparseTask) return true;
    const detail = await this.services.ado.getWorkItemDetail(this.activeProject(), workItemId).catch(() => undefined); // H-4
    const hasDesc = !!detail?.fields['System.Description']?.trim();
    const hasAc = !!detail?.fields['Microsoft.VSTS.Common.AcceptanceCriteria']?.trim();
    if (hasDesc || hasAc) return true;
    const choice = await vscode.window.showQuickPick(
      ['Review Detail', 'Request Clarification…', 'Start Anyway', 'Cancel'],
      { placeHolder: 'This task looks underspecified (no description/acceptance criteria). Review detail or request clarification before starting?' }
    );
    if (choice === 'Review Detail') { await this.reviewTaskDetail(workItemId); return false; }
    if (choice === 'Request Clarification…') {
      const q = await vscode.window.showInputBox({ prompt: 'What do you need clarified?', ignoreFocusOut: true });
      if (q) await this.requestClarification(workItemId, q);
      return false;
    }
    return choice === 'Start Anyway'; // Cancel → false
  }

  // ── Task 13: LLM wiring ────────────────────────────────────────────
  private llmAbort?: AbortController;
  // `conversation` is extended in Task 26 (multi-turn); declared here for Task 24.
  private conversation: LlmMessage[] = [];

  /** Task 26: persist conversation to workspaceState (Q4), keyed by folder. */
  private persistConversation(): void {
    const capped = this.conversation.slice(-50);
    // M8 fix: key by folder fsPath (names collide across machines/folders).
    // H-8 fix: use this._context (the provider's field), not a bare `context`.
    const key = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    this._context.workspaceState.update(`adoCode.chatHistory:${key}`, capped);
  }

  /** Task 26: restore persisted history (Q4 "Continue previous session?"). */
  public restoreConversation(history: LlmMessage[]): void {
    this.conversation = history.slice(-50);
    this.postMessage({ type: 'historyRestored', messages: this.conversation });
  }

  /** Task 26: trim the conversation to ~20 turns (drop oldest non-system). */
  private trimConversation(): void {
    const MAX_TURNS = 20;
    // Count turns (user messages) — keep system + the last MAX_TURNS user turns.
    const userIdx: number[] = [];
    this.conversation.forEach((m, i) => { if (m.role === 'user') userIdx.push(i); });
    if (userIdx.length <= MAX_TURNS) return;
    const cutoff = userIdx[userIdx.length - MAX_TURNS];
    this.conversation = this.conversation.slice(cutoff);
  }

  /** Fresh client from current settings (avoids stale config after changes). */
  private llmClient(): LlmClient {
    return new LlmClient(llmConfigFromSettings());
  }

  private async handleUserMessage(content: string): Promise<void> {
    // Task 14: slash-command parsing BEFORE sending to the LLM.
    // Delegates to executeSlashCommand() which handles all commands.
    const parsed = parseSlashCommand(content);
    if (parsed) {
      await this.executeSlashCommand(parsed.command.name, parsed.args);
      return; // do not send slash command to the LLM
    }

    // Task 16: inject active file + selection context into the user message
    const contextBlock = this.buildEditorContext();
    const finalContent = contextBlock ? `${contextBlock}\n\n[User message:]\n${content}` : content;

    // Cancel any in-flight stream before starting a new one
    this.llmAbort?.abort();
    const abort = new AbortController();
    this.llmAbort = abort;

    // ── Task 24: mode-aware dispatch (Q8) ────────────────────────────
    // All three modes run the agentic loop; the EXECUTOR's mode gates what
    // the agent may do: inline → mutating tools require user consent,
    // plan → read-only (no state changes), act → auto-approve.
    const mode = getSettings().mode;
    // Sync the executor with the persisted setting on EVERY turn — a stale
    // executor (e.g. mode changed via the Settings UI, which bypasses
    // cycleMode) would silently auto-approve or block tools against the
    // user's chosen mode.
    this.executor?.setMode(mode);
    if (!this.executor) {
      this.postMessage({ type: 'error', message: 'Tool executor not wired — run the extension from a fresh activation.' });
      return;
    }
    const budget = getSettings().actToolBudget;
    // Task 26: multi-turn — append this turn to the persisted conversation.
    this.conversation.push({ role: 'user', content: finalContent });
    this.trimConversation();
    logger.debug(`Chat: building system prompt with ${this.services.memory.getAll().length} user memories, ${this.services.workspaceMemory.list().length} workspace memories`);
    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemPrompt(this.activeWorkItem, this.services.memory.toPromptString(), this.services.workspaceMemory.toPromptString()) },
      ...this.conversation,
    ];
    try {
      const result = await runAgenticChat(this.llmClient(), this.executor, messages, abort.signal, budget);
      this.postMessage({ type: 'assistantMessage', content: result.text, done: true });
      this.conversation.push({ role: 'assistant', content: result.text });
      this.trimConversation();
      this.persistConversation();
      if (mode === 'plan') this.postMessage({ type: 'planReady', plan: result.text });
    } catch (err) {
      if (abort.signal.aborted) return;
      // INLINE resilience: the endpoint may not support tool calling (some
      // OpenAI-compatible gateways 400 on `tools` for a non-tool model). Fall
      // back to plain streaming chat for this turn so inline mode keeps
      // working exactly like it did before tools were enabled here.
      if (mode === 'inline') {
        try {
          const text = await this.streamAssistantTurn(messages, abort);
          if (text) {
            this.conversation.push({ role: 'assistant', content: text });
            this.trimConversation();
          }
          this.persistConversation();
        } catch (streamErr) {
          if (abort.signal.aborted) return;
          const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
          this.postMessage({ type: 'error', message });
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
    }
  }

  /**
   * Plain streaming chat turn (inline-mode fallback when the endpoint can't
   * handle tool calling). Streams chunks to the webview and returns the
   * accumulated text. Always emits a final done chunk — some gateways close
   * the SSE stream without [DONE], and a missing done chunk leaves the
   * webview spinner stuck and the input bar disabled.
   */
  private async streamAssistantTurn(messages: LlmMessage[], abort: AbortController): Promise<string> {
    let assistantText = '';
    let streamEnded = false;
    for await (const chunk of this.llmClient().streamChat(messages, abort.signal)) {
      assistantText += chunk.content;
      this.postMessage({ type: 'assistantMessage', content: chunk.content, done: chunk.done });
      if (chunk.done) {
        streamEnded = true;
        break;
      }
    }
    if (!streamEnded) {
      this.postMessage({ type: 'assistantMessage', content: '', done: true });
    }
    return assistantText;
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

  /**
   * "Attach files" toolbar tool: let the user pick workspace files; read their
   * contents (bounded per file) and hand them to the webview so they can be
   * inserted into the chat draft. Reads are read-only — nothing is written.
   */
  private async pickFilesForChat(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: 'Attach to chat',
        defaultUri: root,
        title: 'Attach file(s) to the chat message',
      });
      if (!picked || picked.length === 0) return;
      const MAX = 8000;
      const files: Array<{ name: string; content: string }> = [];
      for (const uri of picked) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          let content = Buffer.from(bytes).toString('utf8');
          if (content.length > MAX) {
            content = content.slice(0, MAX) + `\n… [truncated: file is longer than ${MAX} chars]`;
          }
          files.push({ name: vscode.workspace.asRelativePath(uri), content });
        } catch (err) {
          this.postMessage({ type: 'error', message: `Failed to read ${uri.fsPath}: ${err instanceof Error ? err.message : err}` });
        }
      }
      if (files.length > 0) {
        this.postMessage({ type: 'attachedFiles', files });
      }
    } catch (err) {
      // showOpenDialog can reject if the dialog is cancelled weirdly — not fatal.
      this.postMessage({ type: 'error', message: `File picker failed: ${err instanceof Error ? err.message : err}` });
    }
  }

  /** Task 17 (H12 fix): reveal the adoCode view container + focus the chat view. */
  public focus(): void {
    vscode.commands.executeCommand('workbench.view.extension.adoCode');
    this._view?.show?.(true);
  }

  /**
   * Execute a parsed slash command. Central handler for all slash commands.
   */
  private async executeSlashCommand(name: string, args: string): Promise<void> {
    switch (name) {
      case 'status': {
        if (!args) {
          vscode.window.showWarningMessage('ADO Code: usage: /status <new-state>');
          return;
        }
        if (this.activeWorkItem) {
          await this.updateWorkItemState(this.activeWorkItem.id, args);
        } else {
          vscode.window.showWarningMessage('ADO Code: select a work item first (tree view → Select Work Item).');
        }
        break;
      }
      case 'comment': {
        if (!args) {
          vscode.window.showWarningMessage('ADO Code: usage: /comment <text>');
          return;
        }
        if (this.activeWorkItem) {
          const project = this.activeProject(); // H-4
          await this.services.ado.addComment(project, this.activeWorkItem.id, args);
          vscode.window.showInformationMessage(`ADO Code: comment added to ADO-${this.activeWorkItem.id}.`);
        } else {
          vscode.window.showWarningMessage('ADO Code: select a work item first.');
        }
        break;
      }
      case 'pick': {
        await vscode.commands.executeCommand('adoCode.selectWorkItem');
        break;
      }
      case 'assign': {
        if (!args) {
          vscode.window.showWarningMessage('ADO Code: usage: /assign <person>');
          return;
        }
        if (this.activeWorkItem) {
          const project = this.activeProject();
          await this.services.ado.updateWorkItem(project, this.activeWorkItem.id, [
            { op: 'add', path: '/fields/System.AssignedTo', value: args },
          ]);
          vscode.window.showInformationMessage(`ADO Code: ADO-${this.activeWorkItem.id} assigned to ${args}.`);
        } else {
          vscode.window.showWarningMessage('ADO Code: select a work item first.');
        }
        break;
      }
      case 'clear': {
        this.llmAbort?.abort();
        this.consentBroker.rejectAll();
        this.conversation = [];
        this.persistConversation();
        this.postMessage({ type: 'historyRestored', messages: [] });
        this.postMessage({ type: 'loading', loading: false });
        vscode.window.showInformationMessage('ADO Code: chat cleared.');
        break;
      }
      case 'mode': {
        const modes = ['inline', 'plan', 'act'] as const;
        const target = args.trim().toLowerCase();
        if (target && modes.includes(target as any)) {
          await vscode.workspace.getConfiguration('adoCode').update('mode', target, vscode.ConfigurationTarget.Global);
          this.executor?.setMode(target as any);
          this.postMessage({ type: 'modeChanged', mode: target as any });
          vscode.window.showInformationMessage(`ADO Code: mode set to "${target}".`);
        } else if (!target) {
          await this.pickMode();
        } else {
          vscode.window.showWarningMessage(`ADO Code: unknown mode "${args}". Use: inline, plan, or act.`);
        }
        break;
      }
      case 'undo': {
        // Undo last state change: revert to previous state if we have history
        if (this.activeWorkItem) {
          const project = this.activeProject();
          const comments = await this.services.ado.getComments(project, this.activeWorkItem.id);
          // Find the last "state changed" comment to identify the previous state
          const stateChange = comments.reverse().find(c => c.text.includes('ADO Code: state changed to'));
          if (stateChange) {
            const match = stateChange.text.match(/state changed to \*\*(.+?)\*\*/);
            if (match) {
              await this.updateWorkItemState(this.activeWorkItem.id, match[1]);
              vscode.window.showInformationMessage(`ADO Code: undone — reverted to "${match[1]}".`);
            }
          } else {
            vscode.window.showWarningMessage('ADO Code: no state change to undo.');
          }
        } else {
          vscode.window.showWarningMessage('ADO Code: select a work item first.');
        }
        break;
      }
      case 'help': {
        const helpText = SLASH_COMMANDS.map(cmd =>
          `**${cmd.usage}** — ${cmd.description}`
        ).join('\n');
        this.postMessage({ type: 'assistantMessage', content: helpText, done: true });
        break;
      }
      case 'delegate': {
        if (!this.activeWorkItem) {
          vscode.window.showWarningMessage('ADO Code: select a work item first to delegate.');
          return;
        }
        const prompt = args || 'Continue working on the current task.';
        await this.delegateToAgent(prompt);
        break;
      }
      case 'resume': {
        // Resume the last conversation from workspaceState
        const key = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
        const history = this._context.workspaceState.get<any[]>(`adoCode.chatHistory:${key}`, []);
        if (history.length > 0) {
          this.restoreConversation(history);
          vscode.window.showInformationMessage(`ADO Code: resumed ${history.length} messages.`);
        } else {
          vscode.window.showWarningMessage('ADO Code: no previous session to resume.');
        }
        break;
      }
      case 'remember': {
        if (!args) {
          vscode.window.showWarningMessage('ADO Code: usage: /remember <note text>');
          return;
        }
        // Store notes in workspaceState under a dedicated key
        const key = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
        const existing = this._context.workspaceState.get<string[]>(`adoCode.notes:${key}`, []);
        existing.push(args);
        await this._context.workspaceState.update(`adoCode.notes:${key}`, existing);
        vscode.window.showInformationMessage(`ADO Code: note saved (${existing.length} total).`);
        break;
      }
      case 'forget': {
        const key = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
        const existing = this._context.workspaceState.get<string[]>(`adoCode.notes:${key}`, []);
        if (existing.length > 0) {
          await this._context.workspaceState.update(`adoCode.notes:${key}`, []);
          vscode.window.showInformationMessage(`ADO Code: ${existing.length} note(s) cleared.`);
        } else {
          vscode.window.showWarningMessage('ADO Code: no saved notes to clear.');
        }
        break;
      }
      default: {
        vscode.window.showWarningMessage(`ADO Code: unknown command "/${name}". Type /help for available commands.`);
      }
    }
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

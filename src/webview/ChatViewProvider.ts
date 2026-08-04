import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { WebviewToExtensionMessage, WorkItemSummary, WorkItemContext, Session, ImageAttachment } from '../shared/messages';
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
import { createConfirmationBroker, ConfirmationOption } from '../llm/confirmation';
import { isCommandSessionApproved, addSessionCommandApproval, addToTerminalAllowlist } from '../llm/tool-approval-ui';
import type { ContentBlockParam } from '../llm/providers/BaseProvider';
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
  // Generic confirmation broker for in-chat cards (replaces native dialogs).
  private readonly confirmBroker = createConfirmationBroker();
  // Auto-refresh timer for work items
  private refreshTimer?: ReturnType<typeof setInterval>;
  // Task 4.1: token usage status bar — wired via setTokenStatusBar from extension.ts
  private tokenStatusBar?: vscode.StatusBarItem;

  // ── Session persistence (Task 2) ──────────────────────────────────
  private get sessionKey(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    const project = getSettings().adoProject || 'default';
    return `${folder}:${project}`;
  }

  private get sessionsStorageKey(): string {
    return `adoCode.sessions:${this.sessionKey}`;
  }

  private get activeSessionKey(): string {
    return `adoCode.activeSessionId:${this.sessionKey}`;
  }

  private getSessions(): Session[] {
    return this._context.workspaceState.get<Session[]>(this.sessionsStorageKey, []);
  }

  private async saveSessions(sessions: Session[]): Promise<void> {
    await this._context.workspaceState.update(this.sessionsStorageKey, sessions);
  }

  private getActiveSessionId(): string | null {
    return this._context.workspaceState.get<string | null>(this.activeSessionKey, null);
  }

  private async setActiveSessionId(id: string): Promise<void> {
    await this._context.workspaceState.update(this.activeSessionKey, id);
  }

  /**
   * Migrate legacy chatHistory:{folder} to the session-based storage.
   * Wraps old messages into a single Session if no sessions exist yet.
   */
  private async migrateFromLegacyHistory(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    const legacyKey = `adoCode.chatHistory:${folder}`;
    const legacyHistory = this._context.workspaceState.get<LlmMessage[]>(legacyKey, []);
    const existingSessions = this.getSessions();
    if (legacyHistory.length > 0 && existingSessions.length === 0) {
      const session: Session = {
        id: new Date().toISOString(),
        name: 'Migrated Session',
        createdAt: new Date().toISOString(),
        messages: legacyHistory.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      };
      await this.saveSessions([session]);
      await this.setActiveSessionId(session.id);
      // Clean up legacy key
      await this._context.workspaceState.update(legacyKey, undefined);
      logger.info('Chat: migrated legacy history to session storage');
    }
  }

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

  /** Task 4.1: wire the token-usage status bar after creation in extension.ts. */
  public setTokenStatusBar(bar: vscode.StatusBarItem): void {
    this.tokenStatusBar = bar;
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

  /**
   * Generic confirmation: renders an in-chat card with options and waits for
   * the user to pick one. Falls back to a native QuickPick when the webview
   * is unavailable. Returns the chosen value, or null on cancel/timeout.
   */
  async requestConfirmation(title: string, description: string, options: ConfirmationOption[]): Promise<string | null> {
    const { requestId, decision } = this.confirmBroker.request({ title, description, options });
    if (this._view) {
      this.postMessage({ type: 'confirmationRequest', requestId, title, description, options });
    } else {
      // No webview: native QuickPick fallback.
      const pick = await vscode.window.showQuickPick(
        options.map(o => o.label),
        { placeHolder: `${title} — ${description}` }
      );
      const chosen = options.find(o => o.label === pick);
      this.confirmBroker.resolve(requestId, chosen?.value ?? '');
      return chosen?.value ?? null;
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
          const pick = await this.requestConfirmation(
            'Default Agent',
            'Multiple agents installed. Select a default for delegation:',
            [
              ...installed.map(a => ({ label: a.displayName, value: a.name })),
              { label: 'Skip', value: '', isDangerous: true },
            ]
          );
          if (pick) {
            await cfg.update('agents.autoSelect', pick, vscode.ConfigurationTarget.Global);
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

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    // If the chat panel closes while the agent waits for consent, deny the
    // pending prompt so the agentic loop can finish (or abort) instead of
    // blocking until the 120s timeout.
    webviewView.onDidDispose(() => { this.consentBroker.rejectAll(); this.confirmBroker.rejectAll(); });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Task 19: React app decides welcome-vs-chat from the sanitized config payload
    this.postMessage({ type: 'config', config: this._sanitizedConfig() });

    // Task 2: migrate legacy history, send session list, restore active session
    // Wrap in try-catch so a migration/session error never breaks the webview.
    try {
      await this.migrateFromLegacyHistory();
      this.sendSessionList();
      const activeId = this.getActiveSessionId();
      if (activeId) {
        await this.loadSession(activeId);
      }
    } catch (err) {
      logger.error('Chat: session init failed', err);
    }

    // Restore the active work item detail so the task panel is visible after
    // a webview refresh or tab switch. Re-fetch from ADO to get complete fields
    // (assignedTo, workItemType, etc.) that WorkItemContext alone lacks.
    if (this.activeWorkItem) {
      try {
        const project = this.activeProject();
        const { detail, comments } = await this.services.ado.getWorkItemWithDiscussion(project, this.activeWorkItem.id);
        this.postMessage({ type: 'workItemDetail', item: {
          id: detail.id,
          title: detail.fields['System.Title'],
          state: detail.fields['System.State'],
          assignedTo: detail.fields['System.AssignedTo']?.displayName ?? '',
          workItemType: detail.fields['System.WorkItemType'],
          description: detail.fields['System.Description'] || '',
          acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
          tags: detail.fields['System.Tags'] || '',
          areaPath: detail.fields['System.AreaPath'] ?? '',
          iterationPath: detail.fields['System.IterationPath'] ?? '',
          creator: detail.fields['System.CreatedBy']?.displayName ?? '',
          comments: comments.map(c => ({ id: c.id, text: c.text, createdBy: c.createdBy.displayName, createdDate: c.createdDate })),
        }});
      } catch (err) {
        logger.error('Chat: failed to restore active work item detail', err);
      }
    }

    // Auto-refresh work items every 5 minutes if configured
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      const s = getSettings();
      if (s.adoOrganization && s.adoProject && s.adoPat) {
        this.refreshWorkItems();
      }
    }, 5 * 60 * 1000);

    // Check workspace state: empty dir, git init, AGENTS.md
    this.checkWorkspaceInit();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'userMessage':
            await this.handleUserMessage(message.content, message.images);
            break;
          case 'fetchWorkItems':
            await this.refreshWorkItems();
            break;
          case 'getConfig':
            this.postMessage({ type: 'config', config: this._sanitizedConfig() });
            break;
          case 'getFullConfig':
            this.postMessage({ type: 'fullConfig', config: this._allSettings() });
            break;
          case 'saveConfig': {
            // Apply each setting to VS Code configuration
            const cfg = vscode.workspace.getConfiguration('adoCode');
            for (const [key, value] of Object.entries(message.config)) {
              await cfg.update(key, value, vscode.ConfigurationTarget.Global);
            }
            this.postMessage({ type: 'config', config: this._sanitizedConfig() });
            if (this._sanitizedConfig().configured) {
              await this.refreshWorkItems();
            }
            break;
          }
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
            this.confirmBroker.rejectAll();
            this.conversation = [];
            await this.persistConversation();
            this.postMessage({ type: 'historyRestored', messages: [] });
            this.postMessage({ type: 'loading', loading: false });
            break;
          case 'stopGeneration':
            // Abort any in-flight LLM stream and deny pending consent prompts
            // so the agentic loop can finish instead of blocking on a missed
            // prompt. The loading spinner is cleared immediately.
            this.llmAbort?.abort();
            this.consentBroker.rejectAll();
            this.confirmBroker.rejectAll();
            this.postMessage({ type: 'loading', loading: false });
            logger.info('Chat: generation stopped by user');
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
            // Re-check workspace binding after project switch
            const root = this.services.git.workspaceRoot;
            if (root) this.checkProjectBinding(root);
            // Auto-refresh work items with new project
            await this.refreshWorkItems();
            break;
          }
          case 'consentResponse': {
            // Process scope before resolving — the broker clears pending on resolve.
            if (message.approved && message.scope && this.consentBroker.pending) {
              const pending = this.consentBroker.pending;
              if (pending.tool === 'run_terminal_command') {
                const cmd = String(pending.args.command ?? '').trim();
                if (message.scope === 'session') {
                  addSessionCommandApproval(cmd);
                } else if (message.scope === 'permanent') {
                  // Fire-and-forget: update setting in background
                  addToTerminalAllowlist(cmd).catch(err =>
                    logger.error(`[tool-approval] failed to update allowlist: ${err}`),
                  );
                }
              }
            }
            this.consentBroker.resolve(message.requestId, message.approved);
            break;
          }
          case 'confirmationResponse': {
            this.confirmBroker.resolve(message.requestId, message.value);
            break;
          }
          // Task 2: session management
          case 'listSessions':
            this.sendSessionList();
            break;
          case 'switchSession':
            await this.loadSession(message.sessionId);
            break;
          case 'newSession':
            await this.createNewSession();
            break;
          case 'renameSession': {
            const allSessions = this.getSessions();
            const target = allSessions.find(s => s.id === message.sessionId);
            if (target) {
              target.name = message.name;
              await this.saveSessions(allSessions);
              this.sendSessionList();
            }
            break;
          }
          case 'deleteSession': {
            const updatedSessions = this.getSessions().filter(s => s.id !== message.sessionId);
            await this.saveSessions(updatedSessions);
            // If we deleted the active session, switch to the last remaining one
            if (this.getActiveSessionId() === message.sessionId) {
              const fallback = updatedSessions[updatedSessions.length - 1];
              if (fallback) {
                await this.loadSession(fallback.id);
              } else {
                await this.setActiveSessionId('');
                this.conversation = [];
                this.postMessage({ type: 'historyRestored', messages: [] });
              }
            }
            this.sendSessionList();
            break;
          }
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

  /** Return all VS Code settings for the Configuration page. */
  private _allSettings(): Record<string, any> {
    const cfg = vscode.workspace.getConfiguration('adoCode');
    const keys = [
      'adoOrganization', 'adoProject', 'adoPat', 'adoServerUrl',
      'llmProvider', 'llmApiUrl', 'llmApiKey', 'llmModel',
      'mode',
      'git.requireGitRepo', 'git.createBranchOnTaskStart', 'git.requireCleanTree', 'git.prOnCompletion',
      'changelog.enabled', 'changelog.autoCommit', 'changelog.postToAdo',
      'ado.clarificationState', 'ado.warnOnSparseTask',
      'act.toolBudget', 'act.terminalAllowlist',
      'sessions.maxPerProject',
      'agents.enabled', 'agents.verifyCommand', 'agents.autoSelect',
    ];
    const result: Record<string, any> = {};
    for (const key of keys) {
      result[key] = cfg.get(key);
    }
    return result;
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
      // Re-check workspace binding after config save
      const root = this.services.git.workspaceRoot;
      if (root) this.checkProjectBinding(root);
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
        parentId: i.fields['System.Parent']?.id,
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
        parentId: i.fields['System.Parent']?.id,
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

  // ── Workspace project binding ──────────────────────────────────────
  /** Reads .ado-code/config.json (workspace-level ADO project binding). */
  private readWorkspaceConfig(root: string): { adoProject?: string; adoOrganization?: string } | null {
    try {
      const configPath = path.join(root, '.ado-code', 'config.json');
      if (!fs.existsSync(configPath)) return null;
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Writes .ado-code/config.json to bind this workspace to an ADO project. */
  private writeWorkspaceConfig(root: string, config: { adoProject: string; adoOrganization: string }): void {
    const dir = path.join(root, '.ado-code');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Check if the current ADO project is bound to this workspace.
   * If not bound, offer to bind. If bound to a different project, warn.
   */
  private async checkProjectBinding(root: string): Promise<void> {
    const settings = getSettings();
    const currentProject = settings.adoProject;
    const currentOrg = settings.adoOrganization;
    if (!currentProject || !currentOrg) return;

    const stored = this.readWorkspaceConfig(root);

    if (!stored) {
      // Not bound yet — offer to bind
      const choice = await this.requestConfirmation(
        'Bind ADO Project',
        `Bind this workspace to ADO project "${currentProject}" (${currentOrg})? This prevents accidentally working on items from the wrong project.`,
        [
          { label: `Bind to ${currentProject}`, value: 'bind' },
          { label: 'Skip', value: 'skip', isDangerous: true },
        ]
      );
      if (choice === 'bind') {
        this.writeWorkspaceConfig(root, { adoProject: currentProject, adoOrganization: currentOrg });
        vscode.window.showInformationMessage(`ADO Code: workspace bound to ${currentOrg}/${currentProject}.`);
      }
      return;
    }

    // Bound — check for mismatch
    if (stored.adoProject !== currentProject || stored.adoOrganization !== currentOrg) {
      const choice = await this.requestConfirmation(
        'Project Mismatch',
        `This workspace is bound to "${stored.adoProject}" (${stored.adoOrganization}), but your active ADO project is "${currentProject}" (${currentOrg}). Working on items from the wrong project can cause issues.`,
        [
          { label: `Switch to ${currentProject}`, value: 'switch' },
          { label: `Keep ${stored.adoProject}`, value: 'keep' },
          { label: 'Unbind', value: 'unbind', isDangerous: true },
        ]
      );
      if (choice === 'switch') {
        this.writeWorkspaceConfig(root, { adoProject: currentProject, adoOrganization: currentOrg });
        vscode.window.showInformationMessage(`ADO Code: workspace re-bound to ${currentOrg}/${currentProject}.`);
      } else if (choice === 'unbind') {
        fs.unlinkSync(path.join(root, '.ado-code', 'config.json'));
        vscode.window.showInformationMessage('ADO Code: workspace project binding removed.');
      }
      // 'keep' — do nothing, continue with current project
    }
  }

  /**
   * Workspace init checks: empty directory, git init, AGENTS.md generation.
   * Runs once on webview init — non-blocking.
   */
  private async checkWorkspaceInit(): Promise<void> {
    try {
      const root = this.services.git.workspaceRoot;
      if (!root) return;

      // 0) Bind ADO project to this workspace
      await this.checkProjectBinding(root);

      // 1) Empty directory — help user create a new project
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const meaningful = entries.filter(e =>
        !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__'
      );
      if (meaningful.length === 0) {
        await this.handleEmptyDirectory(root);
        return;
      }

      // 2) Not a git repo — offer to init
      const isGit = await this.services.git.isGitRepo();
      if (!isGit) {
        await this.offerGitInit();
      }

      // 3) No AGENTS.md — offer to generate
      const agentsMdPath = path.join(root, 'AGENTS.md');
      if (!fs.existsSync(agentsMdPath)) {
        await this.offerGenerateAgentsMd(root);
      }
    } catch (err) {
      logger.error('Chat: workspace init check failed', err);
    }
  }

  /** Handle an empty workspace — ask what the user wants to build. */
  private async handleEmptyDirectory(root: string): Promise<void> {
    const choice = await this.requestConfirmation(
      'Empty Workspace',
      'This directory is empty. Would you like to set up a new project?',
      [
        { label: 'Create New Project', value: 'create' },
        { label: 'Open Existing Folder', value: 'open' },
        { label: 'Skip', value: 'skip', isDangerous: true },
      ]
    );

    if (choice === 'create') {
      await this.scaffoldProject(root);
    } else if (choice === 'open') {
      vscode.commands.executeCommand('workbench.action.files.openFolder');
    }
  }

  /** Scaffold a new project based on user selections. */
  private async scaffoldProject(root: string): Promise<void> {
    const projectType = await this.requestConfirmation(
      'Project Type',
      'What kind of project would you like to create?',
      [
        { label: 'Node.js (TypeScript)', value: 'node-ts' },
        { label: 'Node.js (JavaScript)', value: 'node-js' },
        { label: 'Python', value: 'python' },
        { label: 'PHP (Laravel)', value: 'php-laravel' },
        { label: 'PHP (Plain)', value: 'php' },
        { label: '.NET (C# Web API)', value: 'dotnet-webapi' },
        { label: '.NET (C# Console)', value: 'dotnet-console' },
        { label: 'Cancel', value: '', isDangerous: true },
      ]
    );
    if (!projectType) return;

    const projectName = await vscode.window.showInputBox({
      prompt: 'Project name?',
      placeHolder: 'my-project',
      ignoreFocusOut: true,
    });
    if (!projectName) return;

    const projectDir = path.join(root, projectName);

    try {
      if (projectType === 'node-ts') {
        await this.scaffoldNodeTs(projectDir, projectName);
      } else if (projectType === 'node-js') {
        await this.scaffoldNodeJs(projectDir, projectName);
      } else if (projectType === 'python') {
        await this.scaffoldPython(projectDir, projectName);
      } else if (projectType === 'php-laravel') {
        await this.scaffoldPhpLaravel(projectDir, projectName);
      } else if (projectType === 'php') {
        await this.scaffoldPhp(projectDir, projectName);
      } else if (projectType === 'dotnet-webapi') {
        await this.scaffoldDotNetWebApi(projectDir, projectName);
      } else if (projectType === 'dotnet-console') {
        await this.scaffoldDotNetConsole(projectDir, projectName);
      }

      const initGit = await this.requestConfirmation(
        'Initialize Git',
        `Initialize a git repository in ${projectName}?`,
        [
          { label: 'Yes, init git', value: 'yes' },
          { label: 'No', value: 'no', isDangerous: true },
        ]
      );
      if (initGit === 'yes') {
        const { execFile: exec } = require('child_process');
        await new Promise<void>((resolve, reject) => {
          exec('git', ['init'], { cwd: projectDir }, (err: any) => err ? reject(err) : resolve());
        });
      }

      vscode.window.showInformationMessage(`ADO Code: project "${projectName}" created.`);
    } catch (err) {
      vscode.window.showErrorMessage(`ADO Code: failed to create project: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async scaffoldNodeTs(dir: string, name: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name, version: '0.1.0', description: '',
      scripts: { build: 'tsc', start: 'node dist/index.js', test: 'echo "no tests"' },
      devDependencies: { typescript: '^5.0.0', '@types/node': '^20.0.0' },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'commonjs', outDir: 'dist', rootDir: 'src', strict: true, esModuleInterop: true },
      include: ['src'], exclude: ['node_modules', 'dist'],
    }, null, 2));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `console.log('Hello, ${name}!');\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');
  }

  private async scaffoldNodeJs(dir: string, name: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name, version: '0.1.0', description: '',
      main: 'index.js',
      scripts: { start: 'node index.js', test: 'echo "no tests"' },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'index.js'), `console.log('Hello, ${name}!');\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  }

  private async scaffoldPython(dir: string, name: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const modName = name.replace(/-/g, '_');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), `[project]
name = "${name}"
version = "0.1.0"
description = ""
requires-python = ">=3.9"

[project.scripts]
${name} = "${modName}:main"
`);
    fs.writeFileSync(path.join(dir, `${modName}.py`), `def main():\n    print("Hello, ${name}!")\n\nif __name__ == "__main__":\n    main()\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), '__pycache__/\n*.pyc\n.env\nvenv/\n');
  }

  private async scaffoldPhpLaravel(dir: string, name: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      name: `app/${name}`,
      description: '',
      type: 'project',
      require: {
        php: '^8.1',
        'laravel/framework': '^11.0',
        'laravel/tinker': '^2.9',
      },
      'require-dev': {
        'fakerphp/faker': '^1.23',
        'laravel/pint': '^1.13',
        'laravel/sail': '^1.26',
        'mockery/mockery': '^1.6',
        'nunomaduro/collision': '^8.0',
        'phpunit/phpunit': '^11.0',
      },
      'autoload': { 'psr-4': { 'App\\\\': 'app/', 'Database\\\\Factories\\\\': 'database/factories/', 'Database\\\\Seeders\\\\': 'database/seeders/' } },
      'autoload-dev': { 'psr-4': { 'Tests\\\\': 'tests/' } },
      'scripts': { 'post-autoload-dump': ['@php artisan package:discover --ansi', '@php artisan vendor:publish --tag=assets --ansi --force'] },
      'extra': { 'laravel': { 'dont-discover': [] } },
      'config': { 'optimize-autoloader': true, 'preferred-install': 'dist', 'sort-packages': true, 'allow-plugins': { 'pestphp/pest-plugin': true, 'php-http/discovery': true } },
      'minimum-stability': 'stable',
      'prefer-stable': true,
    }, null, 2));

    // Basic Laravel structure
    const dirs = ['app/Http/Controllers', 'app/Models', 'routes', 'config', 'database/migrations', 'database/seeders', 'resources/views', 'resources/css', 'public', 'tests/Feature', 'tests/Unit'];
    for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });

    fs.writeFileSync(path.join(dir, 'artisan'), `#!/usr/bin/env php\n<?php\n\nuse Symfony\Component\Console\Input\ArgvInput;\n\ndefine('LARAVEL_START', microtime(true));\n\nrequire __DIR__.'/vendor/autoload.php';\n\n\$app = require_once __DIR__.'/bootstrap/app.php';\n\n\$kernel = \$app->make(Illuminate\Contracts\Console\Kernel::class);\n\n\$status = \$kernel->handle(\$input = new ArgvInput, new Symfony\Component\Console\Output\ConsoleOutput);\n\n\$kernel->terminate(\$input, \$status);\n`);
    fs.chmodSync(path.join(dir, 'artisan'), 0o755);

    fs.writeFileSync(path.join(dir, 'routes', 'web.php'), `<?php\n\nuse Illuminate\Support\Facades\Route;\n\nRoute::get('/', function () {\n    return view('welcome');\n});\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), '/vendor/\n.env\n.env.backup\n.phpunit.result.cache\nHomestead.json\nHomestead.yaml\nauth.json\nnpm-debug.log\nyarn-error.log\n/.fleet\n/.idea\n/.vscode\n');
  }

  private async scaffoldPhp(dir: string, name: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      name: `app/${name}`,
      description: '',
      require: { php: '^8.1' },
      'require-dev': { 'phpunit/phpunit': '^11.0', 'squizlabs/php_codesniffer': '^3.7' },
      autoload: { 'psr-4': { 'App\\': 'src/' } },
      'autoload-dev': { 'psr-4': { 'App\\Tests\\': 'tests/' } },
    }, null, 2));

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.php'), `<?php\n\necho "Hello, ${name}!\n";\n`);
    fs.writeFileSync(path.join(dir, 'phpunit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<phpunit bootstrap="vendor/autoload.php" colors="true">\n    <testsuites>\n        <testsuite name="Unit">\n            <directory>tests</directory>\n        </testsuite>\n    </testsuites>\n</phpunit>\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), '/vendor/\ncomposer.lock\n.phpunit.result.cache\n');
  }

  private async scaffoldDotNetWebApi(dir: string, name: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const csproj = `<Project Sdk="Microsoft.NET.Sdk.Web">\n\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <RootNamespace>${name}</RootNamespace>\n  </PropertyGroup>\n\n  <ItemGroup>\n    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />\n    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.5.0" />\n  </ItemGroup>\n\n</Project>\n`;
    fs.writeFileSync(path.join(dir, `${name}.csproj`), csproj);
    fs.writeFileSync(path.join(dir, `${name}.sln`), `\nMicrosoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nVisualStudioVersion = 17.0.31903.59\nMinimumVisualStudioVersion = 10.0.40219.1\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${name}", "${name}.csproj", "{GUID-HERE}"\nEndProject\nGlobal\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n\t\tDebug|Any CPU = Debug|Any CPU\n\t\tRelease|Any CPU = Release|Any CPU\n\tEndGlobalSection\nEndGlobal\n`);

    fs.mkdirSync(path.join(dir, 'Controllers'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Models'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Program.cs'), `var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthorization();
app.MapControllers();

app.Run();
`);
    fs.writeFileSync(path.join(dir, 'appsettings.json'), JSON.stringify({
      Logging: { LogLevel: { Default: 'Information', 'Microsoft.AspNetCore': 'Warning' } },
      AllowedHosts: '*',
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'Controllers', 'WeatherForecastController.cs'), `using Microsoft.AspNetCore.Mvc;\n\nnamespace ${name}.Controllers;\n\n[ApiController]\n[Route("[controller]")]\npublic class WeatherForecastController : ControllerBase\n{\n    private static readonly string[] Summaries = [\n        "Freezing", "Bracing", "Chilly", "Cool", "Mild",\n        "Warm", "Balmy", "Hot", "Sweltering", "Scorching"\n    ];\n\n    private readonly ILogger<WeatherForecastController> _logger;\n\n    public WeatherForecastController(ILogger<WeatherForecastController> logger)\n    {\n        _logger = logger;\n    }\n\n    [HttpGet] public IEnumerable<object> Get() =>\n        Enumerable.Range(1, 5).Select(index => new\n        {\n            Date = DateOnly.FromDateTime(DateTime.Now.AddDays(index)),\n            TemperatureC = Random.Shared.Next(-20, 55),\n            Summary = Summaries[Random.Shared.Next(Summaries.Length)]\n        })\n        .ToArray();\n}\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), '/bin/\n/obj/\n/user/\n*.user\n*.suo\n*.userosscache\n*.sln.docstates\n');
  }

  private async scaffoldDotNetConsole(dir: string, name: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <RootNamespace>${name}</RootNamespace>\n  </PropertyGroup>\n\n</Project>\n`;
    fs.writeFileSync(path.join(dir, `${name}.csproj`), csproj);
    fs.writeFileSync(path.join(dir, 'Program.cs'), `Console.WriteLine("Hello, ${name}!");\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), '/bin/\n/obj/\n/user/\n*.user\n*.suo\n');
  }

  /** Offer to initialize git in the workspace. */
  private async offerGitInit(): Promise<void> {
    const choice = await this.requestConfirmation(
      'Initialize Git',
      'This workspace is not a git repository. Initialize one?',
      [
        { label: 'git init', value: 'init' },
        { label: 'Skip', value: 'skip', isDangerous: true },
      ]
    );
    if (choice !== 'init') return;

    try {
      const { execFile: exec } = require('child_process');
      await new Promise<void>((resolve, reject) => {
        exec('git', ['init'], { cwd: this.services.git.workspaceRoot }, (err: any) => err ? reject(err) : resolve());
      });
      vscode.window.showInformationMessage('ADO Code: git repository initialized.');
    } catch (err) {
      vscode.window.showErrorMessage(`ADO Code: git init failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Offer to generate AGENTS.md if missing. */
  private async offerGenerateAgentsMd(root: string): Promise<void> {
    const choice = await this.requestConfirmation(
      'Missing AGENTS.md',
      'No AGENTS.md found. This file helps coding agents (Claude, Codex, Hermes, Pi) understand your project. Generate it now?',
      [
        { label: 'Generate AGENTS.md', value: 'generate' },
        { label: 'Skip', value: 'skip', isDangerous: true },
      ]
    );
    if (choice === 'generate') {
      await this.generateAgentsMd(root);
      vscode.window.showInformationMessage('ADO Code: AGENTS.md generated.');
    }
  }

  /** Generate a basic AGENTS.md template from the workspace structure. */
  private async generateAgentsMd(root: string): Promise<void> {
    const pkgPath = path.join(root, 'package.json');
    let pkgName = 'project';
    let pkgDesc = '';
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkgName = pkg.name || 'project';
      pkgDesc = pkg.description || '';
    } catch { /* no package.json */ }

    const hasTs = fs.existsSync(path.join(root, 'tsconfig.json'));
    const hasTests = fs.existsSync(path.join(root, 'src/test')) || fs.existsSync(path.join(root, '__tests__')) || fs.existsSync(path.join(root, 'test'));
    const hasLint = fs.existsSync(path.join(root, '.eslintrc')) || fs.existsSync(path.join(root, '.eslintrc.js')) || fs.existsSync(path.join(root, '.eslintrc.json'));

    const lines = [
      `# AGENTS.md — ${pkgName}`,
      '',
      '## What This Is',
      pkgDesc || 'Project workspace.',
      '',
      '## Build & Test',
    ];

    if (hasTs) lines.push('- `npm run compile` — TypeScript compilation');
    if (hasTests) lines.push('- `npm test` — Run test suite');
    if (hasLint) lines.push('- `npm run lint` — Linting');
    lines.push('- `npm run build` — Full build');
    lines.push('');
    lines.push('## Project Structure');

    try {
      const dirEntries = fs.readdirSync(root, { withFileTypes: true });
      const dirs = dirEntries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
      for (const d of dirs) {
        lines.push(`- \`${d.name}/\` — project directory`);
      }
    } catch { /* ignore */ }

    lines.push('');
    lines.push('## Conventions');
    lines.push('- Follow existing code patterns in the project');
    lines.push('- Run tests before committing');
    lines.push('- Check lint passes');
    lines.push('');
    lines.push('## What NOT to Do');
    lines.push('- Do not commit without running tests');
    lines.push('- Do not add unnecessary dependencies');

    fs.writeFileSync(path.join(root, 'AGENTS.md'), lines.join('\n'), 'utf8');
  }
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
      const choice = await this.requestConfirmation(
        'Uncommitted Changes',
        'You have uncommitted changes. Switch branches anyway?',
        [
          { label: 'Switch Branch', value: 'yes' },
          { label: 'Cancel', value: 'cancel', isDangerous: true },
        ]
      );
      if (choice !== 'yes') return false;
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
    // Fetch full detail so we can show the task panel and know the current state.
    const project = this.activeProject(); // H-4
    let detail;
    let comments;
    try {
      const result = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);
      detail = result.detail;
      comments = result.comments;
    } catch (err) {
      this.postMessage({ type: 'error', message: `Failed to fetch work item: ${err instanceof Error ? err.message : err}` });
      return;
    }

    const currentState = detail.fields['System.State'] as string;
    const choice = await this.requestConfirmation(
      `Start ADO-${workItemId}`,
      `"${title}" — status will change from "${currentState}" to "Active" and a feature branch will be created.`,
      [
        { label: 'Start Task', value: 'start' },
        { label: 'Cancel', value: 'cancel', isDangerous: true },
      ]
    );
    if (choice !== 'start') return;

    // Change ADO status to Active
    await this.services.ado.updateWorkItem(project, workItemId, [
      { op: 'add', path: '/fields/System.State', value: 'Active' },
    ]);
    await this.services.ado.addComment(project, workItemId, 'ADO Code: state changed to **Active**.');

    // Set active work item with full detail
    this.activeWorkItem = {
      id: detail.id,
      title: detail.fields['System.Title'],
      description: detail.fields['System.Description'] || '',
      acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
      tags: detail.fields['System.Tags'] || '',
      comments: comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate })),
    };

    // Git pre-flight (repo check, clean tree, branch creation)
    const ok = await this.ensureGitReady(workItemId);
    if (!ok) return;

    // Show task detail panel in the chat
    this.postMessage({ type: 'workItemDetail', item: {
      id: this.activeWorkItem.id,
      title: this.activeWorkItem.title,
      state: 'Active',
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
    // Inject AGENTS.md as project context so all agents (including Pi,
    // which doesn't auto-read project files) understand the codebase.
    let projectContext: string | undefined;
    try {
      const agentsMd = path.join(this.services.git.workspaceRoot, 'AGENTS.md');
      projectContext = fs.readFileSync(agentsMd, 'utf8');
    } catch {
      // No AGENTS.md — agents still get the work item context.
    }
    const prompt = buildAgentPrompt(this.activeWorkItem, branch ?? 'unknown', projectContext);

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
    const choice = await this.requestConfirmation(
      'Underspecified Task',
      'This task has no description or acceptance criteria. What would you like to do?',
      [
        { label: 'Review Detail', value: 'review' },
        { label: 'Request Clarification', value: 'clarify' },
        { label: 'Start Anyway', value: 'start' },
        { label: 'Cancel', value: 'cancel', isDangerous: true },
      ]
    );
    if (choice === 'review') { await this.reviewTaskDetail(workItemId); return false; }
    if (choice === 'clarify') {
      const q = await vscode.window.showInputBox({ prompt: 'What do you need clarified?', ignoreFocusOut: true });
      if (q) await this.requestClarification(workItemId, q);
      return false;
    }
    return choice === 'start'; // Cancel/null → false
  }

  // ── Task 13: LLM wiring ────────────────────────────────────────────
  private llmAbort?: AbortController;
  // `conversation` is extended in Task 26 (multi-turn); declared here for Task 24.
  private conversation: LlmMessage[] = [];

  /** Task 2: persist conversation to the active session in workspaceState. */
  private async persistConversation(): Promise<void> {
    const activeId = this.getActiveSessionId();
    if (!activeId) return;
    const sessions = this.getSessions();
    const session = sessions.find(s => s.id === activeId);
    if (!session) return;
    session.messages = this.conversation.slice(-50).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('') || '(image attached)' }));
    // Auto-name from first user message if still default
    if (session.name === 'New Session') {
      const firstUser = session.messages.find(m => m.role === 'user');
      if (firstUser) {
        session.name = firstUser.content.slice(0, 60) + (firstUser.content.length > 60 ? '…' : '');
      }
    }
    // Prune old sessions beyond the configured limit
    const maxSessions = vscode.workspace.getConfiguration('adoCode').get<number>('sessions.maxPerProject', 20);
    if (sessions.length > maxSessions) {
      // Sort oldest-first, keep the most recent `maxSessions` (always keep active)
      const sorted = [...sessions].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const toKeep = new Set(sorted.slice(-maxSessions).map(s => s.id));
      toKeep.add(activeId); // always keep active session
      const pruned = sessions.filter(s => toKeep.has(s.id));
      await this.saveSessions(pruned);
    } else {
      await this.saveSessions(sessions);
    }
  }

  /** Task 2: load a session's messages into the conversation and post to webview. */
  private async loadSession(sessionId: string): Promise<void> {
    const sessions = this.getSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    this.conversation = session.messages.map(m => ({ role: m.role as LlmMessage['role'], content: m.content }));
    await this.setActiveSessionId(sessionId);
    this.postMessage({ type: 'historyRestored', messages: this.conversation });
  }

  /** Backward-compatible wrapper for extension.ts / tests that pass raw history. */
  public restoreConversation(history: LlmMessage[]): void {
    this.conversation = history.slice(-50);
    this.postMessage({ type: 'historyRestored', messages: this.conversation });
  }

  /** Task 2: create a new empty session, set it active, and clear the conversation. */
  public async createNewSession(): Promise<void> {
    const session: Session = {
      id: new Date().toISOString(),
      name: 'New Session',
      createdAt: new Date().toISOString(),
      messages: [],
    };
    const sessions = this.getSessions();
    sessions.push(session);
    await this.saveSessions(sessions);
    await this.setActiveSessionId(session.id);
    this.conversation = [];
    this.postMessage({ type: 'historyRestored', messages: [] });
    this.sendSessionList();
  }

  /** Task 2: post the full session list + active ID to the webview. */
  public sendSessionList(): void {
    const sessions = this.getSessions();
    const activeId = this.getActiveSessionId();
    this.postMessage({ type: 'sessionList', sessions, activeId });
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

  /** Task 4.1: update the token-usage status bar after an LLM turn. */
  private updateTokenStatusBar(messages: LlmMessage[]): void {
    if (!this.tokenStatusBar) return;
    try {
      // Rough token count: ~4 chars per token (covers most English text + code)
      const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      const estimatedTokens = Math.ceil(totalChars / 4);
      // Context window is typically 128k; if we can't resolve, use 128k as default
      const maxTokens = 128000;
      const used = estimatedTokens;
      const remaining = Math.max(0, maxTokens - used);
      const percentage = Math.min(100, Math.round((used / maxTokens) * 100));
      this.tokenStatusBar.text = `$(pulse) Tokens: ~${used.toLocaleString()}/${maxTokens.toLocaleString()}`;
      this.tokenStatusBar.tooltip = `Token usage: ~${used.toLocaleString()} used, ${remaining.toLocaleString()} remaining (${percentage}%)`;
    } catch {
      // Token counting is best-effort; don't crash on errors
    }
  }

  /** Fresh client from current settings (avoids stale config after changes). */
  private llmClient(): LlmClient {
    return new LlmClient(llmConfigFromSettings());
  }

  private async handleUserMessage(content: string, images?: ImageAttachment[]): Promise<void> {
    // Task 14: slash-command parsing BEFORE sending to the LLM.
    // Delegates to executeSlashCommand() which handles all commands.
    const parsed = parseSlashCommand(content);
    if (parsed) {
      await this.executeSlashCommand(parsed.command.name, parsed.args);
      // Clear the loading spinner — slash commands are not LLM calls, so the
      // "Thinking…" state set by the webview on send must be resolved here.
      this.postMessage({ type: 'loading', loading: false });
      return; // do not send slash command to the LLM
    }

    // Task 16: inject active file + selection context into the user message
    const contextBlock = this.buildEditorContext();

    // Build LLM content: string or ContentBlockParam[] if images present
    let llmContent: string | ContentBlockParam[];
    if (images && images.length > 0) {
      const blocks: ContentBlockParam[] = [];
      // Text block (with editor context prepended if available)
      const textContent = contextBlock
        ? `${contextBlock}\n\n[User message:]\n${content}`
        : content;
      if (textContent.trim()) {
        blocks.push({ type: 'text', text: textContent });
      }
      // Image blocks
      for (const img of images) {
        const match = img.dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: match[1],
              data: match[2],
            },
          });
        }
      }
      llmContent = blocks;
    } else {
      llmContent = contextBlock
        ? `${contextBlock}\n\n[User message:]\n${content}`
        : content;
    }

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
    this.conversation.push({ role: 'user', content: llmContent });
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
      await this.persistConversation();
      this.updateTokenStatusBar(messages);
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
          await this.persistConversation();
          this.updateTokenStatusBar(messages);
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
        this.confirmBroker.rejectAll();
        this.conversation = [];
        await this.persistConversation();
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
        // Task 2: show in-chat card of all sessions
        const sessions = this.getSessions();
        if (sessions.length === 0) {
          vscode.window.showWarningMessage('ADO Code: no previous sessions to resume.');
          return;
        }
        const options = sessions.map(s => ({
          label: `${s.name} (${s.messages.length} messages)`,
          value: s.id,
        }));
        options.push({ label: 'Cancel', value: '' });
        const picked = await this.requestConfirmation(
          'Resume Session',
          'Select a session to resume:',
          options
        );
        if (picked) {
          const session = sessions.find(s => s.id === picked);
          await this.loadSession(picked);
          vscode.window.showInformationMessage(`ADO Code: resumed session "${session?.name ?? picked}".`);
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
    const pick = await this.requestConfirmation(
      'Switch Mode',
      `Current mode: ${getSettings().mode}`,
      [
        { label: 'Inline', value: 'inline' },
        { label: 'Plan', value: 'plan' },
        { label: 'Act', value: 'act' },
      ]
    );
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
    const choice = await this.requestConfirmation(
      'Push & PR',
      `Branch '${branch}' is ready.`,
      [
        { label: 'Push & Create PR', value: 'push_pr' },
        { label: 'Push Only', value: 'push' },
        { label: 'Skip', value: 'skip', isDangerous: true },
      ]
    );
    if (!choice || choice === 'skip') return;

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

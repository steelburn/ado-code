import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, Session, ImageAttachment } from './types';
import { WelcomeScreen } from './components/WelcomeScreen';
import { TaskDetailPanel } from './components/TaskDetailPanel';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';
import { KebabMenu } from './components/KebabMenu';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { AgentOutputPanel } from './components/AgentOutputPanel';
import { ConsentCard, ConsentRequest } from './components/ConsentCard';
import { ConfirmationCard, ConfirmationRequest } from './components/ConfirmationCard';
import { SessionHistory } from './components/SessionHistory';
import { ConfigurationPage } from './components/ConfigurationPage';
import { ProjectCreationWizard } from './components/ProjectCreationWizard';
import { SkillCatalog } from './components/SkillCatalog';
import { vscode } from './vscode';
import './styles/app.css';
import './styles/markdown.css';

interface SanitizedConfig {
  adoOrganization: string;
  adoProject: string;
  llmProvider: string;
  llmApiUrl: string;
  llmModel: string;
  mode?: 'inline' | 'plan' | 'act' | 'yolo';
  configured: boolean;
  /** ADO is optional — false when the user skipped it in the setup wizard. */
  adoConfigured?: boolean;
  modelCapabilities?: { vision: boolean; tools: boolean };
}

interface AgentInfo {
  name: string;
  displayName: string;
  installed: boolean;
}

interface WorkItemDetail {
  id: number;
  title: string;
  state: string;
  workItemType: string;
  assignedTo: string;
  creator?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string;
  areaPath?: string;
  iterationPath?: string;
  comments?: Array<any>;
}

/** A tool call surfaced live by the agentic loop while the turn is running. */
interface LiveToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  result?: string;
  /** false when the user hid tool calls in chat — only a "…" indicator shows. */
  showDetails?: boolean;
  /** Completion flag for hidden calls, which never carry result content. */
  done?: boolean;
}

/** Serialize a completed tool call back into the fenced block format that
 *  MessageList.parseToolCalls renders as a collapsible card. Kept as a
 *  permanent record in the final assistant message. */
function toolCallToFence(tc: LiveToolCall): string {
  const record: Record<string, any> = { id: tc.id, name: tc.name, arguments: tc.arguments };
  if (tc.result !== undefined) {
    // Cap stored result so overlarge tool output can't bloat the message.
    record.result = tc.result.length > 8000 ? tc.result.slice(0, 8000) + '\n…(truncated)' : tc.result;
  }
  return '```tool_call\n' + JSON.stringify(record) + '\n```';
}

function App() {
  // ── State ──────────────────────────────────────────────────────
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<SanitizedConfig | null>(null);
  const [mode, setMode] = useState('inline');
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  // AI thinking/reasoning text (o1/o3 reasoning_content, Claude extended thinking)
  const [thinking, setThinking] = useState('');
  // Live tool calls from the agentic loop — each starts as "running" and
  // flips to "completed" when the host posts its result. Shown while the
  // turn is in flight, then merged into the final assistant message.
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);
  // Mirror of liveToolCalls for the (stale-closure) message handler — the
  // useEffect below mounts once, so plain state reads there are frozen.
  const liveToolCallsRef = useRef<LiveToolCall[]>([]);
  const updateLiveToolCalls = useCallback(
    (updater: (prev: LiveToolCall[]) => LiveToolCall[]) => {
      liveToolCallsRef.current = updater(liveToolCallsRef.current);
      setLiveToolCalls(liveToolCallsRef.current);
    },
    []
  );

  // Agent state — supports multiple concurrent runs
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<Map<string, { run: any; output: string }>>(new Map());
  const [projects, setProjects] = useState<Array<{ id: string; name: string; state: string }>>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // Input draft lives in App so toolbar tools (add context / attach files) can
  // append to it; InputBar renders it controlled.
  const [draft, setDraft] = useState('');
  // Pending attached files from context menu (right-click → send file to chat)
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; content: string }>>([]);
  // Pending consent: the agent (inline mode) wants to run a mutating tool.
  const [consent, setConsent] = useState<ConsentRequest | null>(null);
  // Pending confirmation: in-chat card replacing native VS Code dialogs.
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  // Wizard model picker (LLM provider) — ids + optional live capability hints
  const [models, setModels] = useState<Array<{ id: string; vision?: boolean; tools?: boolean }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Ensures the main-view project switcher fetches the org project list once
  // per webview session (message-handler closures are stale, so a ref, not
  // state, gates the one-shot fetch).
  const projectsRequestedRef = useRef(false);

  // Session history
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Configuration page
  const [showConfig, setShowConfig] = useState(false);
  // ADO-not-configured reminder banner (dismissed per webview session).
  const [adoReminderDismissed, setAdoReminderDismissed] = useState(false);
  // Project creation wizard
  const [showProjectWizard, setShowProjectWizard] = useState(false);
  // Skill catalog
  const [showSkillCatalog, setShowSkillCatalog] = useState(false);
  // Activity indicator — shows a banner while a skill is executing or tasks are generating
  const [activeActivity, setActiveActivity] = useState<string | null>(null);

  // ── Message handler ────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'assistantMessage':
          // FIX: never drop done:true content — in plan/act mode the host
          // posts the WHOLE result in a single done:true message. The old
          // handler discarded it, so Plan/Act replies never rendered. (Inline
          // streaming sends empty-content done chunks, so appending is a
          // no-op there.)
          // A reply arriving means the agentic turn finished — no consent
          // prompt can still be pending.
          setConsent(null);
          /* Clear turn-live state (thinking + tool-call cards). */
          const finishTurn = () => {
            setThinking('');
            setActiveActivity(null);
            liveToolCallsRef.current = [];
            setLiveToolCalls([]);
          };
          if (msg.done) {
            setLoading(false);
          } else {
            setLoading(true);
          }
          // Snapshot the tools run this turn BEFORE finishTurn wipes them.
          // Hidden tool calls (chat.showToolCalls=false) are excluded — the
          // user asked for them to stay out of the chat, so they are neither
          // merged into the final message nor persisted to session history.
          const finishedToolCalls = msg.done
            ? liveToolCallsRef.current.filter(tc => tc.showDetails !== false)
            : [];
          if (msg.done) finishTurn();

          // The turn just finished — merge the live tool-call record into the
          // assistant message so the tools the agent ran stay visible as
          // collapsible cards above the answer (and survive session history).
          const toolLog = msg.done && finishedToolCalls.length > 0
            ? finishedToolCalls.map(toolCallToFence).join('\n\n')
            : '';

          if (!msg.content && !toolLog) break;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            const content = toolLog ? toolLog + '\n\n' + msg.content : msg.content;
            if (last && last.role === 'assistant') {
              return [...prev.slice(0, -1), { role: 'assistant', content: last.content + content }];
            }
            return [...prev, { role: 'assistant', content }];
          });
          break;

        case 'thinkingMessage':
          // AI thinking/reasoning text — accumulate and display while streaming
          if (!msg.done) {
            setThinking(prev => prev + msg.content);
          } else {
            setThinking('');
          }
          break;

        case 'toolCall':
          // Agentic loop is about to run a tool — add a live "running" card
          // (or a bare heartbeat when the user hid tool details).
          updateLiveToolCalls(prev => {
            if (prev.some(t => t.id === msg.call.id)) return prev;
            return [
              ...prev,
              {
                id: msg.call.id,
                name: msg.call.name,
                arguments: msg.call.arguments || {},
                showDetails: msg.call.showDetails !== false,
              },
            ];
          });
          break;

        case 'toolResult':
          // Tool finished — mark its card completed with the result.
          updateLiveToolCalls(prev =>
            prev.map(t => (t.id === msg.callId ? { ...t, result: msg.content, done: true } : t))
          );
          break;

        case 'toolCallDone':
          // Hidden tool calls (chat.showToolCalls=false) never carry result
          // content — the host posts this bare tick so the "Working…"
          // disclosure can flip the row from running to completed.
          updateLiveToolCalls(prev =>
            prev.map(t => (t.id === msg.callId ? { ...t, done: true } : t))
          );
          break;

        case 'loading':
          setLoading(msg.loading);
          break;

        case 'error':
          setError(msg.message);
          setLoading(false);
          // A failed project/model fetch must not leave the wizard stuck on
          // "Fetching…" forever (Refresh links are gated on !loading).
          setProjectsLoading(false);
          setModelsLoading(false);
          // An error ends the turn — no consent prompt can still be pending.
          setConsent(null);
          setThinking(''); // Clear thinking on error
          setActiveActivity(null); // Clear activity indicator on error
          liveToolCallsRef.current = []; // Clear live tool cards
          setLiveToolCalls([]);
          break;

        case 'consentRequest':
          // Agent requires consent for a mutating tool (inline mode).
          setConsent({
            requestId: msg.requestId,
            tool: msg.tool,
            args: msg.args,
            autoApproveMs: msg.autoApproveMs,
          });
          break;

        case 'confirmationRequest':
          // Generic in-chat confirmation card (replaces native dialogs).
          setConfirmation({
            requestId: msg.requestId,
            title: msg.title,
            description: msg.description,
            options: msg.options,
          });
          break;

        case 'choicePrompt':
          // AI detected a choice prompt — show as inline confirmation card.
          // isChoice marks it: clicking an option sends the choice as a user
          // message (the LLM then acts on it as a follow-up turn).
          setConfirmation({
            requestId: msg.requestId,
            title: 'Choose an option',
            description: msg.question,
            options: msg.options,
            isChoice: true,
          });
          break;

        case 'config': {
          const cfg = msg.config as unknown as SanitizedConfig;
          setConfig(cfg);
          // Sync the Chat|Plan|Act toggle with the persisted setting (the
          // webview reloads fresh, but the host kept the stored mode).
          if (cfg.mode) setMode(cfg.mode);
          // Project switcher: fetch the org project list once the wizard is
          // fully configured (no creds in the message → host uses saved
          // settings). ADO may be skipped — never auto-fetch projects when it
          // isn't configured (the host would only error out).
          if (cfg.configured && cfg.adoConfigured === true && !projectsRequestedRef.current) {
            projectsRequestedRef.current = true;
            setProjectsLoading(true);
            vscode.postMessage({ type: 'fetchProjects' });
          }
          break;
        }

        case 'modeChanged':
          setMode(msg.mode);
          break;

        case 'agentList':
          setAgents(msg.agents.map(a => ({
            name: a.name,
            displayName: a.displayName,
            installed: a.installed,
          })));

          break;

        case 'agentRunsList': {
          // Hydrate multi-run map from extension host (on mount / re-focus)
          const next = new Map<string, { run: any; output: string }>();
          for (const run of msg.runs) {
            next.set(run.id, { run, output: '' });
          }
          setAgentRuns(next);
          break;
        }

        case 'historyRestored':
          setMessages(msg.messages.map(m => ({ role: m.role, content: m.content })));
          liveToolCallsRef.current = [];
          setLiveToolCalls([]);
          break;

        case 'sessionList':
          setSessions(msg.sessions);
          setActiveSessionId(msg.activeId);
          break;
        case 'sessionSwitched':
          setMessages(msg.session.messages.map(m => ({ role: m.role, content: m.content })));
          setActiveSessionId(msg.session.id);
          liveToolCallsRef.current = [];
          setLiveToolCalls([]);
          break;

        case 'workItemDetail':
          setDetail(msg.item as unknown as WorkItemDetail);

          break;

        case 'taskReplies':
          if (detail && detail.id === msg.workItemId) {
            setDetail(prev => prev ? { ...prev, comments: msg.comments } : prev);
          }
          break;

        case 'agentStatus': {
          // Upsert into the multi-run map
          const runId = msg.run.id;
          setAgentRuns(prev => {
            const next = new Map(prev);
            const existing = next.get(runId);
            next.set(runId, {
              run: msg.run,
              output: (existing?.output ?? '') + (msg.delta ?? ''),
            });
            return next;
          });
          break;
        }

        case 'agentResult': {
          const resultId = msg.run.id;
          setAgentRuns(prev => {
            const next = new Map(prev);
            const existing = next.get(resultId);
            next.set(resultId, {
              run: msg.run,
              // Summary is now shown in the editor panel, not inline
              output: existing?.output ?? '',
            });
            return next;
          });
          // Add completion message to chat thread
          const statusEmoji = msg.run.status === 'succeeded' ? '✅' : msg.run.status === 'failed' ? '❌' : '⚠️';
          const completionMsg = `${statusEmoji} **Agent ${msg.run.agent}** ${msg.run.status} for #${msg.run.workItemId ?? '?'}`;
          setMessages(prev => [...prev, { role: 'assistant', content: completionMsg }]);
          setLoading(false);
          break;
        }

        case 'projectList':
          setProjects(msg.projects);
          setProjectsLoading(false);
          break;

        case 'modelList':
          setModels(msg.models);
          setModelsLoading(false);
          break;

        case 'editorContext':
          // "Add context (@)" — host returns the active editor file +
          // selection; append it to the draft.
          if (msg.text) {
            setDraft(prev => (prev ? prev + '\n\n' : '') + msg.text);
          }
          break;

        case 'attachedFiles':
          // "Attach files" — host returns picked file contents; add them
          // to the file-attachment indicator (not the draft).
          if (msg.files.length > 0) {
            setAttachedFiles(prev => [...prev, ...msg.files]);
          }
          break;

        case 'openProjectWizard':
          setShowProjectWizard(true);
          break;

        case 'projectWizardCreated':
          if (msg.success) {
            setShowProjectWizard(false);
          } else {
            setError(msg.error || 'Failed to create project');
          }
          break;
        case 'openSkillCatalog':
          setShowSkillCatalog(true);
          break;

        case 'insertText':
          // Right-click context menu: insert text into the chat draft
          if (msg.text) {
            setDraft(prev => (prev ? prev + '\n\n' : '') + msg.text);
          }
          break;
      }
    };

    window.addEventListener('message', handler);

    // Restore state
    const saved = vscode.getState();
    if (saved?.history && Array.isArray(saved.history) && saved.history.length > 0) {
      setMessages(saved.history);
    }
    if (saved?.detail) {
      setDetail(saved.detail);
    }
    // Restore wizard/catalog visibility states
    if (saved?.showProjectWizard) {
      setShowProjectWizard(true);
    }
    if (saved?.showSkillCatalog) {
      setShowSkillCatalog(true);
    }
    // Restore attached files from context menu
    if (saved?.attachedFiles && Array.isArray(saved.attachedFiles) && saved.attachedFiles.length > 0) {
      setAttachedFiles(saved.attachedFiles);
    }

    vscode.postMessage({ type: 'getConfig' });
    vscode.postMessage({ type: 'listAgents' });
    vscode.postMessage({ type: 'listAgentRuns' });
    vscode.postMessage({ type: 'listSessions' });

    return () => window.removeEventListener('message', handler);
  }, []);

  // Persist history + task detail so the chat restores after panel collapse/reopen
  useEffect(() => {
    vscode.setState({
      history: messages,
      detail,
      showProjectWizard,
      showSkillCatalog,
      attachedFiles,
    });
  }, [messages, detail, showProjectWizard, showSkillCatalog, attachedFiles]);

  // ── Actions ────────────────────────────────────────────────────
  const handleSend = useCallback((content: string, images?: ImageAttachment[]) => {
    // Prepend attached file contents to the message so the LLM sees them
    const fileBlocks = attachedFiles.map(f => `[File: ${f.name}]\n${f.content}\n[/file]`);
    const fullContent = fileBlocks.length > 0
      ? (content ? fileBlocks.join('\n\n') + '\n\n' + content : fileBlocks.join('\n\n'))
      : content;
    const displayContent = images?.length
      ? (fullContent ? `${fullContent}\n\n${images.map(i => `[Image: ${i.name}]`).join(' ')}` : images.map(i => `[Image: ${i.name}]`).join(' '))
      : fullContent;
    setMessages(prev => [...prev, { role: 'user', content: displayContent }]);
    vscode.postMessage({ type: 'userMessage', content: fullContent, images });
    setDraft('');
    setAttachedFiles([]);
    setLoading(true); // Show loading indicator immediately
    // A new turn aborts any in-flight run — the host denies the pending
    // prompt; drop the card here too.
    setConsent(null);
    setThinking('');
    liveToolCallsRef.current = []; // New turn — clear any stale tool cards
    setLiveToolCalls([]);
    // Activity indicator for specific commands
    if (content.trim().toLowerCase().startsWith('/generate-tasks')) {
      setActiveActivity('Generating tasks');
    }
  }, []);

  const handleConsentResponse = useCallback((requestId: string, approved: boolean, scope?: 'once' | 'session' | 'permanent') => {
    setConsent(null);
    vscode.postMessage({ type: 'consentResponse', requestId, approved, scope });
  }, []);

  const handleConfirmationResponse = useCallback((requestId: string, value: string) => {
    // AI choice prompts: the option click becomes the user's follow-up
    // message (same flow as typing it) so the LLM executes the choice.
    // The host never registered a confirmBroker request for choice cards,
    // so a confirmationResponse there would be a no-op.
    const wasChoice = confirmation?.isChoice === true;
    setConfirmation(null);
    if (wasChoice) {
      setMessages(prev => [...prev, { role: 'user', content: value }]);
      setLoading(true);
      vscode.postMessage({ type: 'sendMessage', content: value });
      return;
    }
    vscode.postMessage({ type: 'confirmationResponse', requestId, value });
  }, [confirmation]);

  const handleClear = useCallback(() => {
    vscode.postMessage({ type: 'clearConversation' });
    setMessages([]);
    // Clear must fully reset the input: a stuck spinner (hung LLM stream)
    // would otherwise leave the send button dead after clearing.
    setLoading(false);
    setDraft('');
  }, []);

  const handleSaveConfig = useCallback((form: {
    adoOrganization: string;
    adoProject: string;
    adoPat: string;
    llmProvider: string;
    llmApiUrl: string;
    llmApiKey: string;
    llmModel: string;
  }) => {
    vscode.postMessage({ type: 'updateConfig', config: form });
  }, []);

  const handleModeSelect = useCallback((selectedMode: 'inline' | 'plan' | 'act' | 'yolo') => {
    vscode.postMessage({ type: 'selectMode', mode: selectedMode });
  }, []);

  const handleClarify = useCallback((workItemId: number, question: string) => {
    vscode.postMessage({ type: 'requestClarification', workItemId, question, mentionCreator: true });
  }, []);

  const handleCheckReplies = useCallback((workItemId: number) => {
    vscode.postMessage({ type: 'checkTaskReplies', workItemId });
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetail(null);
  }, []);



  // Session history callbacks
  const handleSwitchSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: 'switchSession', sessionId });
  }, []);

  const handleNewSession = useCallback(() => {
    vscode.postMessage({ type: 'newSession' });
    setMessages([]);
    setLoading(false);
    setDraft('');
  }, []);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    vscode.postMessage({ type: 'renameSession', sessionId, name });
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: 'deleteSession', sessionId });
  }, []);

  const handleDeleteAllSessions = useCallback(() => {
    vscode.postMessage({ type: 'clearAllSessions' });
    setMessages([]);
    setActiveSessionId(null);
  }, []);

  // ── Kebab menu actions ───────────────────────────────────────
  const handleKebabAction = useCallback((action: string) => {
    switch (action) {
      case 'refreshWorkItems':
        vscode.postMessage({ type: 'fetchWorkItems' });
        break;
      case 'rerunWizard':
        vscode.postMessage({ type: 'rerunWizard' });
        break;
      case 'openSettings':
        setShowConfig(true);
        break;
      case 'clearAllSessions':
        handleDeleteAllSessions();
        break;
    }
  }, [handleDeleteAllSessions]);

  const handleFetchProjects = useCallback((organization?: string, pat?: string) => {
    setProjectsLoading(true);
    // Pass the typed-but-unsaved credentials: the host fetches with these
    // directly (saved settings are empty until "Save & Continue").
    vscode.postMessage({ type: 'fetchProjects', organization, pat });
  }, []);

  const handleFetchModels = useCallback((provider?: string, apiUrl?: string, apiKey?: string) => {
    // Drop any list from a previous endpoint so the picker can't show stale
    // models while the new list loads.
    setModels([]);
    setModelsLoading(true);
    // Same typed-but-unsaved pattern as projects: the host builds a temp
    // LlmClient from these (falling back to saved settings when absent).
    vscode.postMessage({ type: 'fetchModels', provider, apiUrl, apiKey });
  }, []);

  const handleSwitchProject = useCallback((projectName: string) => {
    // Host persists the choice (settings + workspaceState) and refreshes work
    // items (chat list + sidebar tree) for the new project.
    vscode.postMessage({ type: 'selectProject', projectName });
  }, []);

  // ── Render ─────────────────────────────────────────────────────

  // Welcome screen when not configured
  if (config && !config.configured) {
    return (
      <div className="app">
        <WelcomeScreen
          config={config}
          onSave={handleSaveConfig}
          onFetchProjects={handleFetchProjects}
          projects={projects}
          projectsLoading={projectsLoading}
          onFetchModels={handleFetchModels}
          models={models}
          modelsLoading={modelsLoading}
        />
      </div>
    );
  }

  // Loading state before config arrives
  if (!config) {
    return (
      <div className="app">
        <div className="empty-state">
          <div className="loading-dots">
            <span /><span /><span />
          </div>
        </div>
      </div>
    );
  }

  // Configuration page
  if (showConfig) {
    return (
      <div className="app">
        <ConfigurationPage
          onBack={() => {
            setShowConfig(false);
            // Closing Configuration re-arms the ADO reminder (still skipped).
            setAdoReminderDismissed(false);
          }}
          onFetchModels={handleFetchModels}
          models={models}
          modelsLoading={modelsLoading}
        />
      </div>
    );
  }
  // Skill catalog
  if (showSkillCatalog) {
    return (
      <div className="app">
        <SkillCatalog
          onClose={() => setShowSkillCatalog(false)}
          onExecute={(_skillId, skillName) => {
            setActiveActivity(`Executing skill: ${skillName}`);
            setLoading(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app chat-layout">
      {/* Task detail panel (collapsible) */}
      {detail && (
        <TaskDetailPanel
          detail={detail}
          onClarify={handleClarify}
          onCheckReplies={handleCheckReplies}
          onClose={handleCloseDetail}
        />
      )}

      {/* ADO-not-configured reminder — ADO may be skipped in the setup wizard,
          so keep nudging until it's set up (banner reappears on reload / after
          closing Configuration if still skipped; dismissed only for this page
          session via the ✕ button). */}
      {config.configured && config.adoConfigured !== true && !adoReminderDismissed && (
        <div className="ado-not-configured-banner">
          <span className="ado-not-configured-text">
            <strong>Azure DevOps isn't configured</strong> — work items, ADO task tracking, branches, and pull requests are disabled.
          </span>
          <button
            className="btn btn-secondary"
            onClick={() => setShowConfig(true)}
            type="button"
          >
            Configure…
          </button>
          <button
            className="ado-not-configured-dismiss"
            onClick={() => setAdoReminderDismissed(true)}
            title="Dismiss (reminder returns after reload)"
            type="button"
          >
            ✕
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="error-banner">
          <span className="error-banner-text">{error}</span>
          <button className="error-banner-dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Chat header with session history, project switcher + kebab menu */}
      <div className="chat-header">
        <span className="chat-header-title">ADO Code</span>
        <SessionHistory
          sessions={sessions}
          activeId={activeSessionId}
          onSwitch={handleSwitchSession}
          onNew={handleNewSession}
          onRename={handleRenameSession}
          onDelete={handleDeleteSession}
          onDeleteAll={handleDeleteAllSessions}
        />
        <ProjectSwitcher
          projects={projects}
          current={config.adoProject}
          loading={projectsLoading}
          onSwitch={handleSwitchProject}
          onRefresh={handleFetchProjects}
        />
        <KebabMenu
          items={[
            { label: 'Refresh Work Items', icon: '↻', action: 'refreshWorkItems' },
            { label: 'Rerun Setup Wizard', icon: '🔄', action: 'rerunWizard' },
            { label: 'Configuration…', icon: '⚙', action: 'openSettings' },
            { label: '', action: '', separator: true },
            { label: 'Clear Chat History', icon: '🗑️', action: 'clearAllSessions' },
          ]}
          onSelect={handleKebabAction}
        />
      </div>

      {/* Agent output panels (one per running/recent agent) */}
      {Array.from(agentRuns.entries()).map(([id, { run, output }]) => (
        <AgentOutputPanel
          key={id}
          run={run}
          output={output}
          loading={loading && run.status === 'running'}
          onDismiss={(runId) => {
            setAgentRuns(prev => {
              const next = new Map(prev);
              next.delete(runId);
              return next;
            });
            // Persist the dismissal host-side so it survives re-hydration
            // (panel remount / reload) instead of reappearing.
            vscode.postMessage({ type: 'dismissAgentRun', runId });
          }}
          onReopen={(runId) => {
            // Re-open the summary output in the editor panel (the user may
            // have closed it after completion).
            vscode.postMessage({ type: 'reopenAgentOutput', runId });
          }}
        />
      ))}

      {/* Messages */}
      <MessageList messages={messages} loading={loading} thinking={thinking} activity={activeActivity} liveToolCalls={liveToolCalls} />

      {/* Consent card — agent wants to run a mutating tool (inline mode) */}
      {consent && (
        <ConsentCard request={consent} onRespond={handleConsentResponse} />
      )}

      {/* Confirmation card — in-chat replacement for native VS Code dialogs */}
      {confirmation && (
        <ConfirmationCard request={confirmation} onRespond={handleConfirmationResponse} />
      )}

      {/* Input */}
      {/* Active-model capability gating: no vision → image attach/paste is
          disabled; no tool calling → agentic modes degrade to plain chat,
          surfaced as a persistent warning. */}
      <InputBar
        mode={mode}
        value={draft}
        onValueChange={setDraft}
        onSend={handleSend}
        onStop={() => {
          vscode.postMessage({ type: 'stopGeneration' });
          setLoading(false);
        }}
        onClear={handleClear}
        onModeSelect={handleModeSelect}
        onAddContext={() => vscode.postMessage({ type: 'getEditorContext' })}
        onAttachFiles={() => vscode.postMessage({ type: 'pickFiles' })}
        loading={loading ? mode : ''}
        canAttachImages={config.modelCapabilities?.vision ?? true}
        attachedFiles={attachedFiles}
        onRemoveAttachedFile={(index) => setAttachedFiles(prev => prev.filter((_, i) => i !== index))}
      />
      {config.configured && config.modelCapabilities && !config.modelCapabilities.tools && (
        <div className="model-capability-warning" title="Tool calling unavailable for the active model">
          ⚠ <strong>{config.llmModel}</strong> doesn't support tool calling — Chat/Plan/Act run as plain chat (no tools, no file edits, no delegation).
        </div>
      )}
      {/* Project creation wizard */}
      {showProjectWizard && (
        <ProjectCreationWizard onClose={() => setShowProjectWizard(false)} />
      )}
    </div>
  );
}

export default App;

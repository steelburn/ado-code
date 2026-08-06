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
import { vscode } from './vscode';
import './styles/app.css';
import './styles/markdown.css';

interface SanitizedConfig {
  adoOrganization: string;
  adoProject: string;
  llmProvider: string;
  llmApiUrl: string;
  llmModel: string;
  mode?: 'inline' | 'plan' | 'act';
  configured: boolean;
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

function App() {
  // ── State ──────────────────────────────────────────────────────
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<SanitizedConfig | null>(null);
  const [mode, setMode] = useState('inline');
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);

  // Agent state — supports multiple concurrent runs
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<Map<string, { run: any; output: string }>>(new Map());
  const [projects, setProjects] = useState<Array<{ id: string; name: string; state: string }>>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // Input draft lives in App so toolbar tools (add context / attach files) can
  // append to it; InputBar renders it controlled.
  const [draft, setDraft] = useState('');
  // Pending consent: the agent (inline mode) wants to run a mutating tool.
  const [consent, setConsent] = useState<ConsentRequest | null>(null);
  // Pending confirmation: in-chat card replacing native VS Code dialogs.
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  // Wizard model picker (LLM provider)
  const [models, setModels] = useState<string[]>([]);
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
          if (msg.done) setLoading(false);
          else setLoading(true);
          if (!msg.content) break;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: last.content + msg.content };
              return updated;
            }
            return [...prev, { role: 'assistant', content: msg.content }];
          });
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
          break;

        case 'consentRequest':
          // Agent requires consent for a mutating tool (inline mode).
          setConsent({
            requestId: msg.requestId,
            tool: msg.tool,
            args: msg.args,
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
          // AI detected a choice prompt — show as inline confirmation card
          setConfirmation({
            requestId: msg.requestId,
            title: 'Choose an option',
            description: msg.question,
            options: msg.options,
          });
          break;

        case 'config': {
          const cfg = msg.config as unknown as SanitizedConfig;
          setConfig(cfg);
          // Sync the Chat|Plan|Act toggle with the persisted setting (the
          // webview reloads fresh, but the host kept the stored mode).
          if (cfg.mode) setMode(cfg.mode);
          // Project switcher: fetch the org project list once the wizard is
          // configured (no creds in the message → host uses saved settings).
          if (cfg.configured && !projectsRequestedRef.current) {
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
          break;

        case 'sessionList':
          setSessions(msg.sessions);
          setActiveSessionId(msg.activeId);
          break;
        case 'sessionSwitched':
          setMessages(msg.session.messages.map(m => ({ role: m.role, content: m.content })));
          setActiveSessionId(msg.session.id);
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
          // "Attach files" — host returns picked file contents; insert them
          // into the draft as fenced blocks.
          if (msg.files.length > 0) {
            setDraft(prev => {
              const blocks = msg.files.map(f => `[Attached file: ${f.name}]\n${f.content}\n[/file]`);
              return (prev ? prev + '\n\n' : '') + blocks.join('\n\n');
            });
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

    vscode.postMessage({ type: 'getConfig' });
    vscode.postMessage({ type: 'listAgents' });
    vscode.postMessage({ type: 'listAgentRuns' });
    vscode.postMessage({ type: 'listSessions' });

    return () => window.removeEventListener('message', handler);
  }, []);

  // Persist history + task detail so the chat restores after panel collapse/reopen
  useEffect(() => {
    vscode.setState({ history: messages, detail });
  }, [messages, detail]);

  // ── Actions ────────────────────────────────────────────────────
  const handleSend = useCallback((content: string, images?: ImageAttachment[]) => {
    const displayContent = images?.length
      ? (content ? `${content}\n\n${images.map(i => `[Image: ${i.name}]`).join(' ')}` : images.map(i => `[Image: ${i.name}]`).join(' '))
      : content;
    setMessages(prev => [...prev, { role: 'user', content: displayContent }]);
    vscode.postMessage({ type: 'userMessage', content, images });
    setDraft('');
    setLoading(true); // Show loading indicator immediately
    // A new turn aborts any in-flight run — the host denies the pending
    // prompt; drop the card here too.
    setConsent(null);
  }, []);

  const handleConsentResponse = useCallback((requestId: string, approved: boolean, scope?: 'once' | 'session' | 'permanent') => {
    setConsent(null);
    vscode.postMessage({ type: 'consentResponse', requestId, approved, scope });
  }, []);

  const handleConfirmationResponse = useCallback((requestId: string, value: string) => {
    setConfirmation(null);
    vscode.postMessage({ type: 'confirmationResponse', requestId, value });
  }, []);

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

  const handleModeSelect = useCallback((selectedMode: 'inline' | 'plan' | 'act') => {
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
    }
  }, []);

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
          onBack={() => setShowConfig(false)}
          onFetchModels={handleFetchModels}
          models={models}
          modelsLoading={modelsLoading}
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
      <MessageList messages={messages} loading={loading} />

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
      />
      {config.configured && config.modelCapabilities && !config.modelCapabilities.tools && (
        <div className="model-capability-warning" title="Tool calling unavailable for the active model">
          ⚠ <strong>{config.llmModel}</strong> doesn't support tool calling — Chat/Plan/Act run as plain chat (no tools, no file edits, no delegation).
        </div>
      )}
    </div>
  );
}

export default App;

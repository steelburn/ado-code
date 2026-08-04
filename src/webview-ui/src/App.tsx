import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types';
import { WelcomeScreen } from './components/WelcomeScreen';
import { TaskDetailPanel } from './components/TaskDetailPanel';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';
import { AgentBar } from './components/AgentBar';
import { KebabMenu } from './components/KebabMenu';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { AgentOutputPanel } from './components/AgentOutputPanel';
import { ConsentCard, ConsentRequest } from './components/ConsentCard';
import './styles/app.css';
import './styles/markdown.css';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToExtensionMessage): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

interface SanitizedConfig {
  adoOrganization: string;
  adoProject: string;
  llmProvider: string;
  llmApiUrl: string;
  llmModel: string;
  mode?: 'inline' | 'plan' | 'act';
  configured: boolean;
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

  // Agent state
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [showAgentBar, setShowAgentBar] = useState(false);
  const [agentRun, setAgentRun] = useState<any>(null);
  const [agentOutput, setAgentOutput] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string; state: string }>>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // Input draft lives in App so toolbar tools (add context / attach files) can
  // append to it; InputBar renders it controlled.
  const [draft, setDraft] = useState('');
  // Pending consent: the agent (inline mode) wants to run a mutating tool.
  const [consent, setConsent] = useState<ConsentRequest | null>(null);
  // Wizard model picker (LLM provider)
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Ensures the main-view project switcher fetches the org project list once
  // per webview session (message-handler closures are stale, so a ref, not
  // state, gates the one-shot fetch).
  const projectsRequestedRef = useRef(false);

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
          if (!selectedAgent && msg.agents.length > 0) {
            setSelectedAgent(msg.agents[0].name);
          }
          break;

        case 'historyRestored':
          setMessages(msg.messages.map(m => ({ role: m.role, content: m.content })));
          break;

        case 'workItemDetail':
          setDetail(msg.item as unknown as WorkItemDetail);
          if (msg.item) setShowAgentBar(true);
          break;

        case 'taskReplies':
          if (detail && detail.id === msg.workItemId) {
            setDetail(prev => prev ? { ...prev, comments: msg.comments } : prev);
          }
          break;

        case 'agentStatus':
          // Show agent bar when delegation is active
          setShowAgentBar(true);
          setAgentRun(msg.run);
          // Append streaming output
          if (msg.delta) {
            setAgentOutput(prev => prev + msg.delta);
          }
          break;

        case 'agentResult':
          setAgentRun(msg.run);
          setAgentOutput(prev => prev + '\n\n' + msg.summary);
          setLoading(false);
          break;

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
    const saved = vscode.getState()?.history;
    if (Array.isArray(saved) && saved.length > 0) {
      setMessages(saved);
    }

    vscode.postMessage({ type: 'getConfig' });
    vscode.postMessage({ type: 'listAgents' });

    return () => window.removeEventListener('message', handler);
  }, []);

  // Persist history
  useEffect(() => {
    vscode.setState({ history: messages });
  }, [messages]);

  // ── Actions ────────────────────────────────────────────────────
  const handleSend = useCallback((content: string) => {
    setMessages(prev => [...prev, { role: 'user', content }]);
    vscode.postMessage({ type: 'userMessage', content });
    setDraft('');
    setLoading(true); // Show loading indicator immediately
    // A new turn aborts any in-flight run — the host denies the pending
    // prompt; drop the card here too.
    setConsent(null);
  }, []);

  const handleConsentResponse = useCallback((requestId: string, approved: boolean) => {
    setConsent(null);
    vscode.postMessage({ type: 'consentResponse', requestId, approved });
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
    setShowAgentBar(false);
  }, []);

  const handleAgentSelect = useCallback((name: string) => {
    setSelectedAgent(name);
  }, []);

  // ── Kebab menu actions ───────────────────────────────────────
  const handleKebabAction = useCallback((action: string) => {
    switch (action) {
      case 'rerunWizard':
        vscode.postMessage({ type: 'rerunWizard' });
        break;
      case 'openSettings':
        vscode.postMessage({ type: 'openSettings' });
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

  const handleRefreshWorkItems = useCallback(() => {
    vscode.postMessage({ type: 'fetchWorkItems' });
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

      {/* Chat header with project switcher + kebab menu */}
      <div className="chat-header">
        <span className="chat-header-title">ADO Code</span>
        <button className="header-refresh-btn" title="Refresh work items" onClick={handleRefreshWorkItems}>↻</button>
        <ProjectSwitcher
          projects={projects}
          current={config.adoProject}
          loading={projectsLoading}
          onSwitch={handleSwitchProject}
          onRefresh={handleFetchProjects}
        />
        <KebabMenu
          items={[
            { label: 'Rerun Setup Wizard', icon: '🔄', action: 'rerunWizard' },
            { label: 'Configuration…', icon: '⚙', action: 'openSettings' },
          ]}
          onSelect={handleKebabAction}
        />
      </div>

      {/* Agent output panel (when agent is running) */}
      <AgentOutputPanel run={agentRun} output={agentOutput} loading={loading} />

      {/* Messages */}
      <MessageList messages={messages} loading={loading} />

      {/* Agent bar (contextual — only when WI is active) */}
      <AgentBar
        agents={agents}
        selectedAgent={selectedAgent}
        onSelect={handleAgentSelect}
        visible={showAgentBar}
      />

      {/* Consent card — agent wants to run a mutating tool (inline mode) */}
      {consent && (
        <ConsentCard request={consent} onRespond={handleConsentResponse} />
      )}

      {/* Input */}
      <InputBar
        mode={mode}
        value={draft}
        onValueChange={setDraft}
        onSend={handleSend}
        onClear={handleClear}
        onModeSelect={handleModeSelect}
        onAddContext={() => vscode.postMessage({ type: 'getEditorContext' })}
        onAttachFiles={() => vscode.postMessage({ type: 'pickFiles' })}
        loading={loading ? mode : ''}
      />
    </div>
  );
}

export default App;

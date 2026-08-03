import React, { useState, useEffect, useCallback } from 'react';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types';
import { WelcomeScreen } from './components/WelcomeScreen';
import { TaskDetailPanel } from './components/TaskDetailPanel';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';
import { AgentBar } from './components/AgentBar';
import { KebabMenu } from './components/KebabMenu';
import { AgentOutputPanel } from './components/AgentOutputPanel';
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

  // ── Message handler ────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'assistantMessage':
          setMessages(prev => {
            if (msg.done) {
              setLoading(false);
              return prev;
            }
            setLoading(true);
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
          break;

        case 'config':
          setConfig(msg.config as unknown as SanitizedConfig);
          break;

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
  }, []);

  const handleClear = useCallback(() => {
    vscode.postMessage({ type: 'clearConversation' });
    setMessages([]);
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

  const handleModeChange = useCallback(() => {
    vscode.postMessage({ type: 'cycleMode' });
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

  const handleFetchProjects = useCallback(() => {
    setProjectsLoading(true);
    vscode.postMessage({ type: 'fetchProjects' });
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

      {/* Chat header with kebab menu */}
      <div className="chat-header">
        <span className="chat-header-title">ADO Code</span>
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

      {/* Input */}
      <InputBar
        mode={mode}
        onSend={handleSend}
        onClear={handleClear}
        onModeChange={handleModeChange}
        loading={loading ? mode : ''}
      />
    </div>
  );
}

export default App;

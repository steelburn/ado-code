import React, { useState, useEffect } from 'react';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { LoadingSpinner } from './components/LoadingSpinner';
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

function App() {
  const [messages, setMessages] = useState<{role: string; content: string}[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<SanitizedConfig | null>(null);
  const [form, setForm] = useState({ adoOrganization: '', adoProject: '', adoPat: '', llmProvider: 'openai', llmApiUrl: 'https://api.openai.com/v1', llmApiKey: '', llmModel: 'gpt-4o' });
  // Task 24/25: agent picker + follow-up UI
  const [agents, setAgents] = useState<{name: string; displayName: string; installed: boolean}[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [followUp, setFollowUp] = useState('');
  // Task 28: task detail panel
  const [detail, setDetail] = useState<any>(null);
  const [clarifyQuestion, setClarifyQuestion] = useState('');

  useEffect(() => {
    window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'assistantMessage':
          // Stream accumulation: append chunks to the CURRENT assistant bubble,
          // and only seal it when done:true arrives. Prevents N bubbles per turn.
          setMessages(prev => {
            if (msg.done) {
              setLoading(false);
              return prev; // bubble already final; message stream ended
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
        case 'agentList':
          setAgents(msg.agents.map(a => ({ name: a.name, displayName: a.displayName, installed: a.installed })));
          if (!selectedAgent && msg.agents.length > 0) setSelectedAgent(msg.agents[0].name);
          break;
        case 'historyRestored':
          setMessages(msg.messages.map(m => ({ role: m.role, content: m.content })));
          break;
        case 'workItemDetail':
          setDetail(msg.item);
          break;
        case 'taskReplies':
          if (detail && detail.id === msg.workItemId) {
            setDetail({ ...detail, comments: msg.comments });
          }
          break;
      }
    });

    // Q4 (webview side): restore history across sidebar re-opens (Task 4 APIs)
    const saved = vscode.getState()?.history;
    if (Array.isArray(saved) && saved.length > 0) {
      setMessages(saved);
    }

    vscode.postMessage({ type: 'getConfig' });
    vscode.postMessage({ type: 'listAgents' });
  }, []);

  // Q4: persist webview history on every change
  useEffect(() => {
    vscode.setState({ history: messages });
  }, [messages]);

  const saveSetup = () => {
    vscode.postMessage({ type: 'updateConfig', config: {
      adoOrganization: form.adoOrganization,
      adoProject: form.adoProject,
      adoPat: form.adoPat,
      llmProvider: form.llmProvider,
      llmApiUrl: form.llmApiUrl,
      llmApiKey: form.llmApiKey,
      llmModel: form.llmModel,
    } });
  };

  const sendMessage = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { role: 'user', content: input }]);
    vscode.postMessage({ type: 'userMessage', content: input });
    setInput('');
  };

  // Welcome screen when not configured
  if (config && !config.configured) {
    return (
      <div style={{ padding: '16px', overflow: 'auto', height: '100vh' }}>
        <h2>Welcome to ADO Code</h2>
        <p>Connect Azure DevOps and your LLM to get started.</p>

        <h3>Azure DevOps</h3>
        <label>Organization <input value={form.adoOrganization} onChange={e => setForm({...form, adoOrganization: e.target.value})} placeholder="mycompany" style={{ width: '100%' }} /></label>
        <label>Project <input value={form.adoProject} onChange={e => setForm({...form, adoProject: e.target.value})} placeholder="MyProject" style={{ width: '100%' }} /></label>
        <label>PAT <input value={form.adoPat} type="password" onChange={e => setForm({...form, adoPat: e.target.value})} placeholder="Azure DevOps Personal Access Token (vso.work_write)" style={{ width: '100%' }} /></label>
        <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>
          Create a PAT at <a href="https://dev.azure.com">dev.azure.com</a> → User settings → Personal Access Tokens, with <code>Work Items (Read, Write &amp; Manage)</code> scope.
        </p>

        <h3>LLM</h3>
        <label>Provider
          <select value={form.llmProvider} onChange={e => setForm({...form, llmProvider: e.target.value})} style={{ width: '100%' }}>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>API URL <input value={form.llmApiUrl} onChange={e => setForm({...form, llmApiUrl: e.target.value})} style={{ width: '100%' }} /></label>
        <label>API Key <input value={form.llmApiKey} type="password" onChange={e => setForm({...form, llmApiKey: e.target.value})} style={{ width: '100%' }} /></label>
        <label>Model <input value={form.llmModel} onChange={e => setForm({...form, llmModel: e.target.value})} style={{ width: '100%' }} /></label>
        <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>
          Self-hosted: Ollama <code>http://localhost:11434/v1</code>, LM Studio <code>http://localhost:1234/v1</code>, or any OpenAI-compatible endpoint.
        </p>

        <button onClick={saveSetup} style={{ marginTop: '12px', width: '100%' }}>Save Settings</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '8px' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {detail && (
          <div style={{ margin: '4px 0 12px', padding: '8px', borderRadius: '4px', border: '1px solid var(--vscode-panel-border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>ADO-{detail.id}: {detail.title}</strong>
              <span style={{ fontSize: '11px', background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', padding: '1px 6px', borderRadius: '8px' }}>{detail.state}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
              {detail.workItemType} · {detail.assignedTo}{detail.creator ? ` · created by ${detail.creator}` : ''}
            </div>
            {detail.description && <p style={{ margin: '6px 0' }}><strong>Description:</strong> {detail.description}</p>}
            {detail.acceptanceCriteria && <p style={{ margin: '6px 0' }}><strong>Acceptance criteria:</strong> {detail.acceptanceCriteria}</p>}
            {detail.tags && <p style={{ margin: '6px 0', fontSize: '11px' }}><strong>Tags:</strong> {detail.tags}</p>}
            {detail.comments && detail.comments.length > 0 && (
              <div style={{ marginTop: '6px' }}>
                <strong>Discussion:</strong>
                {detail.comments.map((c: any, i: number) => (
                  <div key={i} style={{ fontSize: '12px', margin: '2px 0' }}>— {c.createdBy?.displayName ?? c.author}: {c.text}</div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
              <input value={clarifyQuestion} onChange={e => setClarifyQuestion(e.target.value)}
                style={{ flex: 1 }} placeholder="Question for the creator…" />
              <button onClick={() => {
                if (clarifyQuestion.trim()) {
                  vscode.postMessage({ type: 'requestClarification', workItemId: detail.id, question: clarifyQuestion, mentionCreator: true });
                  setClarifyQuestion('');
                }
              }}>Request Clarification</button>
              <button onClick={() => vscode.postMessage({ type: 'checkTaskReplies', workItemId: detail.id })}>Check Replies</button>
            </div>
          </div>
        )}
        {error && (
          <div style={{ padding: '8px', margin: '4px 0', borderRadius: '4px',
            background: 'var(--vscode-inputValidation-errorBackground)', color: 'var(--vscode-inputValidation-errorForeground)' }}>
            <strong>Error:</strong> {error}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ margin: '4px 0', padding: '8px', borderRadius: '4px',
            background: m.role === 'user' ? 'var(--vscode-editor-background)' : 'var(--vscode-sideBar-background)' }}>
            <strong>{m.role === 'user' ? 'You' : 'ADO Code'}:</strong>{' '}
            {m.role === 'user' ? m.content : <MarkdownRenderer content={m.content} />}
          </div>
        ))}
        {loading && <LoadingSpinner />}
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <select value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)}
          style={{ maxWidth: '110px' }} title="Agent for delegation">
          {agents.map(a => (
            <option key={a.name} value={a.name} disabled={!a.installed}>
              {a.displayName}{a.installed ? '' : ' (not installed)'}
            </option>
          ))}
        </select>
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          style={{ flex: 1 }} placeholder="Ask anything... (try /status Done or /comment ...)" />
        <button onClick={sendMessage}>Send</button>
        <button onClick={() => vscode.postMessage({ type: 'clearConversation' })} title="Clear chat history">Clear</button>
      </div>
      <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
        <input value={followUp} onChange={e => setFollowUp(e.target.value)}
          style={{ flex: 1 }} placeholder="Follow-up to last agent run (if it supports sessions)..." />
        <button onClick={() => { vscode.postMessage({ type: 'agentFollowUp', runId: '', prompt: followUp }); setFollowUp(''); }}
          title="Follow-up — uses the most recent run's session">Follow-up</button>
      </div>
    </div>
  );
}

export default App;

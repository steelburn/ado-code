import React, { useState, useEffect, useCallback } from 'react';

declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

interface Props {
  onBack: () => void;
}

interface ConfigSection {
  title: string;
  icon: string;
  settings: ConfigSetting[];
}

interface ConfigSetting {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'enum' | 'array';
  description: string;
  options?: string[];
  placeholder?: string;
}

const SECTIONS: ConfigSection[] = [
  {
    title: 'Azure DevOps',
    icon: '🔵',
    settings: [
      { key: 'adoOrganization', label: 'Organization', type: 'string', description: 'ADO organization name (e.g. mycompany)', placeholder: 'mycompany' },
      { key: 'adoProject', label: 'Project', type: 'string', description: 'Active ADO project name', placeholder: 'MyProject' },
      { key: 'adoPat', label: 'Personal Access Token', type: 'password', description: 'ADO PAT with Work Items + Project scope', placeholder: 'vso.work_write' },
      { key: 'adoServerUrl', label: 'Server URL (on-prem)', type: 'string', description: 'For ADO Server (TFS) — leave empty for cloud', placeholder: 'https://ado.corp.local/tfs/DefaultCollection' },
    ],
  },
  {
    title: 'LLM Provider',
    icon: '🤖',
    settings: [
      { key: 'llmProvider', label: 'Provider', type: 'enum', description: 'LLM API format', options: ['openai', 'anthropic'] },
      { key: 'llmApiUrl', label: 'API URL', type: 'string', description: 'LLM API base URL', placeholder: 'https://api.openai.com/v1' },
      { key: 'llmApiKey', label: 'API Key', type: 'password', description: 'LLM API key', placeholder: 'sk-...' },
      { key: 'llmModel', label: 'Model', type: 'string', description: 'Model name', placeholder: 'gpt-4o' },
    ],
  },
  {
    title: 'Mode',
    icon: '⚡',
    settings: [
      { key: 'mode', label: 'Default Mode', type: 'enum', description: 'Tool-use mode for new conversations', options: ['inline', 'plan', 'act'] },
    ],
  },
  {
    title: 'Git',
    icon: '🌿',
    settings: [
      { key: 'git.requireGitRepo', label: 'Require Git repo', type: 'boolean', description: 'Block task pickup when not in a git repo' },
      { key: 'git.createBranchOnTaskStart', label: 'Create branch on task start', type: 'boolean', description: 'Auto-create feature/ADO-<id> branch' },
      { key: 'git.requireCleanTree', label: 'Require clean tree', type: 'boolean', description: 'Warn on branch switch with uncommitted changes' },
      { key: 'git.prOnCompletion', label: 'PR on completion', type: 'boolean', description: 'Offer to push + create PR via gh on task done' },
    ],
  },
  {
    title: 'Changelog',
    icon: '📝',
    settings: [
      { key: 'changelog.enabled', label: 'Enabled', type: 'boolean', description: 'Update CHANGELOG.md on task completion' },
      { key: 'changelog.autoCommit', label: 'Auto-commit', type: 'boolean', description: 'Commit CHANGELOG.md automatically' },
      { key: 'changelog.postToAdo', label: 'Post to ADO', type: 'boolean', description: 'Add changelog entry as ADO comment' },
    ],
  },
  {
    title: 'Work Items',
    icon: '📋',
    settings: [
      { key: 'ado.clarificationState', label: 'Clarification state', type: 'string', description: 'State to set when clarification is requested', placeholder: 'Blocked' },
      { key: 'ado.warnOnSparseTask', label: 'Warn on sparse tasks', type: 'boolean', description: 'Warn before starting tasks with no description or AC' },
    ],
  },
  {
    title: 'Act Mode',
    icon: '🚀',
    settings: [
      { key: 'act.toolBudget', label: 'Tool budget', type: 'number', description: 'Max tool calls per act-mode turn' },
      { key: 'act.terminalAllowlist', label: 'Terminal allowlist', type: 'array', description: 'Allowed command prefixes in act mode' },
    ],
  },
  {
    title: 'Sessions',
    icon: '🕐',
    settings: [
      { key: 'sessions.maxPerProject', label: 'Max sessions per project', type: 'number', description: 'Older sessions auto-pruned beyond this limit' },
    ],
  },
  {
    title: 'Agents',
    icon: '🧑‍💻',
    settings: [
      { key: 'agents.enabled', label: 'Enabled agents', type: 'array', description: 'Which agents may be delegated to' },
      { key: 'agents.verifyCommand', label: 'Verify command', type: 'string', description: 'Shell command to run after agent finishes (e.g. npm test)', placeholder: 'npm test' },
      { key: 'agents.autoSelect', label: 'Default agent', type: 'enum', description: 'Default agent when none specified', options: ['', 'claude', 'codex', 'opencode', 'hermes', 'pi', 'openclaw', 'aider', 'gemini', 'cursor-agent'] },
    ],
  },
];

export function ConfigurationPage({ onBack }: Props) {
  const [config, setConfig] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'fullConfig') {
        setConfig(msg.config);
        setLoading(false);
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getConfig' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleChange = useCallback((key: string, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  }, []);

  const handleSave = useCallback(() => {
    vscode.postMessage({ type: 'saveConfig', config });
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [config]);

  if (loading) {
    return (
      <div className="config-page">
        <div className="config-loading">Loading settings…</div>
      </div>
    );
  }

  return (
    <div className="config-page">
      <div className="config-header">
        <button className="config-back" onClick={onBack} title="Back to chat">← Back</button>
        <h2 className="config-title">Configuration</h2>
        <button
          className={`config-save ${dirty ? 'config-save-dirty' : ''}`}
          onClick={handleSave}
          disabled={!dirty}
        >
          {saved ? '✓ Saved' : 'Save'}
        </button>
      </div>

      <div className="config-body">
        {SECTIONS.map(section => (
          <div key={section.title} className="config-section">
            <h3 className="config-section-title">
              <span className="config-section-icon">{section.icon}</span>
              {section.title}
            </h3>
            {section.settings.map(setting => (
              <div key={setting.key} className="config-field">
                <label className="config-label">{setting.label}</label>
                <div className="config-desc">{setting.description}</div>
                {setting.type === 'boolean' ? (
                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={!!config[setting.key]}
                      onChange={e => handleChange(setting.key, e.target.checked)}
                    />
                    <span className="config-toggle-slider" />
                  </label>
                ) : setting.type === 'enum' ? (
                  <select
                    className="config-select"
                    value={config[setting.key] ?? ''}
                    onChange={e => handleChange(setting.key, e.target.value)}
                  >
                    {setting.options?.map(opt => (
                      <option key={opt} value={opt}>{opt || '(none)'}</option>
                    ))}
                  </select>
                ) : setting.type === 'number' ? (
                  <input
                    className="config-input"
                    type="number"
                    value={config[setting.key] ?? ''}
                    onChange={e => handleChange(setting.key, Number(e.target.value))}
                  />
                ) : setting.type === 'array' ? (
                  <input
                    className="config-input"
                    value={Array.isArray(config[setting.key]) ? config[setting.key].join(', ') : ''}
                    onChange={e => handleChange(setting.key, e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                    placeholder={setting.placeholder}
                  />
                ) : (
                  <input
                    className="config-input"
                    type={setting.type === 'password' ? 'password' : 'text'}
                    value={config[setting.key] ?? ''}
                    onChange={e => handleChange(setting.key, e.target.value)}
                    placeholder={setting.placeholder}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

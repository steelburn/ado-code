import React, { useState, useEffect } from 'react';

interface Props {
  config: {
    adoOrganization: string;
    adoProject: string;
    llmProvider: string;
    llmApiUrl: string;
    llmModel: string;
  };
  onSave: (config: {
    adoOrganization: string;
    adoProject: string;
    adoPat: string;
    llmProvider: string;
    llmApiUrl: string;
    llmApiKey: string;
    llmModel: string;
  }) => void;
  onFetchProjects: () => void;
  projects: Array<{ id: string; name: string; state: string }>;
  projectsLoading: boolean;
}

export function WelcomeScreen({ config, onSave, onFetchProjects, projects, projectsLoading }: Props) {
  const [form, setForm] = useState({
    adoOrganization: config.adoOrganization || '',
    adoProject: config.adoProject || '',
    adoPat: '',
    llmProvider: config.llmProvider || 'openai',
    llmApiUrl: config.llmApiUrl || 'https://api.openai.com/v1',
    llmApiKey: '',
    llmModel: config.llmModel || 'gpt-4o',
  });

  const update = (field: string, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }));

  // Auto-fetch projects when org and PAT are filled
  useEffect(() => {
    if (form.adoOrganization && form.adoPat && projects.length === 0 && !projectsLoading) {
      onFetchProjects();
    }
  }, [form.adoOrganization, form.adoPat]);

  return (
    <div className="welcome">
      <div className="welcome-header">
        <h1>ADO Code</h1>
        <p>AI coding assistant with Azure DevOps integration</p>
      </div>

      <div className="welcome-card">
        <h2>Azure DevOps</h2>

        <div className="form-group">
          <label className="form-label">Organization</label>
          <input
            className="form-input"
            value={form.adoOrganization}
            onChange={e => update('adoOrganization', e.target.value)}
            placeholder="mycompany"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Personal Access Token</label>
          <input
            className="form-input"
            type="password"
            value={form.adoPat}
            onChange={e => update('adoPat', e.target.value)}
            placeholder="vso.work_write scope"
          />
          <div className="form-hint">
            Create at <a href="https://dev.azure.com">dev.azure.com</a> → User Settings → PATs.
            Required scope: <code>Work Items (Read, Write &amp; Manage)</code> + <code>Project & Team (Read)</code>.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Project</label>
          {projects.length > 0 ? (
            <select
              className="form-select"
              value={form.adoProject}
              onChange={e => update('adoProject', e.target.value)}
            >
              <option value="">Select a project…</option>
              {projects.map(p => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
          ) : (
            <input
              className="form-input"
              value={form.adoProject}
              onChange={e => update('adoProject', e.target.value)}
              placeholder={projectsLoading ? 'Fetching projects…' : 'MyProject'}
              disabled={projectsLoading}
            />
          )}
          {projectsLoading && (
            <div className="form-hint">Fetching projects from ADO…</div>
          )}
          {!projectsLoading && projects.length === 0 && form.adoOrganization && form.adoPat && (
            <div className="form-hint">
              <a href="#" onClick={e => { e.preventDefault(); onFetchProjects(); }}>Refresh project list</a>
            </div>
          )}
        </div>
      </div>

      <div className="welcome-card">
        <h2>LLM Provider</h2>

        <div className="form-group">
          <label className="form-label">Provider</label>
          <select
            className="form-select"
            value={form.llmProvider}
            onChange={e => update('llmProvider', e.target.value)}
          >
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">API URL</label>
          <input
            className="form-input"
            value={form.llmApiUrl}
            onChange={e => update('llmApiUrl', e.target.value)}
          />
          <div className="form-hint">
            Self-hosted: Ollama <code>http://localhost:11434/v1</code>, LM Studio <code>http://localhost:1234/v1</code>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">API Key</label>
          <input
            className="form-input"
            type="password"
            value={form.llmApiKey}
            onChange={e => update('llmApiKey', e.target.value)}
            placeholder="sk-..."
          />
        </div>

        <div className="form-group">
          <label className="form-label">Model</label>
          <input
            className="form-input"
            value={form.llmModel}
            onChange={e => update('llmModel', e.target.value)}
            placeholder="gpt-4o"
          />
        </div>
      </div>

      <button
        className="btn btn-primary btn-block"
        onClick={() => onSave(form)}
        disabled={!form.adoOrganization || !form.adoProject || !form.adoPat || !form.llmApiKey}
      >
        Save &amp; Continue
      </button>
    </div>
  );
}

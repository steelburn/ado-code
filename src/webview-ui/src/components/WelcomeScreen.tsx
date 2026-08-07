import React, { useState, useEffect, useRef } from 'react';

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
  onFetchProjects: (organization?: string, pat?: string) => void;
  projects: Array<{ id: string; name: string; state: string }>;
  projectsLoading: boolean;
  onFetchModels: (provider?: string, apiUrl?: string, apiKey?: string) => void;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  modelsLoading: boolean;
}

export function WelcomeScreen({ config, onSave, onFetchProjects, projects, projectsLoading, onFetchModels, models, modelsLoading }: Props) {
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

  // Auto-fetch projects once org+PAT are filled, using the TYPED credentials
  // (the host fetches with them before they're saved). Guard with a ref so a
  // persistent failure (bad PAT, offline) can't re-trigger on every render —
  // only a credential change re-fires. `projects.length === 0` keeps it from
  // clobbering an already-populated list.
  const lastFetchKey = useRef('');
  useEffect(() => {
    const key = `${form.adoOrganization}::${form.adoPat}`;
    if (
      form.adoOrganization &&
      form.adoPat &&
      projects.length === 0 &&
      !projectsLoading &&
      lastFetchKey.current !== key
    ) {
      lastFetchKey.current = key;
      onFetchProjects(form.adoOrganization, form.adoPat);
    }
  }, [form.adoOrganization, form.adoPat, projects.length, projectsLoading, onFetchProjects]);

  // Auto-fetch the model list once API URL + API Key are filled (provider is
  // part of the key too). Same ref-guard: only a credentials change re-fires;
  // the Refresh button handles manual retries.
  const lastModelsFetchKey = useRef('');
  useEffect(() => {
    const key = `${form.llmProvider}::${form.llmApiUrl}::${form.llmApiKey}`;
    if (
      form.llmApiUrl &&
      form.llmApiKey &&
      !modelsLoading &&
      lastModelsFetchKey.current !== key
    ) {
      lastModelsFetchKey.current = key;
      onFetchModels(form.llmProvider, form.llmApiUrl, form.llmApiKey);
    }
  }, [form.llmProvider, form.llmApiUrl, form.llmApiKey, modelsLoading, onFetchModels]);

  const refreshModels = () => {
    onFetchModels(form.llmProvider, form.llmApiUrl, form.llmApiKey);
  };

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
              <a href="#" onClick={e => { e.preventDefault(); onFetchProjects(form.adoOrganization, form.adoPat); }}>Refresh project list</a>
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
          {models.length > 0 ? (
            <div className="form-row">
              <select
                className="form-select"
                value={form.llmModel}
                onChange={e => update('llmModel', e.target.value)}
              >
                <option value="">Select a model…</option>
                {(models.some(m => m.id === form.llmModel) ? models : [{ id: form.llmModel }, ...models]).map(m => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
              </select>
              <button
                className="btn-icon"
                onClick={refreshModels}
                title="Refresh model list"
                disabled={modelsLoading || !form.llmApiUrl || !form.llmApiKey}
              >
                ↻
              </button>
            </div>
          ) : (
            <div className="form-row">
              <input
                className="form-input"
                value={form.llmModel}
                onChange={e => update('llmModel', e.target.value)}
                placeholder={modelsLoading ? 'Fetching models…' : 'gpt-4o'}
              />
              <button
                className="btn-icon"
                onClick={refreshModels}
                title="Refresh model list"
                disabled={modelsLoading || !form.llmApiUrl || !form.llmApiKey}
              >
                ↻
              </button>
            </div>
          )}
          {modelsLoading && (
            <div className="form-hint">Fetching models from the API…</div>
          )}
          {!modelsLoading && models.length === 0 && form.llmApiUrl && form.llmApiKey && (
            <div className="form-hint">
              <a href="#" onClick={e => { e.preventDefault(); refreshModels(); }}>Refresh model list</a>
            </div>
          )}
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

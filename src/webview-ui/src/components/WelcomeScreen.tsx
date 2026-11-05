import React, { useState, useEffect, useRef } from 'react';

interface Props {
  config: {
    adoOrganization: string;
    adoProject: string;
    llmProvider: string;
    llmApiUrl: string;
    llmModel: string;
    /** Which secrets the HOST already stores — the values are never echoed. */
    secretConfigured?: { adoPat: boolean; llmApiKey: boolean };
    /** Set when the host could not read the stored settings at all. */
    startupError?: string;
  };
  onSave: (config: {
    adoOrganization: string;
    adoProject: string;
    adoPat?: string;
    llmProvider: string;
    llmApiUrl: string;
    llmApiKey?: string;
    /** Optional: an unknown model is left untouched instead of blanked. */
    llmModel?: string;
  }) => void;
  onFetchProjects: (organization?: string, pat?: string) => void;
  projects: Array<{ id: string; name: string; state: string }>;
  projectsLoading: boolean;
  onFetchModels: (provider?: string, apiUrl?: string, apiKey?: string) => void;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  modelsLoading: boolean;
}

/**
 * F5: provider-aware defaults. The hard-coded OpenAI URL/model made a re-opened
 * wizard look like a fresh OpenAI install whenever the stored config was
 * missing, and a save then overwrote the real endpoint.
 */
const DEFAULT_API_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

const defaultApiUrl = (provider?: string): string =>
  DEFAULT_API_URL[provider || 'openai'] || DEFAULT_API_URL.openai;

export function WelcomeScreen({ config, onSave, onFetchProjects, projects, projectsLoading, onFetchModels, models, modelsLoading }: Props) {
  const [form, setForm] = useState({
    adoOrganization: config.adoOrganization || '',
    adoProject: config.adoProject || '',
    adoPat: '',
    llmProvider: config.llmProvider || 'openai',
    llmApiUrl: config.llmApiUrl || defaultApiUrl(config.llmProvider),
    llmApiKey: '',
    // F5: never invent a model id for a provider we know nothing about — the
    // list fetch (or the autopick below) fills it in, and an unknown model is
    // left out of the save payload instead of being blanked.
    llmModel: config.llmModel || (config.llmProvider === 'anthropic' ? '' : 'gpt-4o'),
  });

  // Azure DevOps is OPTIONAL: the user may skip it and configure it later
  // (the chat view keeps reminding them until it's set up). Collapsing the
  // card hides its fields; "Configure now" re-opens them.
  const [adoSkipped, setAdoSkipped] = useState(false);

  // F1/F6: the host strips the secrets from the config it publishes, so "a
  // secret is already stored" is first-class wizard state. Without it the
  // re-opened wizard shows two blank secret fields, keeps Save disabled until
  // the API key is retyped, and warns "you're about to continue without Azure
  // DevOps" for an ADO setup that is perfectly configured.
  const storedAdoPat = Boolean(config.secretConfigured?.adoPat);
  const storedApiKey = Boolean(config.secretConfigured?.llmApiKey);
  // Typed value, else the stored one: the host falls back to its own settings
  // whenever the wizard leaves a secret blank.
  const hasAdoPat = Boolean(form.adoPat || storedAdoPat);
  const hasApiKey = Boolean(form.llmApiKey || storedApiKey);

  // F3: `form` is a one-shot initialiser, so a `config` republished while the
  // wizard is open (re-run, reconnect, error refresh) used to be ignored and
  // the wizard kept showing stale — often blank — values. Re-seed on every
  // publication, but never clobber edits the user already made.
  const dirty = useRef(false);
  useEffect(() => {
    if (dirty.current) return;
    setForm(prev => ({
      ...prev,
      adoOrganization: config.adoOrganization || '',
      adoProject: config.adoProject || '',
      llmProvider: config.llmProvider || 'openai',
      llmApiUrl: config.llmApiUrl || defaultApiUrl(config.llmProvider),
      llmModel: config.llmModel || prev.llmModel,
    }));
    // F6: a configured ADO setup re-opens its card; "skipped" is only a choice
    // the user makes in this session.
    if (config.adoOrganization || config.adoProject) setAdoSkipped(false);
  }, [
    config.adoOrganization,
    config.adoProject,
    config.llmProvider,
    config.llmApiUrl,
    config.llmModel,
  ]);

  const update = (field: string, value: string) => {
    dirty.current = true;
    setForm(prev => ({ ...prev, [field]: value }));
  };

  // Live check: are all ADO creds present on the form right now?
  // A stored PAT counts: the field is blank only because the host never echoes
  // it back (F6 — the wizard used to warn about "continuing without ADO" for a
  // fully configured setup).
  const adoFormComplete = Boolean(form.adoOrganization && form.adoProject && hasAdoPat);

  // Auto-fetch projects once org+PAT are filled, using the TYPED credentials
  // (the host fetches with them before they're saved). Guard with a ref so a
  // persistent failure (bad PAT, offline) can't re-trigger on every render —
  // only a credential change re-fires. `projects.length === 0` keeps it from
  // clobbering an already-populated list.
  const lastFetchKey = useRef('');
  useEffect(() => {
    // A stored PAT is usable too — the host then fetches with its own settings.
    const key = `${form.adoOrganization}::${form.adoPat || (storedAdoPat ? '<stored>' : '')}`;
    if (
      form.adoOrganization &&
      hasAdoPat &&
      projects.length === 0 &&
      !projectsLoading &&
      lastFetchKey.current !== key
    ) {
      lastFetchKey.current = key;
      onFetchProjects(form.adoOrganization, form.adoPat || undefined);
    }
  }, [
    form.adoOrganization,
    form.adoPat,
    hasAdoPat,
    storedAdoPat,
    projects.length,
    projectsLoading,
    onFetchProjects,
  ]);

  // Auto-fetch the model list once API URL + API Key are filled (provider is
  // part of the key too). Same ref-guard: only a credentials change re-fires;
  // the Refresh button handles manual retries.
  const lastModelsFetchKey = useRef('');
  useEffect(() => {
    // F1: a stored key is enough to list models — the host falls back to its
    // own settings when the wizard leaves the field blank. Without this the
    // re-opened wizard could not even show which model was selected.
    const key = `${form.llmProvider}::${form.llmApiUrl}::${form.llmApiKey || (storedApiKey ? '<stored>' : '')}`;
    if (
      form.llmApiUrl &&
      hasApiKey &&
      !modelsLoading &&
      lastModelsFetchKey.current !== key
    ) {
      lastModelsFetchKey.current = key;
      onFetchModels(form.llmProvider, form.llmApiUrl, form.llmApiKey || undefined);
    }
  }, [form.llmProvider, form.llmApiUrl, form.llmApiKey, hasApiKey, storedApiKey, modelsLoading, onFetchModels]);

  // F5: pick the first model the provider actually offers rather than keeping
  // a blank (or invented) id in the form.
  useEffect(() => {
    const first = models[0];
    if (form.llmModel || !first || !first.id) return;
    setForm(prev => (prev.llmModel ? prev : { ...prev, llmModel: first.id }));
  }, [models, form.llmModel]);

  const refreshModels = () => {
    onFetchModels(form.llmProvider, form.llmApiUrl, form.llmApiKey || undefined);
  };

  // F2: an empty secret means "not visible / unchanged", NEVER "clear" — the
  // host strips the secrets from the published config, so posting the blank
  // field back erased the stored PAT / API key. The host guards this too; not
  // sending the key at all is simply the honest wire payload.
  const buildPayload = () => {
    const payload: {
      adoOrganization: string;
      adoProject: string;
      adoPat?: string;
      llmProvider: string;
      llmApiUrl: string;
      llmApiKey?: string;
      llmModel?: string;
    } = {
      adoOrganization: form.adoOrganization,
      adoProject: form.adoProject,
      llmProvider: form.llmProvider,
      llmApiUrl: form.llmApiUrl || defaultApiUrl(form.llmProvider),
    };
    if (form.adoPat) payload.adoPat = form.adoPat;
    if (form.llmApiKey) payload.llmApiKey = form.llmApiKey;
    // An unknown model is better left untouched than blanked.
    if (form.llmModel) payload.llmModel = form.llmModel;
    return payload;
  };

  return (
    <div className="welcome">
      <div className="welcome-header">
        <h1>ADO Code</h1>
        <p>AI coding assistant with Azure DevOps integration</p>
      </div>

      {/* F5: a failed settings read returns { configured: false, startupError }.
          Showing bare provider defaults with no explanation made the wizard look
          like a fresh install — and saving then replaced the stored settings. */}
      {config.startupError && (
        <div className="welcome-save-hint">
          ⚠ Could not read the saved configuration: {config.startupError}. The values below are defaults — saving replaces the stored settings.
        </div>
      )}

      {/* LLM Provider comes FIRST — it's the only required step. */}
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
            placeholder={storedApiKey ? 'Stored — leave blank to keep it' : 'sk-...'}
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
                disabled={modelsLoading || !form.llmApiUrl || !hasApiKey}
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
                placeholder={modelsLoading ? 'Fetching models…' : 'model id'}
              />
              <button
                className="btn-icon"
                onClick={refreshModels}
                title="Refresh model list"
                disabled={modelsLoading || !form.llmApiUrl || !hasApiKey}
              >
                ↻
              </button>
            </div>
          )}
          {modelsLoading && (
            <div className="form-hint">Fetching models from the API…</div>
          )}
          {!modelsLoading && models.length === 0 && form.llmApiUrl && hasApiKey && (
            <div className="form-hint">
              <a href="#" onClick={e => { e.preventDefault(); refreshModels(); }}>Refresh model list</a>
            </div>
          )}
        </div>
      </div>

      {/* Azure DevOps comes SECOND — OPTIONAL, can be skipped and configured later. */}
      <div className="welcome-card">
        <div className="welcome-card-header">
          <h2>Azure DevOps <span className="welcome-card-badge">Optional</span></h2>
          <button
            className="welcome-skip"
            onClick={() => setAdoSkipped(v => !v)}
            type="button"
          >
            {adoSkipped ? 'Configure' : 'Skip for now'}
          </button>
        </div>

        {adoSkipped ? (
          <div className="welcome-ado-skipped">
            <div>
              <strong>Azure DevOps isn't configured.</strong> Work items, ADO task tracking, branches, and pull requests are disabled.
            </div>
            <div>
              You can set it up later anytime from the <strong>ADO Code menu → Configuration</strong>, or by re-running this wizard.
            </div>
            <button className="btn btn-secondary" onClick={() => setAdoSkipped(false)} type="button">
              Configure now
            </button>
          </div>
        ) : (
          <>
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
                placeholder={storedAdoPat ? 'Stored — leave blank to keep it' : 'vso.work_write scope'}
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
                  <option value="">None (no project)</option>
                  {/* F4: a persisted project the fetched list does not contain
                      (renamed, archived, or a token with narrower visibility)
                      must stay selectable — the model select already does this.
                      Without it the select fell back to "None" and the next
                      save dropped the stored project. */}
                  {form.adoProject && !projects.some(p => p.name === form.adoProject) && (
                    <option value={form.adoProject}>{form.adoProject} (saved)</option>
                  )}
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

            <div className="form-hint">
              Skipping is fine — you can continue with just the LLM Provider and add ADO later.
            </div>
          </>
        )}
      </div>

      {hasApiKey && !adoFormComplete && (
        <div className="welcome-save-hint">
          {form.adoOrganization && form.adoPat && !form.adoProject ? (
            <>ℹ Continuing without an attached ADO project — you can select a project anytime from the header dropdown.</>
          ) : (
            <>⚠ You're about to continue without Azure DevOps — work items, task tracking, and PR flows will stay disabled. You can configure ADO later from the ADO Code menu → Configuration.</>
          )}
        </div>
      )}

      <button
        className="btn btn-primary btn-block"
        onClick={() => onSave(buildPayload())}
        disabled={!hasApiKey}
      >
        Save &amp; Continue
      </button>
    </div>
  );
}
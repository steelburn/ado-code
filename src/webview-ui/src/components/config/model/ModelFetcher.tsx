/**
 * Model list retrieval for the LLM Provider section: visible once the user
 * has typed an API URL and API Key (saved or not — the host fetches with the
 * typed values, exactly like the setup wizard's model picker). Picking a
 * model sets `llmModel` on the form.
 */
export function ModelFetcher({
  config,
  models,
  loading,
  error,
  onFetch,
}: {
  config: Record<string, any>;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  loading: boolean;
  error: string | null;
  onFetch: (provider?: string, apiUrl?: string, apiKey?: string) => void;
}) {
  const url = String(config.llmApiUrl ?? '').trim();
  const key = String(config.llmApiKey ?? '').trim();
  if (!url || !key) {
    return (
      <div className="config-models">
        <div className="config-desc">Enter an API URL and API Key to fetch the model list.</div>
      </div>
    );
  }
  return (
    <div className="config-models">
      <button
        className="config-models-fetch"
        onClick={() => onFetch(config.llmProvider, config.llmApiUrl, config.llmApiKey)}
        disabled={loading}
        type="button"
      >
        {loading ? 'Fetching…' : models.length > 0 ? '↻ Refresh models' : 'Fetch Models'}
      </button>
      {loading && <div className="config-desc">Fetching models from {url}…</div>}
      {error && <div className="config-models-error">{error}</div>}
      {!loading && models.length > 0 && (
        <div className="config-desc">{models.length} models available — select from the dropdown above</div>
      )}
    </div>
  );
}

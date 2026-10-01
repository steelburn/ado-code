import { useState, useEffect, useCallback, useRef } from 'react';
import { vscode } from '../vscode';
import { ErrorBanner } from './common/ErrorBanner';
import './config/styles.css';
// Stage 2: the catalog and the field widgets now live in ./config/*.
import { CATEGORIES, ADVANCED_CATEGORY, MODE_ROWS } from '../../../config/catalog';
import type { ConfigCategory } from '../../../config/catalog';
import { ModelFetcher } from './config/model/ModelFetcher';
import { ModelCapabilitiesLine } from './config/model/ModelCapabilitiesLine';
import { ModeModelConfig } from './config/model/ModeModelConfig';
import { SettingField } from './config/renderers';
import type { ConfigSettingKey, ConfigValue, ConfigSettingsMap } from '../../../shared/configSchema';
import type { CapOverride } from './config/inputs/CapabilityOverridesInput';

// Typed readers for the nested settings the page renders/edits. The wire payload
// is `unknown`-shaped by contract, so it is narrowed once here instead of
// scattering `any` casts through the page.
type ModeModelMap = Record<string, { model?: string; reasoningEffort?: string }>;
const asModeModelMap = (v: unknown): ModeModelMap =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as ModeModelMap) : {};
const asEffortMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
const asCapOverrides = (v: unknown): CapOverride[] => (Array.isArray(v) ? (v as CapOverride[]) : []);

interface Props {
  onBack: () => void;
  /** Fetch model ids with typed-but-unsaved LLM credentials (host does the call). */
  onFetchModels?: (provider?: string, apiUrl?: string, apiKey?: string) => void;
  models?: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  modelsLoading?: boolean;
}

export function ConfigurationPage({ onBack, onFetchModels, models, modelsLoading }: Props) {
  const [config, setConfig] = useState<ConfigSettingsMap>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Host fetch/save failures for this page. It keeps its own state and renders
  // a shared <ErrorBanner> because App early-returns before the global banner mounts.
  const [fetchError, setFetchError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Active sidebar category (the Advanced category is only reachable while the
  // Advanced Configuration toggle is on).
  const [activeCategory, setActiveCategory] = useState('connection');

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'fullConfig') {
        setConfig(msg.config as ConfigSettingsMap);
        setLoading(false);
      } else if (msg.type === 'error') {
        setFetchError(msg.message);
        // A host-side save failure must not leave the stale "✓ Saved" flash.
        setSaved(false);
        setDirty(true);
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getFullConfig' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // Clear the "Saved" flash timer on unmount so a late timeout cannot fire a
  // state update on an unmounted component.
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  // 0.6.5: populate the model DROPDOWNS automatically — fetch the provider's
  // model list once when the page opens with saved LLM credentials (Refresh is
  // still available on the page). Previously every model control (Advanced
  // per-mode rows, capability overrides, choice-detection model) silently
  // fell back to a plain text field until the user manually fetched in
  // Connection → LLM Provider.
  const autoFetchedModels = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (autoFetchedModels.current) return;
    const url = String(config.llmApiUrl ?? '').trim();
    const key = String(config.llmApiKey ?? '').trim();
    if (!url || !key) return;
    autoFetchedModels.current = true; // once per page open; manual Refresh afterwards
    onFetchModels?.(String(config.llmProvider ?? 'openai'), url, key);
    // Run once when settings finish loading; model-list updates arrive via props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const handleChange = useCallback((key: ConfigSettingKey, value: ConfigValue) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  }, []);

  const handleSave = useCallback(() => {
    vscode.postMessage({ type: 'saveConfig', config });
    setDirty(false);
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2000);
  }, [config]);

  const handleToggleAdvanced = useCallback(() => {
    const next = !config.advancedConfig;
    setConfig(prev => ({ ...prev, advancedConfig: next }));
    setDirty(true);
    setSaved(false);
    // Toggling on jumps straight to the Advanced category; toggling off while
    // viewing it falls back to Connection.
    if (next) {
      setActiveCategory('advanced');
    } else if (activeCategory === 'advanced') {
      setActiveCategory('connection');
    }
  }, [config.advancedConfig, activeCategory]);

  const isAdvanced = !!config.advancedConfig;

  // Handle per-mode model config changes
  const handleModeModelChange = useCallback((mode: string, model: string) => {
    setConfig(prev => {
      const modeConfigs = { ...asModeModelMap(prev['llm.modeConfigs']) };
      if (model) {
        modeConfigs[mode] = { model };
      } else {
        delete modeConfigs[mode];
      }
      return { ...prev, 'llm.modeConfigs': modeConfigs as unknown as ConfigValue };
    });
    setDirty(true);
    setSaved(false);
  }, []);

  const handleModeReasoningEffortChange = useCallback((mode: string, effort: string) => {
    setConfig(prev => {
      const modeReasoning = { ...asEffortMap(prev['llm.modeReasoningEffort']) };
      if (effort) {
        modeReasoning[mode] = effort;
      } else {
        delete modeReasoning[mode];
      }
      return { ...prev, 'llm.modeReasoningEffort': modeReasoning as unknown as ConfigValue };
    });
    setDirty(true);
    setSaved(false);
  }, []);

  if (loading) {
    return (
      <div className="config-page">
        <div className="config-loading">Loading settings…</div>
      </div>
    );
  }

  const modeConfigs = asModeModelMap(config['llm.modeConfigs']);
  const modeReasoningEffort = asEffortMap(config['llm.modeReasoningEffort']);
  // Sidebar categories — Advanced only appears while the toggle is on.
  const categories = isAdvanced ? [...CATEGORIES, ADVANCED_CATEGORY] : CATEGORIES;
  const active = categories.find(c => c.id === activeCategory) ?? categories[0];
  const categorySettingCount = (c: ConfigCategory) =>
    c.sections.reduce((n, s) => n + s.settings.length, 0) + (c.extraRows?.length ?? 0);

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

      <ErrorBanner message={fetchError} onDismiss={() => setFetchError(null)} />

      <div className="config-layout">
        {/* Sidebar navigation — one entry per category; Advanced appears
            only while the Advanced Configuration toggle is on. */}
        <nav className="config-nav">
          {categories.map(category => (
            <button
              key={category.id}
              type="button"
              className={`config-nav-item ${active.id === category.id ? 'config-nav-item-active' : ''}`}
              onClick={() => setActiveCategory(category.id)}
              title={category.title}
            >
              <span className="config-nav-icon">{category.icon}</span>
              <span className="config-nav-label">{category.title}</span>
              <span className="config-nav-badge">{categorySettingCount(category)}</span>
            </button>
          ))}

          <div className="config-nav-footer">
            <div className="config-nav-divider" />
            <label className="config-advanced-toggle">
              <span className="config-toggle">
                <input
                  type="checkbox"
                  checked={isAdvanced}
                  onChange={handleToggleAdvanced}
                />
                <span className="config-toggle-slider" />
              </span>
              <div className="config-advanced-toggle-text">
                <div className="config-advanced-toggle-label">Advanced Configuration</div>
                <div className="config-advanced-toggle-desc">
                  Per-mode models, capability overrides, token counting
                </div>
              </div>
            </label>
          </div>
        </nav>

        {/* Content pane — sections of the active category */}
        <div className="config-content">
          <div className="config-category-heading">
            <span className="config-category-icon">{active.icon}</span>
            <span className="config-category-title">{active.title}</span>
          </div>

          {/* Advanced: Per-mode model configuration (special-cased) */}
          {active.id === 'advanced' && (
            <div className="config-section">
              <h3 className="config-section-title">
                <span className="config-section-icon">🎯</span>
                Per-Mode Model Configuration
              </h3>
              <div className="config-desc" style={{ marginBottom: 12 }}>
                Configure a different model for each mode. Leave empty to use the default model from the LLM Provider section above.
              </div>
              {MODE_ROWS.map(row => (
                <ModeModelConfig
                  key={row.id}
                  mode={row.id}
                  modeLabel={row.label}
                  modeIcon={row.icon}
                  modelValue={modeConfigs[row.id]?.model ?? ''}
                  reasoningEffortValue={modeReasoningEffort[row.id] ?? ''}
                  models={models ?? []}
                  overrides={asCapOverrides(config['llm.capabilityOverrides'])}
                  config={config}
                  onModelChange={model => handleModeModelChange(row.id, model)}
                  onReasoningEffortChange={effort => handleModeReasoningEffortChange(row.id, effort)}
                  onFetch={(provider, apiUrl, apiKey) => {
                    setFetchError(null);
                    onFetchModels?.(provider, apiUrl, apiKey);
                  }}
                />
              ))}
            </div>
          )}

          {active.sections.map(section => (
            <div key={section.title} className="config-section">
              <h3 className="config-section-title">
                <span className="config-section-icon">{section.icon}</span>
                {section.title}
              </h3>
              {section.settings.map(setting => (
                <div key={setting.key} className="config-field">
                  <label className="config-label">{setting.label}</label>
                  <div className="config-desc">{setting.description}</div>
                  {setting.hint && <div className="config-desc" style={{ fontStyle: 'italic', opacity: 0.7, marginTop: -4, marginBottom: 4 }}>{setting.hint}</div>}
                  <SettingField
                    setting={setting}
                    value={config[setting.key]}
                    models={models ?? []}
                    onChange={value => handleChange(setting.key, value)}
                  />
                </div>
              ))}
              {section.showModelFetcher && (
                <ModelFetcher
                  config={config}
                  models={models ?? []}
                  loading={modelsLoading ?? false}
                  error={fetchError}
                  onFetch={(provider, apiUrl, apiKey) => {
                    setFetchError(null);
                    onFetchModels?.(provider, apiUrl, apiKey);
                  }}
                />
              )}
              {section.showModelCapabilities && (
                <ModelCapabilitiesLine
                  model={String(config.llmModel ?? '')}
                  models={models ?? []}
                  overrides={asCapOverrides(config['llm.capabilityOverrides'])}
                />
              )}
              {/* 0.6.5: the model pickers above (per-mode rows, choice-detection
                  model, capability-override rows) are DROPDOWNS fed by the
                  provider's model list — offer fetch/refresh right here in
                  Advanced instead of requiring a detour to Connection. */}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

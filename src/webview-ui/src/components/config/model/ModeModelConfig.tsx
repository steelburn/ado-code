import { ModelInput } from './ModelInput';
import { ModelCapabilitiesLine } from './ModelCapabilitiesLine';
import type { CapOverride } from '../inputs/CapabilityOverridesInput';

/** Per-mode model configuration row in Advanced mode. */
export function ModeModelConfig({
  mode,
  modeLabel,
  modeIcon,
  modelValue,
  reasoningEffortValue,
  models,
  overrides,
  config,
  onModelChange,
  onReasoningEffortChange,
  onFetch,
}: {
  mode: string;
  modeLabel: string;
  modeIcon: string;
  modelValue: string;
  reasoningEffortValue: string;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  overrides?: CapOverride[];
  config: Record<string, any>;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string) => void;
  onFetch: (provider?: string, apiUrl?: string, apiKey?: string) => void;
}) {
  const url = String(config.llmApiUrl ?? '').trim();
  const key = String(config.llmApiKey ?? '').trim();
  return (
    <div className="config-mode-model">
      <div className="config-mode-model-header">
        <span className="config-mode-model-icon">{modeIcon}</span>
        <span className="config-mode-model-label">{modeLabel}</span>
      </div>
      <div className="config-mode-model-fields">
        <div className="config-mode-model-row">
          <label className="config-mcp-label">Model</label>
          <ModelInput
            value={modelValue}
            models={models}
            placeholder="e.g. gpt-4o, o3"
            onChange={onModelChange}
          />
        </div>
        <div className="config-mode-model-row">
          <label className="config-mcp-label">Reasoning Effort</label>
          <select
            className="config-select"
            value={reasoningEffortValue}
            onChange={e => onReasoningEffortChange(e.target.value)}
          >
            <option value="">— none —</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      {modelValue && (
        <div className="config-mode-model-caps">
          <ModelCapabilitiesLine
            model={modelValue}
            models={models}
            overrides={overrides}
          />
        </div>
      )}
    </div>
  );
}

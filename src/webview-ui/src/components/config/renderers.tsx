import type { ComponentType } from 'react';
import type { ConfigSetting } from '../../../../config/catalog';
import { ArrayInput } from './inputs/ArrayInput';
import { McpServersInput } from './inputs/McpServersInput';
import { OrganizationsInput } from './inputs/OrganizationsInput';
import { CapabilityOverridesInput } from './inputs/CapabilityOverridesInput';
import { ModelInput } from './model/ModelInput';
import type { ConfigValue } from '../../../../shared/configSchema';
import {
  CHAT_VERBOSITY_LEVELS,
  chatVerbosityLabel,
  chatVerbosityLevel,
  chatVerbosityPreset,
  chatVerbositySummary,
  readChatVerbosity,
  type ChatVerbosityLevel,
} from '../../../../shared/chatVerbosity';

// Stage 3: data-driven field rendering. The page no longer carries a
// `setting.type === …` dispatch chain — it renders each ConfigSetting through
// SettingField, which looks the field widget up in SETTING_RENDERERS by type.
// Adding a new ConfigSetting type means adding one row here (and the exhaustive
// Record makes TypeScript flag a missing entry).

/** The page's whole value map, keyed by setting key. */
type ConfigValues = Record<string, ConfigValue>;

export interface SettingRendererProps {
  /** Every value on the page — multi-key rows (type 'verbosity') read it. */
  allValues?: ConfigValues;
  /** Multi-key write for rows that own more than one setting. */
  onPatch?: (patch: ConfigValues) => void;
  setting: ConfigSetting;
  value: any;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  onChange: (value: any) => void;
}

function TextRenderer({ setting, value, onChange }: SettingRendererProps) {
  return (
    <input
      className="config-input"
      type={setting.type === 'password' ? 'password' : 'text'}
      value={value ?? ''}
      placeholder={setting.placeholder}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function NumberRenderer({ setting, value, onChange }: SettingRendererProps) {
  return (
    <input
      className="config-input"
      type="number"
      min={setting.min}
      max={setting.max}
      value={value ?? ''}
      onChange={e => onChange(Number(e.target.value))}
    />
  );
}

function BooleanRenderer({ value, onChange }: SettingRendererProps) {
  return (
    <label className="config-toggle">
      <input
        type="checkbox"
        checked={!!value}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="config-toggle-slider" />
    </label>
  );
}

function EnumRenderer({ setting, value, onChange }: SettingRendererProps) {
  return (
    <select
      className="config-select"
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
    >
      {setting.options?.map(opt => (
        <option key={opt} value={opt}>{opt || '(none)'}</option>
      ))}
    </select>
  );
}

function ArrayRenderer({ setting, value, onChange }: SettingRendererProps) {
  return (
    <ArrayInput
      value={Array.isArray(value) ? value : []}
      placeholder={setting.placeholder}
      onChange={onChange}
    />
  );
}

function McpRenderer({ value, onChange }: SettingRendererProps) {
  return (
    <McpServersInput
      value={Array.isArray(value) ? value : []}
      onChange={onChange}
    />
  );
}

function OrganizationsRenderer({ value, onChange }: SettingRendererProps) {
  return (
    <OrganizationsInput
      value={Array.isArray(value) ? value : []}
      onChange={onChange}
    />
  );
}

function CapabilityOverridesRenderer({ value, models, onChange }: SettingRendererProps) {
  return (
    <CapabilityOverridesInput
      value={Array.isArray(value) ? value : []}
      models={models}
      onChange={onChange}
    />
  );
}

function ModelRenderer({ setting, value, models, onChange }: SettingRendererProps) {
  return (
    <ModelInput
      value={value ?? ''}
      models={models}
      placeholder={setting.placeholder}
      onChange={onChange}
    />
  );
}

/** Composite row: ONE dial over three settings (thinking text, tool cards,
 *  density). It reads the whole value map and writes all three keys at once,
 *  so the level stays derived from the persisted settings — never stored
 *  twice, never drifting from them. */
function VerbosityRenderer({ allValues, onPatch }: SettingRendererProps) {
  // Derived, never stored: the level the three persisted settings add up to.
  const state = readChatVerbosity(
    allValues?.['chat.showThinking'],
    allValues?.['chat.showToolCalls'],
    allValues?.['chat.density'],
  );
  const level = chatVerbosityLevel(state);
  return (
    <select
      className="config-select"
      value={level}
      onChange={e => {
        if (e.target.value === 'custom') return;
        const preset = chatVerbosityPreset(e.target.value as ChatVerbosityLevel);
        onPatch?.({
          'chat.showThinking': preset.showThinking,
          'chat.showToolCalls': preset.showToolCalls,
          'chat.density': preset.density,
        });
      }}
    >
      {level === 'custom' && (
        <option value="custom">{`Custom — ${chatVerbositySummary(state)}`}</option>
      )}
      {CHAT_VERBOSITY_LEVELS.map(l => (
        <option key={l} value={l}>{chatVerbosityLabel(l)}</option>
      ))}
    </select>
  );
}

/** One widget per ConfigSetting['type']. Exhaustive by construction: the Record
 *  type makes a missing type a compile error. */
export const SETTING_RENDERERS: Record<ConfigSetting['type'], ComponentType<SettingRendererProps>> = {
  verbosity: VerbosityRenderer,
  string: TextRenderer,
  password: TextRenderer,
  number: NumberRenderer,
  boolean: BooleanRenderer,
  enum: EnumRenderer,
  array: ArrayRenderer,
  mcp: McpRenderer,
  orgs: OrganizationsRenderer,
  capOverrides: CapabilityOverridesRenderer,
  model: ModelRenderer,
};

/** Renders a single setting by dispatching on its type. */
export function SettingField(props: SettingRendererProps) {
  const Renderer = SETTING_RENDERERS[props.setting.type] ?? TextRenderer;
  return <Renderer {...props} />;
}

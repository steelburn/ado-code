import type { ComponentType } from 'react';
import type { ConfigSetting } from '../../../../config/catalog';
import { ArrayInput } from './inputs/ArrayInput';
import { McpServersInput } from './inputs/McpServersInput';
import { OrganizationsInput } from './inputs/OrganizationsInput';
import { CapabilityOverridesInput } from './inputs/CapabilityOverridesInput';
import { ModelInput } from './model/ModelInput';

// Stage 3: data-driven field rendering. The page no longer carries a
// `setting.type === …` dispatch chain — it renders each ConfigSetting through
// SettingField, which looks the field widget up in SETTING_RENDERERS by type.
// Adding a new ConfigSetting type means adding one row here (and the exhaustive
// Record makes TypeScript flag a missing entry).

export interface SettingRendererProps {
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

/** One widget per ConfigSetting['type']. Exhaustive by construction: the Record
 *  type makes a missing type a compile error. */
export const SETTING_RENDERERS: Record<ConfigSetting['type'], ComponentType<SettingRendererProps>> = {
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

import { useState } from 'react';

/**
 * Model input with dropdown for fetched models + custom input option.
 * Shows a select dropdown when models are available, with an extra option
 * to type a custom model not in the list.
 */
export function ModelInput({
  value,
  models,
  placeholder,
  onChange,
}: {
  value: string;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  placeholder?: string;
  onChange: (model: string) => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState('');

  // If models are available and user hasn't opted for custom mode
  if (models.length > 0 && !customMode) {
    // Check if current value is a custom model (not in the list)
    const isCustom = value && !models.some(m => m.id === value);

    return (
      <div className="config-model-input">
        <select
          className="config-select"
          value={isCustom ? '__custom__' : value}
          onChange={e => {
            if (e.target.value === '__custom__') {
              setCustomMode(true);
              setCustomValue(value);
            } else {
              onChange(e.target.value);
            }
          }}
        >
          <option value="">— pick a model —</option>
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
          {isCustom && <option value="__custom__">{value} (custom)</option>}
          <option value="__custom__">✏️ Type custom model…</option>
        </select>
      </div>
    );
  }

  // Custom input mode or no models available
  return (
    <div className="config-model-input">
      <div className="config-model-input-row">
        <input
          className="config-input"
          type="text"
          value={customMode ? customValue : value}
          onChange={e => {
            if (customMode) {
              setCustomValue(e.target.value);
            } else {
              onChange(e.target.value);
            }
          }}
          onBlur={() => {
            if (customMode) {
              onChange(customValue);
            }
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && customMode) {
              onChange(customValue);
            }
          }}
          placeholder={placeholder || 'e.g. gpt-4o, claude-sonnet-4-20250514'}
        />
        {customMode && models.length > 0 && (
          <button
            className="config-model-input-back"
            onClick={() => {
              setCustomMode(false);
              setCustomValue('');
            }}
            title="Back to model list"
            type="button"
          >
            ↩
          </button>
        )}
      </div>
    </div>
  );
}

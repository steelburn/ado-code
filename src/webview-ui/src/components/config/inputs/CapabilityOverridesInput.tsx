import { ModelInput } from '../model/ModelInput';

export interface CapOverride {
  model: string;
  vision?: boolean;
  tools?: boolean;
}

/** Editor for per-model capability overrides — add/remove rows with model id
 *  + vision/tools toggles (unset = keep auto-detected). Mirrors McpServersInput. */
export function CapabilityOverridesInput({ value, models, onChange }: { value: CapOverride[]; models: Array<{ id: string; vision?: boolean; tools?: boolean }>; onChange: (rows: CapOverride[]) => void }) {
  const addRow = () => {
    onChange([...value, { model: '' }]);
  };

  const removeRow = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const updateRow = (idx: number, field: keyof CapOverride, fieldValue: any) => {
    const updated = [...value];
    updated[idx] = { ...updated[idx], [field]: fieldValue };
    onChange(updated);
  };

  return (
    <div className="config-mcp">
      {value.length === 0 && (
        <div className="config-mcp-empty">No capability overrides. Click + to declare vision/tool support for a model the auto-detection gets wrong.</div>
      )}
      {value.map((row, idx) => (
        <div key={idx} className="config-mcp-server">
          <div className="config-mcp-server-header">
            <span className="config-mcp-server-num">#{idx + 1}</span>
            <button
              className="config-mcp-remove"
              onClick={() => removeRow(idx)}
              title="Remove override"
              type="button"
            >×</button>
          </div>
          <div className="config-mcp-fields">
            <div className="config-mcp-row">
              <label className="config-mcp-label">Model id</label>
              <ModelInput
                value={row.model}
                models={models}
                onChange={model => updateRow(idx, 'model', model)}
                placeholder="deepseek-v4"
              />
            </div>
            <div className="config-mcp-row config-cap-toggles">
              <label className="config-mcp-label">
                <input
                  type="checkbox"
                  checked={row.vision === true}
                  onChange={e => updateRow(idx, 'vision', e.target.checked ? true : undefined)}
                />{' '}
                Vision
              </label>
              <label className="config-mcp-label">
                <input
                  type="checkbox"
                  checked={row.tools === true}
                  onChange={e => updateRow(idx, 'tools', e.target.checked ? true : undefined)}
                />{' '}
                Tool calling
              </label>
              <span className="config-cap-hint">(unchecked = keep auto-detected)</span>
            </div>
          </div>
        </div>
      ))}
      <button className="config-mcp-add" onClick={addRow} type="button">
        + Add Override
      </button>
    </div>
  );
}

import React from 'react';
import { PROJECT_TEMPLATES } from './types';

interface Props {
  templateId: string;
  options: Record<string, any>;
  onChange: (optionId: string, value: any) => void;
}

export function StepTemplateOptions({ templateId, options, onChange }: Props) {
  const template = PROJECT_TEMPLATES.find(t => t.id === templateId);
  // `showWhen` is the wizard's conditional-visibility hook (docs/project-scaffolding.md
  // F5): a control that cannot apply to the answers so far is hidden rather than
  // rendered dead. The test-automation group uses it for `reporting`, which only
  // means something once at least one suite is enabled.
  const visibleOptions = (template?.options ?? []).filter(
    option => !option.showWhen || option.showWhen(options)
  );
  if (!template || visibleOptions.length === 0) {
    return (
      <div className="wizard-step">
        <h3 className="wizard-step-title">Template Options</h3>
        <p className="wizard-step-desc">No additional options for this template</p>
      </div>
    );
  }

  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Template Options</h3>
      <p className="wizard-step-desc">Customize your {template.name} project</p>

      {visibleOptions.map(option => (
        <div key={option.id} className="wizard-form-group">
          {option.type === 'boolean' ? (
            <label className="wizard-toggle-label">
              <input
                type="checkbox"
                checked={options[option.id] ?? option.default}
                onChange={e => onChange(option.id, e.target.checked)}
              />
              <span>{option.label}</span>
            </label>
          ) : option.type === 'select' ? (
            <>
              <label className="wizard-label">{option.label}</label>
              <select
                className="wizard-select"
                value={options[option.id] ?? option.default}
                onChange={e => onChange(option.id, e.target.value)}
              >
                {option.options?.map(opt => (
                  <option key={opt} value={opt}>{option.optionLabels?.[opt] ?? opt}</option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label className="wizard-label">{option.label}</label>
              <input
                className="wizard-input"
                value={options[option.id] ?? option.default ?? ''}
                onChange={e => onChange(option.id, e.target.value)}
              />
            </>
          )}
          {option.description && <div className="wizard-hint">{option.description}</div>}
        </div>
      ))}
    </div>
  );
}

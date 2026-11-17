import React from 'react';
import { ProjectTemplate, PROJECT_TEMPLATES } from './types';
import { WIZARD_PRESETS, WizardPreset } from '../../../../shared/wizardPresets';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (templateId: string) => void;
  /**
   * Applies a named preset instead of a bare template. Optional so the step still
   * renders where no preset host is wired.
   */
  onApplyPreset?: (preset: WizardPreset) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Full-Stack',
  cli: 'CLI',
  library: 'Library',
  mobile: 'Mobile',
  monorepo: 'Monorepo & Microservices',
  documentation: 'Documentation',
  testing: 'Testing & QA',
};

export function StepProjectType({ selectedTemplateId, onSelect, onApplyPreset }: Props) {
  const categories = [...new Set(PROJECT_TEMPLATES.map(t => t.category))];

  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Select Project Type</h3>
      <p className="wizard-step-desc">Choose a template for your new project</p>

      {onApplyPreset && (
        <div className="preset-strip">
          <span className="preset-strip-label">Start from the standard</span>
          {WIZARD_PRESETS.map(preset => (
            <button
              key={preset.id}
              className="preset-btn"
              title={preset.description}
              onClick={() => onApplyPreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {categories.map(category => (
        <div key={category} className="wizard-category">
          <h4 className="wizard-category-title">{CATEGORY_LABELS[category] || category}</h4>
          <div className="wizard-templates">
            {PROJECT_TEMPLATES.filter(t => t.category === category).map(template => (
              <button
                key={template.id}
                className={`wizard-template ${selectedTemplateId === template.id ? 'wizard-template-selected' : ''}`}
                onClick={() => onSelect(template.id)}
              >
                <span className="wizard-template-icon">{template.icon}</span>
                <span className="wizard-template-name">{template.name}</span>
                <span className="wizard-template-desc">{template.description}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

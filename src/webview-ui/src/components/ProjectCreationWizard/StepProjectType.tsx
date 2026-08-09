import React from 'react';
import { ProjectTemplate, PROJECT_TEMPLATES } from './types';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (templateId: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Full-Stack',
  cli: 'CLI',
  library: 'Library',
};

export function StepProjectType({ selectedTemplateId, onSelect }: Props) {
  const categories = [...new Set(PROJECT_TEMPLATES.map(t => t.category))];

  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Select Project Type</h3>
      <p className="wizard-step-desc">Choose a template for your new project</p>

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

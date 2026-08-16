import React from 'react';

interface Props {
  projectName: string;
  projectDescription: string;
  projectVersion: string;
  onChange: (field: string, value: string) => void;
}

export function StepProjectDetails({ projectName, projectDescription, projectVersion, onChange }: Props) {
  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Project Details</h3>
      <p className="wizard-step-desc">Configure your project metadata</p>

      <div className="wizard-form-group">
        <label className="wizard-label">Project Name *</label>
        <input
          className="wizard-input"
          value={projectName}
          onChange={e => onChange('projectName', e.target.value)}
          placeholder="my-project"
        />
        <div className="wizard-hint">Lowercase, no spaces (e.g., my-project)</div>
      </div>

      <div className="wizard-form-group">
        <label className="wizard-label">Description</label>
        <input
          className="wizard-input"
          value={projectDescription}
          onChange={e => onChange('projectDescription', e.target.value)}
          placeholder="A brief description of your project"
        />
      </div>

      <div className="wizard-form-group">
        <label className="wizard-label">Version</label>
        <input
          className="wizard-input"
          value={projectVersion}
          onChange={e => onChange('projectVersion', e.target.value)}
          placeholder="0.1.0"
        />
      </div>
    </div>
  );
}

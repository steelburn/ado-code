import React from 'react';

interface Props {
  adoIntegration: boolean;
  adoWorkItemType: string;
  adoAreaPath: string;
  onChange: (field: string, value: boolean | string) => void;
}

const WORK_ITEM_TYPES = ['Task', 'User Story', 'Bug', 'Feature', 'Epic', 'Issue'];

export function StepAdoIntegration({ adoIntegration, adoWorkItemType, adoAreaPath, onChange }: Props) {
  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">ADO Integration</h3>
      <p className="wizard-step-desc">Optionally connect this project to Azure DevOps</p>

      <div className="wizard-form-group">
        <label className="wizard-toggle-label">
          <input
            type="checkbox"
            checked={adoIntegration}
            onChange={e => onChange('adoIntegration', e.target.checked)}
          />
          <span>Enable Azure DevOps integration</span>
        </label>
        <div className="wizard-hint">
          Create work items automatically when the project is initialized
        </div>
      </div>

      {adoIntegration && (
        <>
          <div className="wizard-form-group">
            <label className="wizard-label">Work Item Type</label>
            <select
              className="wizard-select"
              value={adoWorkItemType}
              onChange={e => onChange('adoWorkItemType', e.target.value)}
            >
              {WORK_ITEM_TYPES.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>

          <div className="wizard-form-group">
            <label className="wizard-label">Area Path</label>
            <input
              className="wizard-input"
              value={adoAreaPath}
              onChange={e => onChange('adoAreaPath', e.target.value)}
              placeholder="e.g., MyProject\\Development"
            />
            <div className="wizard-hint">
              The area path in your ADO project for work item placement
            </div>
          </div>
        </>
      )}
    </div>
  );
}

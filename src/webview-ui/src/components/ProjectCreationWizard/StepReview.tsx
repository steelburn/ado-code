import React from 'react';
import { WizardState, PROJECT_TEMPLATES } from './types';

interface Props {
  state: WizardState;
  template: typeof PROJECT_TEMPLATES[number];
  /** Required dependencies the machine is missing (step 3 acknowledgement). */
  missingDependencies?: string[];
  /** Host will run the template's package install after scaffolding. */
  installsDependencies?: boolean;
}

export function StepReview({ state, template, missingDependencies = [], installsDependencies = false }: Props) {
  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Review & Create</h3>
      <p className="wizard-step-desc">Review your project configuration before creation</p>

      <div className="wizard-review-section">
        <h4 className="wizard-review-heading">Project</h4>
        <div className="wizard-review-row">
          <span className="wizard-review-label">Name:</span>
          <span className="wizard-review-value">{state.projectName}</span>
        </div>
        {state.projectDescription && (
          <div className="wizard-review-row">
            <span className="wizard-review-label">Description:</span>
            <span className="wizard-review-value">{state.projectDescription}</span>
          </div>
        )}
        <div className="wizard-review-row">
          <span className="wizard-review-label">Version:</span>
          <span className="wizard-review-value">{state.projectVersion}</span>
        </div>
      </div>

      <div className="wizard-review-section">
        <h4 className="wizard-review-heading">Template</h4>
        <div className="wizard-review-row">
          <span className="wizard-review-label">Type:</span>
          <span className="wizard-review-value">{template.icon} {template.name}</span>
        </div>
        {Object.entries(state.templateOptions).length > 0 && (
          <div className="wizard-review-row">
            <span className="wizard-review-label">Options:</span>
            <span className="wizard-review-value">
              {Object.entries(state.templateOptions)
                .filter(([, v]) => v === true || (typeof v === 'string' && v !== ''))
                .map(([k]) => k)
                .join(', ') || 'None'}
            </span>
          </div>
        )}
      </div>

      <div className="wizard-review-section">
        <h4 className="wizard-review-heading">ADO Integration</h4>
        <div className="wizard-review-row">
          <span className="wizard-review-label">Enabled:</span>
          <span className="wizard-review-value">{state.adoIntegration ? 'Yes' : 'No'}</span>
        </div>
        {state.adoIntegration && (
          <>
            <div className="wizard-review-row">
              <span className="wizard-review-label">Work Item Type:</span>
              <span className="wizard-review-value">{state.adoWorkItemType}</span>
            </div>
            {state.adoAreaPath && (
              <div className="wizard-review-row">
                <span className="wizard-review-label">Area Path:</span>
                <span className="wizard-review-value">{state.adoAreaPath}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="wizard-review-section">
        <h4 className="wizard-review-heading">Git</h4>
        <div className="wizard-review-row">
          <span className="wizard-review-label">Initialize:</span>
          <span className="wizard-review-value">{state.gitInit ? 'Yes' : 'No'}</span>
        </div>
        {state.gitInit && (
          <>
            <div className="wizard-review-row">
              <span className="wizard-review-label">Initial Commit:</span>
              <span className="wizard-review-value">{state.gitInitialCommit ? 'Yes' : 'No'}</span>
            </div>
            <div className="wizard-review-row">
              <span className="wizard-review-label">Branch:</span>
              <span className="wizard-review-value">{state.gitBranchName}</span>
            </div>
          </>
        )}
      </div>

      <div className="wizard-review-section">
        <h4 className="wizard-review-heading">Dependencies</h4>
        <div className="wizard-review-row">
          <span className="wizard-review-label">Missing:</span>
          <span className="wizard-review-value">
            {missingDependencies.length > 0 ? missingDependencies.join(', ') : 'None'}
          </span>
        </div>
        <div className="wizard-review-row">
          <span className="wizard-review-label">Auto-install:</span>
          <span className="wizard-review-value">{installsDependencies ? 'Yes, after creation' : 'No'}</span>
        </div>
        {missingDependencies.length > 0 && (
          <div className="wizard-dep-note wizard-dep-warn">
            {missingDependencies.join(', ')} will still be missing after creation — install
            {missingDependencies.length === 1 ? ' it' : ' them'} to build or run the project. Creation itself
            only writes files, so this is not blocking.
          </div>
        )}
      </div>
    </div>
  );
}

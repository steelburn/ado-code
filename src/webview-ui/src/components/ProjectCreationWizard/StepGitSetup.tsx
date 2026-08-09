import React from 'react';

interface Props {
  init: boolean;
  initialCommit: boolean;
  branchName: string;
  onChange: (updates: { gitInit?: boolean; gitInitialCommit?: boolean; gitBranchName?: string }) => void;
}

export function StepGitSetup({ init, initialCommit, branchName, onChange }: Props) {
  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Git Setup</h3>
      <p className="wizard-step-desc">Configure git initialization options</p>

      <div className="wizard-form-group">
        <label className="wizard-toggle-label">
          <input
            type="checkbox"
            checked={init}
            onChange={e => onChange({ gitInit: e.target.checked })}
          />
          <span>Initialize Git Repository</span>
        </label>
        <div className="wizard-hint">Create a new git repository in the project directory</div>
      </div>

      {init && (
        <>
          <div className="wizard-form-group">
            <label className="wizard-toggle-label">
              <input
                type="checkbox"
                checked={initialCommit}
                onChange={e => onChange({ gitInitialCommit: e.target.checked })}
              />
              <span>Create Initial Commit</span>
            </label>
            <div className="wizard-hint">Make an initial commit with the generated project files</div>
          </div>

          <div className="wizard-form-group">
            <label className="wizard-label">Initial Branch Name</label>
            <input
              className="wizard-input"
              value={branchName}
              onChange={e => onChange({ gitBranchName: e.target.value })}
              placeholder="main"
            />
            <div className="wizard-hint">Name of the initial branch (default: main)</div>
          </div>
        </>
      )}
    </div>
  );
}

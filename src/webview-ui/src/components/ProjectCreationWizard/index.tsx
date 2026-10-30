import React, { useState, useCallback, useEffect } from 'react';
import { vscode } from '../../vscode';
import { PostCreateStep, WizardState, PROJECT_TEMPLATES } from './types';
import { StepProjectType } from './StepProjectType';
import { StepProjectDetails } from './StepProjectDetails';
import { StepTemplateOptions } from './StepTemplateOptions';
import { StepAdoIntegration } from './StepAdoIntegration';
import { StepGitSetup } from './StepGitSetup';
import { StepReview } from './StepReview';
import { StepDependencies } from './StepDependencies';
import type { DependencyReport } from '../../../../shared/projectDependencies';
import { dependencyGate } from '../../../../shared/projectDependencies';
import { StepNextSteps } from './StepNextSteps';
import './styles.css';

interface Props {
  onClose: () => void;
  /** Creation failure surfaced by the host (App-level, so it survives the overlay). */
  error?: string | null;
  onClearError?: () => void;
  /**
   * Set by the host once the project exists AND the scaffolder reported
   * post-create work (Flutter's native runners). The wizard then keeps itself
   * open on a final "Next Steps" step instead of vanishing on a warning toast.
   */
  result?: { path: string; steps: PostCreateStep[] } | null;
  /** Dismisses the wizard after the Next Steps step (App runs the follow-ups). */
  onDone?: () => void;
}

const STEPS = [
  'Project Type',
  'Project Details',
  'Template Options',
  'Dependencies',
  'ADO Integration',
  'Git Setup',
  'Review & Create',
];

/** Default option values for a template (applied when the template is picked, so
 *  defaults hold even if the user skips the Template Options step). */
function defaultsFor(templateId: string): Record<string, any> {
  const template = PROJECT_TEMPLATES.find(t => t.id === templateId);
  const defaults: Record<string, any> = {};
  template?.options.forEach(o => { defaults[o.id] = o.default; });
  return defaults;
}

export function ProjectCreationWizard({ onClose, error, onClearError, result, onDone }: Props) {
  const [state, setState] = useState<WizardState>({
    step: 0,
    templateId: null,
    projectName: '',
    projectDescription: '',
    projectVersion: '0.1.0',
    templateOptions: {},
    adoIntegration: false,
    adoWorkItemType: 'Task',
    adoAreaPath: '',
    gitInit: true,
    gitInitialCommit: true,
    gitBranchName: 'main',
  });

  const [creating, setCreating] = useState(false);

  // Dependency check (step 3): the host probes PATH for the template's
  // toolchain. A missing runtime/SDK is guidance, not a veto — but the user has
  // to tick "I will install it myself" before the wizard moves on.
  const [dependencyReport, setDependencyReport] = useState<DependencyReport | null>(null);
  const [dependenciesAcknowledged, setDependenciesAcknowledged] = useState(false);
  const [installDependencies, setInstallDependencies] = useState(true);

  // A host-reported failure re-enables the Create button (it stays "Creating…"
  // and disabled otherwise, since the wizard never unmounts on failure).
  useEffect(() => {
    if (error) setCreating(false);
  }, [error]);

  const updateState = useCallback((updates: Partial<WizardState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  // The "Next Steps" step only exists when the scaffolder reported work that
  // still has to run (it is appended, so its index is STEPS.length).
  const nextSteps = result?.steps ?? [];
  const onNextSteps = nextSteps.length > 0 && state.step >= STEPS.length;
  const progressSteps = nextSteps.length > 0 ? [...STEPS, 'Next Steps'] : STEPS;

  useEffect(() => {
    if (!result || result.steps.length === 0) return;
    setCreating(false);
    setState(prev => (prev.step === STEPS.length ? prev : { ...prev, step: STEPS.length }));
  }, [result]);

  const canProceed = (): boolean => {
    switch (state.step) {
      case 0: return state.templateId !== null;
      case 1: return state.projectName.trim().length > 0;
      case 2: return true;
      case 3:
        // Nothing missing is the happy path; a missing *required* runtime or SDK
        // needs an explicit acknowledgement instead of blocking the user.
        return !dependencyGate(dependencyReport, dependenciesAcknowledged).blocked;
      case 4: return true;
      case 5: return true;
      case 6: return true;
      default: return false;
    }
  };

  const handleNext = () => {
    if (state.step < STEPS.length - 1) {
      updateState({ step: state.step + 1 });
    }
  };

  const handleBack = () => {
    if (state.step > 0) {
      updateState({ step: state.step - 1 });
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    onClearError?.();

    vscode.postMessage({
      type: 'projectWizardCreate',
      request: {
        templateId: state.templateId!,
        projectName: state.projectName,
        projectDescription: state.projectDescription,
        projectVersion: state.projectVersion,
        templateOptions: state.templateOptions,
        adoIntegration: state.adoIntegration,
        adoWorkItemType: state.adoWorkItemType,
        adoAreaPath: state.adoAreaPath,
        gitInit: state.gitInit,
        gitInitialCommit: state.gitInitialCommit,
        gitBranchName: state.gitBranchName,
        targetPath: '', // Host will resolve (workspace root or folder picker)
        // Autonomous half of the dependency check: the host runs the template's
        // package install (npm/pip/composer/…) once the scaffold exists.
        installDependencies,
      },
    });
  };

  const renderStep = () => {
    if (onNextSteps) {
      return <StepNextSteps steps={nextSteps} projectPath={result?.path ?? ''} />;
    }
    switch (state.step) {
      case 0:
        return (
          <StepProjectType
            selectedTemplateId={state.templateId}
            onSelect={id => updateState({ templateId: id, templateOptions: defaultsFor(id) })}
          />
        );
      case 1:
        return (
          <StepProjectDetails
            projectName={state.projectName}
            projectDescription={state.projectDescription}
            projectVersion={state.projectVersion}
            onChange={(field, value) => updateState({ [field]: value })}
          />
        );
      case 2:
        return state.templateId ? (
          <StepTemplateOptions
            templateId={state.templateId}
            options={state.templateOptions}
            onChange={(optionId, value) => updateState({
              templateOptions: { ...state.templateOptions, [optionId]: value },
            })}
          />
        ) : null;
      case 3:
        return state.templateId ? (
          <StepDependencies
            templateId={state.templateId}
            templateOptions={state.templateOptions}
            gitInit={state.gitInit}
            report={dependencyReport}
            onReport={setDependencyReport}
            installDependencies={installDependencies}
            onInstallDependenciesChange={setInstallDependencies}
            acknowledged={dependenciesAcknowledged}
            onAcknowledge={setDependenciesAcknowledged}
          />
        ) : null;
      case 4:
        return (
          <StepAdoIntegration
            adoIntegration={state.adoIntegration}
            adoWorkItemType={state.adoWorkItemType}
            adoAreaPath={state.adoAreaPath}
            onChange={(field, value) => updateState({ [field]: value })}
          />
        );
      case 5:
        return (
          <StepGitSetup
            init={state.gitInit}
            initialCommit={state.gitInitialCommit}
            branchName={state.gitBranchName}
            onChange={(updates) => updateState(updates)}
          />
        );
      case 6:
        return (
          <StepReview
            state={state}
            template={PROJECT_TEMPLATES.find(t => t.id === state.templateId)!}
            missingDependencies={dependencyReport?.missingRequired ?? []}
            installsDependencies={installDependencies && (dependencyReport?.autoInstall?.length ?? 0) > 0}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="wizard-overlay">
      <div className="wizard-container">
        <div className="wizard-header">
          <h2 className="wizard-title">Create New Project</h2>
          <button className="wizard-close" onClick={onClose}>×</button>
        </div>

        <div className="wizard-progress">
          {progressSteps.map((step, index) => (
            <div
              key={step}
              className={`wizard-progress-step ${index === state.step ? 'wizard-progress-active' : ''} ${index < state.step ? 'wizard-progress-complete' : ''}`}
            >
              <span className="wizard-progress-num">{index + 1}</span>
              <span className="wizard-progress-label">{step}</span>
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {renderStep()}
          {error && <div className="wizard-error">{error}</div>}
        </div>

        <div className="wizard-footer">
          {onNextSteps ? (
            <>
              <button className="wizard-btn wizard-btn-secondary" onClick={onClose}>
                Close
              </button>
              <button className="wizard-btn wizard-btn-primary" onClick={onDone ?? onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button className="wizard-btn wizard-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              {state.step > 0 && (
                <button className="wizard-btn wizard-btn-secondary" onClick={handleBack}>
                  Back
                </button>
              )}
              {state.step < STEPS.length - 1 ? (
                <button
                  className="wizard-btn wizard-btn-primary"
                  onClick={handleNext}
                  disabled={!canProceed()}
                >
                  Next
                </button>
              ) : (
                <button
                  className="wizard-btn wizard-btn-primary"
                  onClick={handleCreate}
                  disabled={creating}
                >
                  {creating ? 'Creating...' : 'Create Project'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

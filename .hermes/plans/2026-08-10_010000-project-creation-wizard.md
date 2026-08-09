# Project Creation Wizard Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a multi-step project creation wizard in the webview that provides a polished UI for creating new projects with various templates, ADO integration, and git initialization.

**Architecture:** The wizard will be a new React component (`ProjectCreationWizard`) in the webview-ui that communicates with the extension host via the existing postMessage protocol. The host will handle actual file system operations and ADO integration. The wizard replaces the current native VS Code dialog-based flow with a rich, step-by-step UI.

**Tech Stack:** React (webview-ui), TypeScript, VS Code postMessage API, existing scaffolding logic in ChatViewProvider

---

## Current State Analysis

### Existing Code
- `src/webview/ChatViewProvider.ts:1675-1815` — Basic scaffolding with native VS Code dialogs
- `src/webview-ui/src/components/WelcomeScreen.tsx` — Existing wizard-style UI pattern
- `src/shared/messages.ts` — Message protocol between webview and host

### Limitations of Current Flow
1. Uses native VS Code `showQuickPick` and `showInputBox` — not integrated into webview
2. No preview of what will be created
3. Limited project types (7 templates)
4. No ADO work item creation option
5. No option to customize generated files (e.g., add README, license)

---

## Proposed Approach

### New Components
1. **ProjectCreationWizard.tsx** — Main wizard component with step navigation
2. **WizardStep components** — Individual step components for each phase
3. **ProjectTemplate types** — Type definitions for project templates

### Wizard Steps
1. **Project Type** — Select template (Node.js, Python, etc.)
2. **Project Details** — Name, description, version
3. **Template Options** — Customize based on type (e.g., add tests, linting)
4. **ADO Integration** — Optional work item creation, area path
5. **Git Setup** — Init repo, initial commit, branch name
6. **Review & Create** — Summary before creation

### Message Protocol Additions
- `openProjectWizard` — Host opens the wizard
- `projectWizardCreate` — Webview sends creation request
- `projectWizardResult` — Host sends creation result

---

## Step-by-Step Plan

### Task 1: Define Project Template Types

**Objective:** Create type definitions for project templates and wizard state

**Files:**
- Create: `src/webview-ui/src/components/ProjectCreationWizard/types.ts`
- Modify: `src/shared/messages.ts` (add message types)

**Step 1: Create types file**

```typescript
// src/webview-ui/src/components/ProjectCreationWizard/types.ts

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'frontend' | 'backend' | 'fullstack' | 'cli' | 'library';
  options: TemplateOption[];
}

export interface TemplateOption {
  id: string;
  label: string;
  type: 'boolean' | 'select' | 'input';
  default: any;
  options?: string[];  // For select type
  description?: string;
}

export interface WizardState {
  step: number;
  templateId: string | null;
  projectName: string;
  projectDescription: string;
  projectVersion: string;
  templateOptions: Record<string, any>;
  adoIntegration: boolean;
  adoWorkItemType: string;
  adoAreaPath: string;
  gitInit: boolean;
  gitInitialCommit: boolean;
  gitBranchName: string;
}

export interface ProjectCreationRequest {
  templateId: string;
  projectName: string;
  projectDescription: string;
  projectVersion: string;
  templateOptions: Record<string, any>;
  adoIntegration: boolean;
  adoWorkItemType: string;
  adoAreaPath: string;
  gitInit: boolean;
  gitInitialCommit: boolean;
  gitBranchName: string;
  targetPath: string;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'node-ts',
    name: 'Node.js (TypeScript)',
    description: 'TypeScript project with optional ESLint, Prettier, and testing setup',
    icon: '📦',
    category: 'backend',
    options: [
      { id: 'eslint', label: 'Add ESLint', type: 'boolean', default: true },
      { id: 'prettier', label: 'Add Prettier', type: 'boolean', default: true },
      { id: 'jest', label: 'Add Jest testing', type: 'boolean', default: true },
      { id: 'docker', label: 'Add Dockerfile', type: 'boolean', default: false },
    ],
  },
  {
    id: 'node-js',
    name: 'Node.js (JavaScript)',
    description: 'JavaScript project with optional ESLint and testing',
    icon: '📦',
    category: 'backend',
    options: [
      { id: 'eslint', label: 'Add ESLint', type: 'boolean', default: true },
      { id: 'jest', label: 'Add Jest testing', type: 'boolean', default: true },
    ],
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Python project with pyproject.toml and optional virtual env setup',
    icon: '🐍',
    category: 'backend',
    options: [
      { id: 'pytest', label: 'Add pytest', type: 'boolean', default: true },
      { id: 'black', label: 'Add Black formatter', type: 'boolean', default: true },
      { id: 'mypy', label: 'Add mypy type checking', type: 'boolean', default: false },
    ],
  },
  {
    id: 'react-ts',
    name: 'React (TypeScript)',
    description: 'React app with TypeScript, Vite, and optional Tailwind CSS',
    icon: '⚛️',
    category: 'frontend',
    options: [
      { id: 'tailwind', label: 'Add Tailwind CSS', type: 'boolean', default: false },
      { id: 'eslint', label: 'Add ESLint', type: 'boolean', default: true },
      { id: 'prettier', label: 'Add Prettier', type: 'boolean', default: true },
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    description: 'Full-stack React framework with SSR/SSG',
    icon: '▲',
    category: 'fullstack',
    options: [
      { id: 'tailwind', label: 'Add Tailwind CSS', type: 'boolean', default: true },
      { id: 'prisma', label: 'Add Prisma ORM', type: 'boolean', default: false },
      { id: 'auth', label: 'Add NextAuth.js', type: 'boolean', default: false },
    ],
  },
  {
    id: 'php-laravel',
    name: 'PHP (Laravel)',
    description: 'Laravel 11 project with basic structure',
    icon: '🐘',
    category: 'backend',
    options: [
      { id: 'sail', label: 'Add Laravel Sail (Docker)', type: 'boolean', default: true },
      { id: 'pest', label: 'Use Pest for testing', type: 'boolean', default: true },
    ],
  },
  {
    id: 'dotnet-webapi',
    name: '.NET (C# Web API)',
    description: 'ASP.NET Core Web API project',
    icon: '🔷',
    category: 'backend',
    options: [
      { id: 'swagger', label: 'Add Swagger/OpenAPI', type: 'boolean', default: true },
      { id: 'docker', label: 'Add Dockerfile', type: 'boolean', default: false },
    ],
  },
  {
    id: 'dotnet-console',
    name: '.NET (C# Console)',
    description: '.NET console application',
    icon: '🔷',
    category: 'cli',
    options: [],
  },
  {
    id: 'empty',
    name: 'Empty Project',
    description: 'Start with just a README and .gitignore',
    icon: '📄',
    category: 'library',
    options: [
      { id: 'readme', label: 'Add README.md', type: 'boolean', default: true },
      { id: 'gitignore', label: 'Add .gitignore', type: 'boolean', default: true },
      { id: 'license', label: 'Add LICENSE', type: 'select', default: 'MIT', options: ['MIT', 'Apache-2.0', 'GPL-3.0', 'None'] },
    ],
  },
];
```

**Step 2: Add message types to shared/messages.ts**

Add to `WebviewToExtensionMessage`:
```typescript
| { type: 'openProjectWizard' }
| { type: 'projectWizardCreate'; request: ProjectCreationRequest }
```

Add to `ExtensionToWebviewMessage`:
```typescript
| { type: 'projectWizardCreated'; success: boolean; path: string; error?: string }
```

**Step 3: Verify types compile**

Run: `npm run compile`
Expected: PASS

---

### Task 2: Create Wizard Step Components

**Objective:** Build individual step components for the wizard

**Files:**
- Create: `src/webview-ui/src/components/ProjectCreationWizard/StepProjectType.tsx`
- Create: `src/webview-ui/src/components/ProjectCreationWizard/StepProjectDetails.tsx`
- Create: `src/webview-ui/src/components/ProjectCreationWizard/StepTemplateOptions.tsx`
- Create: `src/webview-ui/src/components/ProjectCreationWizard/StepAdoIntegration.tsx`
- Create: `src/webview-ui/src/components/ProjectCreationWizard/StepGitSetup.tsx`
- Create: `src/webview-ui/src/components/ProjectCreationWizard/StepReview.tsx`

**Step 1: Create StepProjectType.tsx**

```tsx
import React from 'react';
import { ProjectTemplate, PROJECT_TEMPLATES } from './types';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (templateId: string) => void;
}

export function StepProjectType({ selectedTemplateId, onSelect }: Props) {
  const categories = [...new Set(PROJECT_TEMPLATES.map(t => t.category))];
  
  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Select Project Type</h3>
      <p className="wizard-step-desc">Choose a template for your new project</p>
      
      {categories.map(category => (
        <div key={category} className="wizard-category">
          <h4 className="wizard-category-title">{category}</h4>
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
```

**Step 2: Create StepProjectDetails.tsx**

```tsx
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
```

**Step 3: Create StepTemplateOptions.tsx**

```tsx
import React from 'react';
import { ProjectTemplate, PROJECT_TEMPLATES } from './types';

interface Props {
  templateId: string;
  options: Record<string, any>;
  onChange: (optionId: string, value: any) => void;
}

export function StepTemplateOptions({ templateId, options, onChange }: Props) {
  const template = PROJECT_TEMPLATES.find(t => t.id === templateId);
  if (!template || template.options.length === 0) {
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
      
      {template.options.map(option => (
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
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label className="wizard-label">{option.label}</label>
              <input
                className="wizard-input"
                value={options[option.id] ?? option.default}
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
```

**Step 4: Create remaining step components**

Create similar components for:
- `StepAdoIntegration.tsx` — ADO work item creation options
- `StepGitSetup.tsx` — Git initialization options
- `StepReview.tsx` — Summary before creation

**Step 5: Verify components compile**

Run: `npm run compile`
Expected: PASS

---

### Task 3: Create Main Wizard Component

**Objective:** Build the main wizard container with step navigation

**Files:**
- Create: `src/webview-ui/src/components/ProjectCreationWizard/index.tsx`
- Create: `src/webview-ui/src/components/ProjectCreationWizard/styles.css`

**Step 1: Create main wizard component**

```tsx
import React, { useState, useCallback } from 'react';
import { vscode } from '../../vscode';
import { WizardState, PROJECT_TEMPLATES } from './types';
import { StepProjectType } from './StepProjectType';
import { StepProjectDetails } from './StepProjectDetails';
import { StepTemplateOptions } from './StepTemplateOptions';
import { StepAdoIntegration } from './StepAdoIntegration';
import { StepGitSetup } from './StepGitSetup';
import { StepReview } from './StepReview';
import './styles.css';

interface Props {
  onClose: () => void;
}

const STEPS = [
  'Project Type',
  'Project Details',
  'Template Options',
  'ADO Integration',
  'Git Setup',
  'Review & Create',
];

export function ProjectCreationWizard({ onClose }: Props) {
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
  const [error, setError] = useState<string | null>(null);
  
  const updateState = useCallback((updates: Partial<WizardState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);
  
  const canProceed = (): boolean => {
    switch (state.step) {
      case 0: return state.templateId !== null;
      case 1: return state.projectName.trim().length > 0;
      case 2: return true;
      case 3: return true;
      case 4: return true;
      case 5: return true;
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
    setError(null);
    
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
        targetPath: '', // Host will resolve
      },
    });
  };
  
  const renderStep = () => {
    switch (state.step) {
      case 0:
        return (
          <StepProjectType
            selectedTemplateId={state.templateId}
            onSelect={id => updateState({ templateId: id })}
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
        return (
          <StepAdoIntegration
            enabled={state.adoIntegration}
            workItemType={state.adoWorkItemType}
            areaPath={state.adoAreaPath}
            onChange={(updates) => updateState(updates)}
          />
        );
      case 4:
        return (
          <StepGitSetup
            init={state.gitInit}
            initialCommit={state.gitInitialCommit}
            branchName={state.gitBranchName}
            onChange={(updates) => updateState(updates)}
          />
        );
      case 5:
        return (
          <StepReview
            state={state}
            template={PROJECT_TEMPLATES.find(t => t.id === state.templateId)!}
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
          {STEPS.map((step, index) => (
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
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Create wizard styles**

Create comprehensive CSS for the wizard UI.

**Step 3: Verify compilation**

Run: `npm run compile && npm run build:webview`
Expected: PASS

---

### Task 4: Add Host Message Handler

**Objective:** Handle wizard messages in the extension host

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` (add message handler)
- Create: `src/webview/ProjectCreationService.ts` (extraction of scaffolding logic)

**Step 1: Create ProjectCreationService.ts**

Extract and enhance the existing scaffolding logic from ChatViewProvider into a dedicated service.

```typescript
// src/webview/ProjectCreationService.ts
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class ProjectCreationService {
  constructor(private context: vscode.ExtensionContext) {}
  
  async createProject(request: ProjectCreationRequest): Promise<{ success: boolean; path: string; error?: string }> {
    try {
      // 1. Create project directory
      // 2. Scaffold files based on template
      // 3. Initialize git if requested
      // 4. Create ADO work item if requested
      // 5. Return result
    } catch (err) {
      return {
        success: false,
        path: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
```

**Step 2: Add message handler in ChatViewProvider**

```typescript
case 'projectWizardCreate':
  await this.handleProjectWizardCreate(msg.request);
  break;
```

**Step 3: Verify compilation**

Run: `npm run compile`
Expected: PASS

---

### Task 5: Add Wizard CSS Styles

**Objective:** Create comprehensive styles for the wizard UI

**Files:**
- Create: `src/webview-ui/src/components/ProjectCreationWizard/styles.css`

**Step 1: Create wizard styles**

```css
/* Wizard overlay */
.wizard-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.wizard-container {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 8px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.wizard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--vscode-widget-border);
}

.wizard-title {
  margin: 0;
  font-size: 1.2em;
  color: var(--vscode-foreground);
}

.wizard-close {
  background: none;
  border: none;
  color: var(--vscode-foreground);
  font-size: 1.5em;
  cursor: pointer;
}

/* Progress bar */
.wizard-progress {
  display: flex;
  padding: 16px 20px;
  gap: 8px;
  border-bottom: 1px solid var(--vscode-widget-border);
}

.wizard-progress-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.wizard-progress-active {
  color: var(--vscode-focusBorder);
  font-weight: 600;
}

.wizard-progress-complete {
  color: var(--vscode-terminal-ansiGreen);
}

.wizard-progress-num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--vscode-widget-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8em;
}

.wizard-progress-active .wizard-progress-num {
  background: var(--vscode-focusBorder);
  color: var(--vscode-editor-background);
}

/* Body */
.wizard-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

/* Footer */
.wizard-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--vscode-widget-border);
}

/* Buttons */
.wizard-btn {
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 0.9em;
  cursor: pointer;
  border: none;
}

.wizard-btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.wizard-btn-primary:hover {
  background: var(--vscode-button-hoverBackground);
}

.wizard-btn-secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.wizard-btn-secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* Form elements */
.wizard-form-group {
  margin-bottom: 16px;
}

.wizard-label {
  display: block;
  font-size: 0.85em;
  font-weight: 500;
  margin-bottom: 4px;
  color: var(--vscode-foreground);
}

.wizard-input,
.wizard-select {
  width: 100%;
  padding: 8px 12px;
  font-family: var(--vscode-font-family);
  font-size: 0.9em;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
}

.wizard-hint {
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
}

.wizard-toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

/* Template cards */
.wizard-category {
  margin-bottom: 20px;
}

.wizard-category-title {
  font-size: 0.9em;
  font-weight: 600;
  text-transform: capitalize;
  margin-bottom: 8px;
  color: var(--vscode-foreground);
}

.wizard-templates {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.wizard-template {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px;
  background: var(--vscode-sideBar-background);
  border: 2px solid var(--vscode-widget-border);
  border-radius: 6px;
  cursor: pointer;
  text-align: center;
}

.wizard-template:hover {
  border-color: var(--vscode-focusBorder);
}

.wizard-template-selected {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-focusBorder);
  background: rgba(var(--vscode-focusBorder-rgb, 0, 122, 204), 0.1);
}

.wizard-template-icon {
  font-size: 1.5em;
  margin-bottom: 4px;
}

.wizard-template-name {
  font-weight: 500;
  font-size: 0.85em;
  color: var(--vscode-foreground);
}

.wizard-template-desc {
  font-size: 0.75em;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
}

/* Error */
.wizard-error {
  padding: 8px 12px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  color: var(--vscode-inputValidation-errorForeground);
  font-size: 0.85em;
}
```

**Step 2: Verify build**

Run: `npm run build:webview`
Expected: PASS

---

### Task 6: Wire Up Wizard in App

**Objective:** Integrate the wizard into the main App component

**Files:**
- Modify: `src/webview-ui/src/App.tsx`
- Modify: `src/webview-ui/src/components/ChatPanel.tsx` (or wherever the "New Project" trigger is)

**Step 1: Add wizard state and import in App.tsx**

```tsx
import { ProjectCreationWizard } from './components/ProjectCreationWizard';

// In App component:
const [showProjectWizard, setShowProjectWizard] = useState(false);
```

**Step 2: Add message handler for wizard result**

```tsx
case 'projectWizardCreated':
  if (msg.success) {
    vscode.window.showInformationMessage(`Project created at ${msg.path}`);
    setShowProjectWizard(false);
  } else {
    setError(msg.error || 'Failed to create project');
  }
  break;
```

**Step 3: Add wizard trigger**

Add a button or command to open the wizard (e.g., in the welcome screen or as a slash command).

**Step 4: Render wizard**

```tsx
{showProjectWizard && (
  <ProjectCreationWizard onClose={() => setShowProjectWizard(false)} />
)}
```

**Step 5: Verify build**

Run: `npm run build:webview`
Expected: PASS

---

### Task 7: Add Slash Command

**Objective:** Add `/new-project` slash command to open the wizard

**Files:**
- Modify: `src/shared/slashCommands.ts`
- Modify: `src/webview-ui/src/components/InputBar.tsx`
- Modify: `src/webview/ChatViewProvider.ts`

**Step 1: Add command to slashCommands.ts**

```typescript
{ name: 'new-project', description: 'Open the project creation wizard', usage: '/new-project', requiresArgs: false },
```

**Step 2: Add to InputBar.tsx SLASH_COMMANDS**

Mirror the same command.

**Step 3: Handle in ChatViewProvider.ts**

```typescript
case 'new-project':
  this.postMessage({ type: 'openProjectWizard' });
  break;
```

**Step 4: Verify compilation**

Run: `npm run compile`
Expected: PASS

---

### Task 8: Test and Polish

**Objective:** Test the complete flow and fix any issues

**Files:**
- Various (based on test results)

**Step 1: Run full build**

Run: `npm run build:all`
Expected: PASS

**Step 2: Run tests**

Run: `npm test`
Expected: PASS (or identify and fix failures)

**Step 3: Manual testing checklist**

- [ ] Wizard opens via slash command
- [ ] All 6 steps navigate correctly
- [ ] Project creation works for each template
- [ ] Git initialization works
- [ ] ADO integration creates work item
- [ ] Error handling works

---

## Feature 2: Skill Management/Catalog & AI Skill Support

### Overview

Add a skill management system that allows users to browse, install, and manage reusable AI skills (prompts, tool chains, workflows). The AI can discover and use these skills during conversations to enhance its capabilities.

### What Are Skills?

Skills are reusable, shareable AI capabilities that extend the assistant's functionality:
- **Prompt Templates**: Pre-built prompts for common tasks (code review, documentation, testing)
- **Tool Chains**: Sequenced tool usage patterns (refactor workflow, deployment pipeline)
- **Domain Knowledge**: Specialized knowledge bases (Azure DevOps best practices, React patterns)
- **Custom Workflows**: Multi-step processes (PR review, release preparation)

### New Components
1. **SkillCatalog.tsx** — Main catalog UI with browse/search/filter
2. **SkillDetail.tsx** — Skill detail view with install/manage options
3. **SkillManager.ts** — Host-side skill management service
4. **SkillExecutor.ts** — Runtime skill execution in chat

---

### Task 9: Define Skill Data Model

**Objective:** Create type definitions for the skill system

**Files:**
- Create: `src/shared/skillTypes.ts`
- Modify: `src/shared/messages.ts` (add skill message types)

**Step 1: Create skill types**

```typescript
// src/shared/skillTypes.ts

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: SkillCategory;
  tags: string[];
  icon: string;
  
  // Skill content
  prompt?: string;           // Prompt template
  toolChain?: ToolChainStep[];  // Tool execution sequence
  knowledge?: string;        // Knowledge base content
  
  // Metadata
  installed: boolean;
  enabled: boolean;
  builtin: boolean;          // Ships with extension
  source: 'builtin' | 'marketplace' | 'local';
  
  // Configuration
  config?: SkillConfig[];
}

export type SkillCategory = 
  | 'code-review'
  | 'documentation'
  | 'testing'
  | 'refactoring'
  | 'deployment'
  | 'database'
  | 'security'
  | 'performance'
  | 'accessibility'
  | 'custom';

export interface ToolChainStep {
  tool: string;
  args: Record<string, any>;
  condition?: string;  // Optional condition for execution
}

export interface SkillConfig {
  id: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  default: any;
  options?: string[];
  description?: string;
}

export interface SkillExecutionRequest {
  skillId: string;
  input: string;
  context?: Record<string, any>;
  config?: Record<string, any>;
}

export interface SkillExecutionResult {
  success: boolean;
  output: string;
  toolCalls?: Array<{ tool: string; args: any; result: any }>;
  error?: string;
}

// Built-in skills that ship with the extension
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Perform a thorough code review with focus on quality, security, and best practices',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'code-review',
    tags: ['review', 'quality', 'security'],
    icon: '🔍',
    prompt: `Review the provided code changes with focus on:
1. **Code Quality**: Readability, maintainability, DRY principles
2. **Security**: Potential vulnerabilities, input validation, secrets exposure
3. **Performance**: Unnecessary operations, optimization opportunities
4. **Best Practices**: Language-specific patterns, error handling
5. **Tests**: Coverage gaps, edge cases

Provide specific, actionable feedback with line references where applicable.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'documentation-gen',
    name: 'Documentation Generator',
    description: 'Generate comprehensive documentation for code files or APIs',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'documentation',
    tags: ['docs', 'comments', 'readme'],
    icon: '📝',
    prompt: `Generate documentation for the provided code:
1. **Overview**: What the code does and its purpose
2. **API Reference**: Functions, classes, parameters, return values
3. **Usage Examples**: Common use cases with code samples
4. **Edge Cases**: Error conditions and handling
5. **Dependencies**: Required imports and external dependencies

Use clear, concise language. Include JSDoc/TSDoc comments where appropriate.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'test-generator',
    name: 'Test Generator',
    description: 'Generate unit tests with good coverage and edge cases',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'testing',
    tags: ['tests', 'unit', 'coverage'],
    icon: '🧪',
    prompt: `Generate comprehensive unit tests for the provided code:
1. **Happy Path**: Test normal, expected behavior
2. **Edge Cases**: Empty inputs, null values, boundaries
3. **Error Cases**: Invalid inputs, exception handling
4. **Integration Points**: Mock external dependencies
5. **Assertions**: Meaningful assertions with clear messages

Use the project's existing test framework. Follow naming conventions.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'refactor-assist',
    name: 'Refactoring Assistant',
    description: 'Identify refactoring opportunities and apply safe transformations',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'refactoring',
    tags: ['refactor', 'clean', 'patterns'],
    icon: '♻️',
    prompt: `Analyze the code and suggest refactoring improvements:
1. **Code Smells**: Long methods, duplicated code, large classes
2. **Design Patterns**: Applicable patterns to simplify structure
3. **SOLID Principles**: Violations and fixes
4. **Extract Methods**: Break down complex functions
5. **Rename/Reorganize**: Improve naming and file structure

Provide before/after examples. Ensure refactoring preserves behavior.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Scan code for security vulnerabilities and compliance issues',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'security',
    tags: ['security', 'audit', 'vulnerabilities'],
    icon: '🔒',
    prompt: `Perform a security audit of the provided code:
1. **Injection Vulnerabilities**: SQL, XSS, command injection
2. **Authentication**: Password handling, token management
3. **Authorization**: Access control, privilege escalation
4. **Data Exposure**: Secrets, PII, sensitive data logging
5. **Dependencies**: Known vulnerabilities in packages

Rate severity (Critical/High/Medium/Low) and provide remediation steps.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'performance-profiler',
    name: 'Performance Profiler',
    description: 'Identify performance bottlenecks and optimization opportunities',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'performance',
    tags: ['performance', 'optimization', 'profiling'],
    icon: '⚡',
    prompt: `Analyze the code for performance issues:
1. **Time Complexity**: Algorithm efficiency (Big O)
2. **Space Complexity**: Memory usage and allocations
3. **I/O Operations**: Database queries, file access, network calls
4. **Caching Opportunities**: Memoization, result caching
5. **Concurrency**: Parallelization possibilities

Provide specific optimization suggestions with expected impact.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
];
```

**Step 2: Add message types to shared/messages.ts**

Add to `WebviewToExtensionMessage`:
```typescript
| { type: 'getSkillCatalog' }
| { type: 'installSkill'; skillId: string }
| { type: 'uninstallSkill'; skillId: string }
| { type: 'enableSkill'; skillId: string }
| { type: 'disableSkill'; skillId: string }
| { type: 'executeSkill'; request: SkillExecutionRequest }
| { type: 'getSkillDetail'; skillId: string }
```

Add to `ExtensionToWebviewMessage`:
```typescript
| { type: 'skillCatalog'; skills: Skill[] }
| { type: 'skillInstalled'; skillId: string; success: boolean }
| { type: 'skillUninstalled'; skillId: string; success: boolean }
| { type: 'skillEnabled'; skillId: string; enabled: boolean }
| { type: 'skillDetail'; skill: Skill }
| { type: 'skillExecutionResult'; result: SkillExecutionResult }
```

**Step 3: Verify types compile**

Run: `npm run compile`
Expected: PASS

---

### Task 10: Create Skill Catalog UI

**Objective:** Build the skill catalog interface for browsing and managing skills

**Files:**
- Create: `src/webview-ui/src/components/SkillCatalog/index.tsx`
- Create: `src/webview-ui/src/components/SkillCatalog/SkillCard.tsx`
- Create: `src/webview-ui/src/components/SkillCatalog/SkillDetail.tsx`
- Create: `src/webview-ui/src/components/SkillCatalog/styles.css`

**Step 1: Create SkillCard component**

```tsx
// src/webview-ui/src/components/SkillCatalog/SkillCard.tsx

import React from 'react';
import { Skill } from '../../../shared/skillTypes';

interface Props {
  skill: Skill;
  onSelect: (skillId: string) => void;
  onInstall: (skillId: string) => void;
  onToggle: (skillId: string, enabled: boolean) => void;
}

export function SkillCard({ skill, onSelect, onInstall, onToggle }: Props) {
  return (
    <div className="skill-card" onClick={() => onSelect(skill.id)}>
      <div className="skill-card-header">
        <span className="skill-card-icon">{skill.icon}</span>
        <div className="skill-card-info">
          <h4 className="skill-card-name">{skill.name}</h4>
          <span className="skill-card-author">by {skill.author}</span>
        </div>
        <div className="skill-card-actions">
          {skill.installed ? (
            <label className="skill-toggle" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={skill.enabled}
                onChange={e => onToggle(skill.id, e.target.checked)}
              />
              <span className="skill-toggle-slider" />
            </label>
          ) : (
            <button
              className="skill-install-btn"
              onClick={e => { e.stopPropagation(); onInstall(skill.id); }}
            >
              Install
            </button>
          )}
        </div>
      </div>
      <p className="skill-card-desc">{skill.description}</p>
      <div className="skill-card-meta">
        <span className="skill-card-category">{skill.category}</span>
        <div className="skill-card-tags">
          {skill.tags.slice(0, 3).map(tag => (
            <span key={tag} className="skill-tag">{tag}</span>
          ))}
        </div>
        <span className="skill-card-version">v{skill.version}</span>
      </div>
    </div>
  );
}
```

**Step 2: Create SkillDetail component**

```tsx
// src/webview-ui/src/components/SkillCatalog/SkillDetail.tsx

import React from 'react';
import { Skill } from '../../../shared/skillTypes';

interface Props {
  skill: Skill;
  onBack: () => void;
  onInstall: (skillId: string) => void;
  onUninstall: (skillId: string) => void;
  onToggle: (skillId: string, enabled: boolean) => void;
  onExecute: (skillId: string) => void;
}

export function SkillDetail({ skill, onBack, onInstall, onUninstall, onToggle, onExecute }: Props) {
  return (
    <div className="skill-detail">
      <button className="skill-back" onClick={onBack}>← Back to Catalog</button>
      
      <div className="skill-detail-header">
        <span className="skill-detail-icon">{skill.icon}</span>
        <div className="skill-detail-info">
          <h2 className="skill-detail-name">{skill.name}</h2>
          <div className="skill-detail-meta">
            <span>by {skill.author}</span>
            <span>v{skill.version}</span>
            <span className={`skill-source skill-source-${skill.source}`}>{skill.source}</span>
          </div>
        </div>
      </div>
      
      <p className="skill-detail-desc">{skill.description}</p>
      
      <div className="skill-detail-tags">
        {skill.tags.map(tag => (
          <span key={tag} className="skill-tag">{tag}</span>
        ))}
      </div>
      
      <div className="skill-detail-actions">
        {skill.installed ? (
          <>
            <button
              className="skill-btn skill-btn-primary"
              onClick={() => onExecute(skill.id)}
              disabled={!skill.enabled}
            >
              Execute in Chat
            </button>
            <button
              className="skill-btn skill-btn-secondary"
              onClick={() => onToggle(skill.id, !skill.enabled)}
            >
              {skill.enabled ? 'Disable' : 'Enable'}
            </button>
            {!skill.builtin && (
              <button
                className="skill-btn skill-btn-danger"
                onClick={() => onUninstall(skill.id)}
              >
                Uninstall
              </button>
            )}
          </>
        ) : (
          <button
            className="skill-btn skill-btn-primary"
            onClick={() => onInstall(skill.id)}
          >
            Install Skill
          </button>
        )}
      </div>
      
      {skill.prompt && (
        <div className="skill-detail-section">
          <h3>Prompt Template</h3>
          <pre className="skill-prompt-preview">{skill.prompt}</pre>
        </div>
      )}
      
      {skill.config && skill.config.length > 0 && (
        <div className="skill-detail-section">
          <h3>Configuration</h3>
          <div className="skill-config-list">
            {skill.config.map(cfg => (
              <div key={cfg.id} className="skill-config-item">
                <label>{cfg.label}</label>
                <span className="skill-config-desc">{cfg.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Create main SkillCatalog component**

```tsx
// src/webview-ui/src/components/SkillCatalog/index.tsx

import React, { useState, useEffect, useCallback } from 'react';
import { vscode } from '../../vscode';
import { Skill, SkillCategory } from '../../../shared/skillTypes';
import { SkillCard } from './SkillCard';
import { SkillDetail } from './SkillDetail';
import './styles.css';

interface Props {
  onClose: () => void;
}

const CATEGORIES: { value: SkillCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All Skills' },
  { value: 'code-review', label: 'Code Review' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'testing', label: 'Testing' },
  { value: 'refactoring', label: 'Refactoring' },
  { value: 'security', label: 'Security' },
  { value: 'performance', label: 'Performance' },
  { value: 'custom', label: 'Custom' },
];

export function SkillCatalog({ onClose }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<SkillCategory | 'all'>('all');
  const [installedFilter, setInstalledFilter] = useState<boolean | null>(null);
  
  // Fetch skills on mount
  useEffect(() => {
    vscode.postMessage({ type: 'getSkillCatalog' });
    
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'skillCatalog') {
        setSkills(msg.skills);
        setLoading(false);
      } else if (msg.type === 'skillInstalled' || msg.type === 'skillUninstalled') {
        // Refresh catalog
        vscode.postMessage({ type: 'getSkillCatalog' });
      }
    };
    
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);
  
  const filteredSkills = skills.filter(skill => {
    const matchesSearch = skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         skill.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         skill.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = categoryFilter === 'all' || skill.category === categoryFilter;
    const matchesInstalled = installedFilter === null || skill.installed === installedFilter;
    return matchesSearch && matchesCategory && matchesInstalled;
  });
  
  const selectedSkill = selectedSkillId ? skills.find(s => s.id === selectedSkillId) : null;
  
  const handleInstall = useCallback((skillId: string) => {
    vscode.postMessage({ type: 'installSkill', skillId });
  }, []);
  
  const handleUninstall = useCallback((skillId: string) => {
    vscode.postMessage({ type: 'uninstallSkill', skillId });
  }, []);
  
  const handleToggle = useCallback((skillId: string, enabled: boolean) => {
    vscode.postMessage({ type: enabled ? 'enableSkill' : 'disableSkill', skillId });
  }, []);
  
  const handleExecute = useCallback((skillId: string) => {
    // This would trigger skill execution in the chat
    vscode.postMessage({ type: 'executeSkill', request: { skillId, input: '' } });
    onClose();
  }, [onClose]);
  
  if (selectedSkill) {
    return (
      <SkillDetail
        skill={selectedSkill}
        onBack={() => setSelectedSkillId(null)}
        onInstall={handleInstall}
        onUninstall={handleUninstall}
        onToggle={handleToggle}
        onExecute={handleExecute}
      />
    );
  }
  
  return (
    <div className="skill-catalog">
      <div className="skill-catalog-header">
        <h2>Skill Catalog</h2>
        <button className="skill-catalog-close" onClick={onClose}>×</button>
      </div>
      
      <div className="skill-catalog-filters">
        <input
          className="skill-search"
          type="text"
          placeholder="Search skills..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        
        <select
          className="skill-category-filter"
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value as any)}
        >
          {CATEGORIES.map(cat => (
            <option key={cat.value} value={cat.value}>{cat.label}</option>
          ))}
        </select>
        
        <select
          className="skill-installed-filter"
          value={installedFilter === null ? 'all' : installedFilter ? 'installed' : 'available'}
          onChange={e => {
            const val = e.target.value;
            setInstalledFilter(val === 'all' ? null : val === 'installed');
          }}
        >
          <option value="all">All</option>
          <option value="installed">Installed</option>
          <option value="available">Available</option>
        </select>
      </div>
      
      <div className="skill-catalog-stats">
        <span>{filteredSkills.length} skills</span>
        <span>{skills.filter(s => s.installed).length} installed</span>
      </div>
      
      {loading ? (
        <div className="skill-catalog-loading">Loading skills...</div>
      ) : filteredSkills.length === 0 ? (
        <div className="skill-catalog-empty">No skills found</div>
      ) : (
        <div className="skill-catalog-grid">
          {filteredSkills.map(skill => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onSelect={setSelectedSkillId}
              onInstall={handleInstall}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 4: Create skill catalog styles**

Create comprehensive CSS for the skill catalog UI.

**Step 5: Verify build**

Run: `npm run build:webview`
Expected: PASS

---

### Task 11: Create Skill Management Service

**Objective:** Build host-side skill management and persistence

**Files:**
- Create: `src/services/SkillManager.ts`
- Modify: `src/webview/ChatViewProvider.ts` (add skill message handlers)

**Step 1: Create SkillManager service**

```typescript
// src/services/SkillManager.ts

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Skill, BUILTIN_SKILLS, SkillExecutionRequest, SkillExecutionResult } from '../shared/skillTypes';

export class SkillManager {
  private skills: Map<string, Skill> = new Map();
  private skillsDir: string;
  
  constructor(private context: vscode.ExtensionContext) {
    this.skillsDir = path.join(context.globalStorageUri.fsPath, 'skills');
    this.ensureSkillsDir();
    this.loadSkills();
  }
  
  private ensureSkillsDir() {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
  }
  
  private loadSkills() {
    // Load built-in skills
    for (const skill of BUILTIN_SKILLS) {
      this.skills.set(skill.id, skill);
    }
    
    // Load user-installed skills
    const skillsFile = path.join(this.skillsDir, 'skills.json');
    if (fs.existsSync(skillsFile)) {
      try {
        const userSkills: Skill[] = JSON.parse(fs.readFileSync(skillsFile, 'utf-8'));
        for (const skill of userSkills) {
          this.skills.set(skill.id, skill);
        }
      } catch (err) {
        console.error('Failed to load user skills:', err);
      }
    }
  }
  
  private saveUserSkills() {
    const userSkills = Array.from(this.skills.values()).filter(s => !s.builtin);
    const skillsFile = path.join(this.skillsDir, 'skills.json');
    fs.writeFileSync(skillsFile, JSON.stringify(userSkills, null, 2));
  }
  
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }
  
  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }
  
  installSkill(skill: Skill): boolean {
    if (this.skills.has(skill.id)) {
      return false;
    }
    this.skills.set(skill.id, { ...skill, installed: true, enabled: true });
    this.saveUserSkills();
    return true;
  }
  
  uninstallSkill(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill || skill.builtin) {
      return false;
    }
    this.skills.delete(id);
    this.saveUserSkills();
    return true;
  }
  
  enableSkill(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;
    skill.enabled = true;
    if (!skill.builtin) this.saveUserSkills();
    return true;
  }
  
  disableSkill(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;
    skill.enabled = false;
    if (!skill.builtin) this.saveUserSkills();
    return true;
  }
  
  getEnabledSkills(): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.enabled);
  }
  
  async executeSkill(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    const skill = this.skills.get(request.skillId);
    if (!skill) {
      return { success: false, output: '', error: 'Skill not found' };
    }
    
    if (!skill.enabled) {
      return { success: false, output: '', error: 'Skill is disabled' };
    }
    
    // Build the execution prompt
    let prompt = skill.prompt || '';
    
    // Inject user input
    prompt = prompt.replace('{{input}}', request.input);
    
    // Inject context
    if (request.context) {
      for (const [key, value] of Object.entries(request.context)) {
        prompt = prompt.replace(`{{${key}}}`, String(value));
      }
    }
    
    // Execute tool chain if present
    const toolCalls: Array<{ tool: string; args: any; result: any }> = [];
    if (skill.toolChain) {
      for (const step of skill.toolChain) {
        // Tool execution would be handled by the LLM client
        toolCalls.push({ tool: step.tool, args: step.args, result: null });
      }
    }
    
    return {
      success: true,
      output: prompt,
      toolCalls,
    };
  }
}
```

**Step 2: Add skill message handlers in ChatViewProvider**

```typescript
// In ChatViewProvider message handler

case 'getSkillCatalog':
  this.postMessage({
    type: 'skillCatalog',
    skills: this.services.skills.getAllSkills(),
  });
  break;

case 'installSkill':
  const installResult = this.services.skills.installSkill(msg.skill);
  this.postMessage({
    type: 'skillInstalled',
    skillId: msg.skillId,
    success: installResult,
  });
  break;

case 'uninstallSkill':
  const uninstallResult = this.services.skills.uninstallSkill(msg.skillId);
  this.postMessage({
    type: 'skillUninstalled',
    skillId: msg.skillId,
    success: uninstallResult,
  });
  break;

case 'enableSkill':
  this.services.skills.enableSkill(msg.skillId);
  this.postMessage({
    type: 'skillEnabled',
    skillId: msg.skillId,
    enabled: true,
  });
  break;

case 'disableSkill':
  this.services.skills.disableSkill(msg.skillId);
  this.postMessage({
    type: 'skillEnabled',
    skillId: msg.skillId,
    enabled: false,
  });
  break;

case 'executeSkill':
  const execResult = await this.services.skills.executeSkill(msg.request);
  this.postMessage({
    type: 'skillExecutionResult',
    result: execResult,
  });
  break;

case 'getSkillDetail':
  const skill = this.services.skills.getSkill(msg.skillId);
  this.postMessage({
    type: 'skillDetail',
    skill: skill || null,
  });
  break;
```

**Step 3: Register SkillManager in services**

Add to `src/services.ts`:
```typescript
import { SkillManager } from './services/SkillManager';

// In createServices():
const skills = new SkillManager(context);
```

**Step 4: Verify compilation**

Run: `npm run compile`
Expected: PASS

---

### Task 12: Add AI Skill Integration

**Objective:** Enable the AI to discover and use skills during conversations

**Files:**
- Modify: `src/llm/prompts/system.ts` (add skill context)
- Modify: `src/llm/client.ts` (add skill execution)

**Step 1: Add skill context to system prompt**

```typescript
// In src/llm/prompts/system.ts

export function buildSystemPrompt(
  mode: string,
  skills: Skill[],
  // ... other params
): string {
  let prompt = `You are an AI coding assistant with access to specialized skills.`;
  
  // Add available skills
  const enabledSkills = skills.filter(s => s.enabled);
  if (enabledSkills.length > 0) {
    prompt += `\n\n## Available Skills\n\n`;
    prompt += `You have access to the following skills. Use them when relevant to the user's request:\n\n`;
    
    for (const skill of enabledSkills) {
      prompt += `### ${skill.icon} ${skill.name}\n`;
      prompt += `${skill.description}\n`;
      prompt += `Category: ${skill.category} | Tags: ${skill.tags.join(', ')}\n\n`;
    }
    
    prompt += `To use a skill, invoke the \`execute_skill\` tool with the skill ID and relevant input.\n`;
  }
  
  // ... rest of prompt
}
```

**Step 2: Add execute_skill tool definition**

```typescript
// In src/llm/tools/definitions/execute_skill.ts

import { ToolDefinition } from './types';

export const executeSkillTool: ToolDefinition = {
  name: 'execute_skill',
  description: 'Execute a specialized skill to perform a task. Skills are reusable capabilities for code review, documentation, testing, refactoring, security auditing, and more.',
  parameters: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The ID of the skill to execute (e.g., "code-review", "test-generator")',
      },
      input: {
        type: 'string',
        description: 'The input/context for the skill (e.g., code to review, file path)',
      },
    },
    required: ['skillId', 'input'],
  },
};
```

**Step 3: Add skill execution handler**

```typescript
// In src/llm/tools/ExecuteSkillTool.ts

import { BaseTool } from './BaseTool';
import { SkillManager } from '../../services/SkillManager';

export class ExecuteSkillTool extends BaseTool {
  name = 'execute_skill';
  
  constructor(private skillManager: SkillManager) {
    super();
  }
  
  async execute(args: { skillId: string; input: string }): Promise<string> {
    const result = await this.skillManager.executeSkill({
      skillId: args.skillId,
      input: args.input,
    });
    
    if (!result.success) {
      return JSON.stringify({ error: result.error });
    }
    
    return JSON.stringify({
      success: true,
      output: result.output,
      toolCalls: result.toolCalls,
    });
  }
}
```

**Step 4: Register the tool**

Add to `src/llm/tools/ToolRegistry.ts`:
```typescript
import { ExecuteSkillTool } from './ExecuteSkillTool';

// In registerTools():
const executeSkillTool = new ExecuteSkillTool(services.skills);
registry.register(executeSkillTool);
```

**Step 5: Verify compilation**

Run: `npm run compile`
Expected: PASS

---

### Task 13: Add Skill Catalog Entry Point

**Objective:** Add UI entry points to access the skill catalog

**Files:**
- Modify: `src/webview-ui/src/App.tsx` (add catalog state)
- Modify: `src/webview-ui/src/components/ChatPanel.tsx` (add catalog button)
- Modify: `src/shared/slashCommands.ts` (add /skills command)
- Modify: `src/webview/ChatViewProvider.ts` (handle /skills)

**Step 1: Add /skills slash command**

```typescript
// In src/shared/slashCommands.ts

{ name: 'skills', description: 'Open the skill catalog to browse and manage AI skills', usage: '/skills', requiresArgs: false },
```

**Step 2: Add catalog button to chat panel**

Add a button in the chat header or toolbar to open the skill catalog.

**Step 3: Wire up catalog in App.tsx**

```tsx
// In App.tsx

const [showSkillCatalog, setShowSkillCatalog] = useState(false);

// Message handler
case 'openSkillCatalog':
  setShowSkillCatalog(true);
  break;

// Render
{showSkillCatalog && (
  <SkillCatalog onClose={() => setShowSkillCatalog(false)} />
)}
```

**Step 4: Handle /skills command**

```typescript
// In ChatViewProvider.ts

case 'skills':
  this.postMessage({ type: 'openSkillCatalog' });
  this.postMessage({ type: 'loading', loading: false });
  break;
```

**Step 5: Verify build**

Run: `npm run build:all`
Expected: PASS

---

### Task 14: Test Skill System

**Objective:** Test the complete skill management and execution flow

**Files:**
- Various (based on test results)

**Step 1: Run full build**

Run: `npm run build:all`
Expected: PASS

**Step 2: Run tests**

Run: `npm test`
Expected: PASS

**Step 3: Manual testing checklist**

- [ ] `/skills` opens skill catalog
- [ ] Skills display correctly with icons, descriptions, tags
- [ ] Search and filter work
- [ ] Install/uninstall flow works
- [ ] Enable/disable toggle works
- [ ] Skill detail view shows correct info
- [ ] Execute in chat triggers skill
- [ ] AI can use execute_skill tool
- [ ] Skill prompt injection works correctly

---

## Files Likely to Change

### New Files (Feature 1: Project Wizard)
1. `src/webview-ui/src/components/ProjectCreationWizard/types.ts`
2. `src/webview-ui/src/components/ProjectCreationWizard/index.tsx`
3. `src/webview-ui/src/components/ProjectCreationWizard/styles.css`
4. `src/webview-ui/src/components/ProjectCreationWizard/Step*.tsx` (6 files)
5. `src/webview/ProjectCreationService.ts`

### New Files (Feature 2: Skill System)
1. `src/shared/skillTypes.ts`
2. `src/webview-ui/src/components/SkillCatalog/index.tsx`
3. `src/webview-ui/src/components/SkillCatalog/SkillCard.tsx`
4. `src/webview-ui/src/components/SkillCatalog/SkillDetail.tsx`
5. `src/webview-ui/src/components/SkillCatalog/styles.css`
6. `src/services/SkillManager.ts`
7. `src/llm/tools/ExecuteSkillTool.ts`
8. `src/llm/tools/definitions/execute_skill.ts`

### Modified Files (Both Features)
1. `src/shared/messages.ts` — Add message types for both features
2. `src/webview/ChatViewProvider.ts` — Add handlers for both features
3. `src/webview-ui/src/App.tsx` — Wire up both UIs
4. `src/shared/slashCommands.ts` — Add /new-project and /skills commands
5. `src/webview-ui/src/components/InputBar.tsx` — Add both commands
6. `src/services.ts` — Register SkillManager
7. `src/llm/prompts/system.ts` — Add skill context
8. `src/llm/tools/ToolRegistry.ts` — Register execute_skill tool

---

## Tests / Validation

### Unit Tests
- Test wizard state transitions
- Test skill filtering and search
- Test skill installation/uninstallation
- Test skill execution

### Integration Tests
- Test message flow for both features
- Test project creation for each template
- Test skill execution in chat
- Test AI tool usage

### Manual Testing
- Visual testing of both UIs
- End-to-end flow testing
- Cross-platform testing

---

## Risks, Tradeoffs, and Open Questions

### Risks
1. **Complexity** — 9 new components may be overkill for initial implementation
2. **Maintenance** — More templates = more maintenance burden
3. **Performance** — Wizard styles may increase bundle size

### Tradeoffs
1. **Native vs Webview UI** — Native dialogs are simpler but less polished
2. **Template count** — Start with 4-5 templates, expand later
3. **ADO integration** — Can be deferred to a follow-up release

### Open Questions
1. Should the wizard support creating projects in existing folders?
2. Should templates be extensible via user-defined templates?
3. Should the wizard remember user preferences?

---

## Execution Handoff

Plan complete and saved. Ready to execute using subagent-driven-development — I'll dispatch a fresh subagent per task with two-stage review (spec compliance then code quality). Shall I proceed?

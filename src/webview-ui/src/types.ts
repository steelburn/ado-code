// Messages from Webview → Extension Host
// Task 24: webview copy of AgentRun/AgentCapability (host imports from
// src/agents/types; the webview project can't resolve that path).
export type AgentName = 'claude' | 'codex' | 'opencode' | 'hermes' | 'pi' | 'openclaw' | 'aider' | 'gemini' | 'cursor-agent';

export interface AgentCapability {
  name: AgentName;
  displayName: string;
  installed: boolean;
  version?: string;
  modes: ('one-shot' | 'session')[];
}

export interface AgentRun {
  id: string;
  workItemId?: number;
  agent: AgentName;
  sessionId?: string;
  workdir: string;
  branch?: string;
  worktreePath?: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  outputFile?: string;
  summary?: string;
}

import { ProjectCreationRequest } from './components/ProjectCreationWizard/types';

/** An image pasted into the chat, carried as a base64 data URL. */
export interface ImageAttachment {
  id: string;
  /** data:image/png;base64,<encoded> or data:image/jpeg;base64,<encoded> */
  dataUrl: string;
  /** Original filename or auto-generated name */
  name: string;
}

export type WebviewToExtensionMessage =
  | { type: 'userMessage'; content: string; context?: MessageContext; images?: ImageAttachment[] }
  // Choice-card answers: the user picked an option on an AI-posed question.
  // Routed to the same turn path as userMessage (host must handle BOTH).
  | { type: 'sendMessage'; content: string }
  | { type: 'fetchWorkItems' }
  | { type: 'selectWorkItem'; workItemId: number }
  | { type: 'startTask'; workItemId: number; title: string }
  | { type: 'updateWorkItem'; workItemId: number; fields: Record<string, any> }
  | { type: 'addComment'; workItemId: number; text: string }
  | { type: 'getConfig' }
  | { type: 'getFullConfig' }
  | { type: 'saveConfig'; config: Record<string, any> }
  | { type: 'updateConfig'; config: Partial<ExtensionConfig> }
  // Task 24: agent delegation protocol
  | { type: 'delegateToAgent'; workItemId: number; prompt: string; agent?: string }
  | { type: 'agentFollowUp'; runId: string; prompt: string }
  | { type: 'agentCancel'; runId: string }
  | { type: 'dismissAgentRun'; runId: string }
  | { type: 'reopenAgentOutput'; runId: string }
  | { type: 'listAgents' }
  | { type: 'listAgentRuns' }
  | { type: 'clearConversation' }
  // Task 28: task detail review + clarification
  | { type: 'reviewTaskDetail'; workItemId: number }
  | { type: 'requestClarification'; workItemId: number; question: string; mentionCreator: boolean }
  | { type: 'checkTaskReplies'; workItemId: number }
  | { type: 'pickMode' }
  | { type: 'rerunWizard' }
  | { type: 'openSettings' }
  | { type: 'cycleMode' }
  | { type: 'selectMode'; mode: 'inline' | 'plan' | 'act' | 'yolo' }
  | { type: 'fetchProjects'; organization?: string; pat?: string }
  | { type: 'fetchModels'; provider?: string; apiUrl?: string; apiKey?: string }
  | { type: 'selectProject'; projectName: string }
  // Input-bar tools: inject active-editor context / attach a file into the draft
  | { type: 'getEditorContext' }
  | { type: 'pickFiles' }
  // File search for @ mentions
  | { type: 'searchFiles'; query: string }
  // Consent: user answer to an agent consent request (inline mode mutating tool)
  | { type: 'consentResponse'; requestId: string; approved: boolean; scope?: 'once' | 'session' | 'permanent' }
  // Stop generation: user clicks stop while LLM is streaming
  | { type: 'stopGeneration' }
  // Session history
  | { type: 'listSessions' }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'renameSession'; sessionId: string; name: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'clearAllSessions' }
  // Project creation wizard
  | { type: 'projectWizardCreate'; request: ProjectCreationRequest };

// Messages from Extension Host → Webview
export type ExtensionToWebviewMessage =
  | { type: 'assistantMessage'; content: string; done: boolean }
  // AI thinking/reasoning text (o1/o3 reasoning_content, Claude extended thinking)
  | { type: 'thinkingMessage'; content: string; done: boolean }
  | { type: 'workItems'; items: WorkItemSummary[] }
  | { type: 'workItemDetail'; item: WorkItemDetail }
  | { type: 'gitStatus'; isGitRepo: boolean; currentBranch: string | null; branchCreated: string | null }
  | { type: 'changelogUpdated'; filePath: string }
  | { type: 'modeChanged'; mode: 'inline' | 'plan' | 'act' | 'yolo' }
  // H9: tool-call cards for the webview (agentic loop streaming)
  | { type: 'toolCall'; call: { id: string; name: string; arguments: Record<string, any>; showDetails?: boolean } }
  | { type: 'toolResult'; callId: string; content: string }
  // Bare completion tick for hidden tool calls (chat.showToolCalls=false): no
  // payload — just flips the disclosure row from "running" to "completed".
  | { type: 'toolCallDone'; callId: string }
  | { type: 'planReady'; plan: string } // plan mode: "Begin implementation" button
  | { type: 'config'; config: ExtensionConfig }
  | { type: 'fullConfig'; config: Record<string, any> }
  | { type: 'error'; message: string }
  | { type: 'loading'; loading: boolean }
  // Task 24: agent delegation protocol
  | { type: 'agentStatus'; run: AgentRun; delta: string }
  | { type: 'agentResult'; run: AgentRun; summary: string }
  | { type: 'agentList'; agents: AgentCapability[] }
  | { type: 'agentRunsList'; runs: AgentRun[] }
  // AI choice prompt: detected question + options from AI response
  | { type: 'choicePrompt'; requestId: string; question: string; options: Array<{ label: string; value: string }> }
  // Task 26: history restore (Q4)
  | { type: 'historyRestored'; messages: { role: string; content: string }[] }
  // Task 28: task detail review + clarification
  | { type: 'taskReplies'; workItemId: number; comments: WorkItemComment[] }
  // Project selection
  | { type: 'projectList'; projects: Array<{ id: string; name: string; state: string }> }
  // Wizard model picker — model ids plus OPTIONAL live capability hints from
  // gateways that expose them (OpenRouter/Ollama). Undefined = use heuristic.
  | { type: 'modelList'; models: Array<{ id: string; vision?: boolean; tools?: boolean }> }
  // Input-bar tools: active-editor context block / attached file contents
  | { type: 'editorContext'; text: string }
  | { type: 'attachedFiles'; files: Array<{ name: string; content: string }> }
  // Consent: the agent requires user approval for a mutating tool (inline mode)
  | { type: 'consentRequest'; requestId: string; tool: string; args: Record<string, any>; autoApproveMs?: number }
  // Generic confirmation: in-chat card replacing native VS Code dialogs
  | { type: 'confirmationRequest'; requestId: string; title: string; description: string; options: Array<{ label: string; value: string; isDangerous?: boolean }> }
  // File search results for @ mentions
  | { type: 'fileSearchResults'; results: Array<{ path: string; name: string }> }
  // Session history
  | { type: 'sessionList'; sessions: Session[]; activeId: string | null }
  | { type: 'sessionSwitched'; session: Session }
  // Project creation wizard
  | { type: 'openProjectWizard' }
  | { type: 'projectWizardCreated'; success: boolean; path: string; error?: string }
  // Skill catalog
  | { type: 'openSkillCatalog' }
  // Skill import
  | { type: 'importSkillFromDisk' }
  // Right-click context menu: insert text into chat draft
  | { type: 'insertText'; text: string };

// Shared types
export interface MessageContext {
  activeFile?: string;
  selectedText?: string;
  workItemId?: number;
}

export interface WorkItemSummary {
  id: number;
  title: string;
  state: string;
  assignedTo: string;
  workItemType: string;
  parentId?: number;
  // True when the item is NOT part of the base query (assigned/unassigned)
  // but was pulled in by hierarchy expansion (parent/child of a base item).
  isContext?: boolean;
}

export interface WorkItemDetail extends WorkItemSummary {
  description: string;
  acceptanceCriteria: string;
  tags: string;
  areaPath: string;
  iterationPath: string;
  creator?: string; // Task 28: displayName of the work item creator
  comments: WorkItemComment[];
  reproSteps?: string;
  systemInfo?: string;
}

export interface WorkItemComment {
  id: number;
  text: string;
  createdBy: string;
  createdDate: string;
}

// Shared work-item context used by the chat system prompt (Task 13),
// agent handoff prompt (Task 25), and task completion hook (Task 11).
// Defined here (Task 4) so earlier tasks can reference it without forward deps.
export interface WorkItemContext {
  id: number;
  title: string;
  state?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string;
  comments?: Array<{ author: string; text: string; date?: string }>;
}

export interface ExtensionConfig {
  // M-10 fix: mirror the FULL Task 5 settings surface (no drift).
  organizations: Array<{ name: string; url: string; project: string }>;
  adoOrganization: string;
  adoProject: string;
  adoServerUrl: string;
  adoPat: string;
  llmProvider: string;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  mode: 'inline' | 'plan' | 'act' | 'yolo';
  agentsEnabled: string[];
  actToolBudget: number;
  actTerminalAllowlist: string[];
  gitRequireGitRepo: boolean;
  gitCreateBranchOnTaskStart: boolean;
  gitRequireCleanTree: boolean;
  gitPrOnCompletion: boolean;
  changelogEnabled: boolean;
  changelogAutoCommit: boolean;
  changelogPostToAdo: boolean;
  adoClarificationState: string;
  adoWarnOnSparseTask: boolean;
}

// Session history
export interface Session {
  id: string;
  name: string;
  createdAt: string;
  messages: Array<{ role: string; content: string }>;
}

// ── Skill System Types ──────────────────────────────────────────────
// Duplicated from src/shared/skillTypes.ts because the webview-ui project
// cannot resolve cross-project imports (separate tsconfig + webpack).

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: SkillCategory;
  tags: string[];
  icon: string;
  prompt?: string;
  toolChain?: ToolChainStep[];
  knowledge?: string;
  installed: boolean;
  enabled: boolean;
  builtin: boolean;
  source: 'builtin' | 'marketplace' | 'local';
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
  condition?: string;
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

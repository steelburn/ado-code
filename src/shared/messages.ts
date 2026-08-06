// Messages from Webview → Extension Host
import { AgentRun, AgentCapability } from '../agents/types';

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
  | { type: 'fetchWorkItems' }
  | { type: 'selectWorkItem'; workItemId: number }
  | { type: 'startTask'; workItemId: number; title: string }
  | { type: 'updateWorkItem'; workItemId: number; fields: Record<string, any> }
  | { type: 'addComment'; workItemId: number; text: string }
  | { type: 'getConfig' }
  | { type: 'updateConfig'; config: Partial<ExtensionConfig> }
  // Task 24: agent delegation protocol
  | { type: 'delegateToAgent'; workItemId: number; prompt: string; agent?: string }
  | { type: 'agentFollowUp'; runId: string; prompt: string }
  | { type: 'agentCancel'; runId: string }
  | { type: 'listAgents' }
  | { type: 'clearConversation' }
  | { type: 'stopGeneration' }
  // Task 28: task detail review + clarification
  | { type: 'reviewTaskDetail'; workItemId: number }
  | { type: 'requestClarification'; workItemId: number; question: string; mentionCreator: boolean }
  | { type: 'checkTaskReplies'; workItemId: number }
  | { type: 'pickMode' }
  | { type: 'rerunWizard' }
  | { type: 'openSettings' }
  | { type: 'cycleMode' }
  | { type: 'selectMode'; mode: 'inline' | 'plan' | 'act' }
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
  // Generic confirmation: user answer to an in-chat confirmation card
  | { type: 'confirmationResponse'; requestId: string; value: string }
  // Session history
  | { type: 'listSessions' }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'renameSession'; sessionId: string; name: string }
  | { type: 'deleteSession'; sessionId: string }
  // Configuration page
  | { type: 'getFullConfig' }
  | { type: 'saveConfig'; config: Record<string, any> }
  // Agent runs: request list of active/recent runs for multi-run display
  | { type: 'listAgentRuns' };

// Messages from Extension Host → Webview
export type ExtensionToWebviewMessage =
  | { type: 'assistantMessage'; content: string; done: boolean }
  | { type: 'workItems'; items: WorkItemSummary[] }
  | { type: 'workItemDetail'; item: WorkItemDetail }
  | { type: 'gitStatus'; isGitRepo: boolean; currentBranch: string | null; branchCreated: string | null }
  | { type: 'changelogUpdated'; filePath: string }
  | { type: 'modeChanged'; mode: 'inline' | 'plan' | 'act' }
  // H9: tool-call cards for the webview (agentic loop streaming)
  | { type: 'toolCall'; call: { id: string; name: string; arguments: Record<string, any> } }
  | { type: 'toolResult'; callId: string; content: string }
  | { type: 'planReady'; plan: string } // plan mode: "Begin implementation" button
  | { type: 'config'; config: ExtensionConfig }
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
  // Wizard model picker
  | { type: 'modelList'; models: string[] }
  // Input-bar tools: active-editor context block / attached file contents
  | { type: 'editorContext'; text: string }
  | { type: 'attachedFiles'; files: Array<{ name: string; content: string }> }
  // Consent: the agent requires user approval for a mutating tool (inline mode)
  | { type: 'consentRequest'; requestId: string; tool: string; args: Record<string, any> }
  // Generic confirmation: ask the user to pick an option (replaces showQuickPick / showWarningMessage)
  | { type: 'confirmationRequest'; requestId: string; title: string; description: string; options: Array<{ label: string; value: string; isDangerous?: boolean }> }
  // File search results for @ mentions
  | { type: 'fileSearchResults'; results: Array<{ path: string; name: string }> }
  // Session history
  | { type: 'sessionList'; sessions: Session[]; activeId: string | null }
  | { type: 'sessionSwitched'; session: Session }
  // Configuration page: full settings snapshot
  | { type: 'fullConfig'; config: Record<string, any> };

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
}

export interface WorkItemDetail extends WorkItemSummary {
  description: string;
  acceptanceCriteria: string;
  tags: string;
  areaPath: string;
  iterationPath: string;
  creator?: string; // Task 28: displayName of the work item creator
  comments: WorkItemComment[];
  // Bug-specific fields
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
  mode: 'inline' | 'plan' | 'act';
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

// ── Session History ─────────────────────────────────────────────────
export interface Session {
  /** ISO timestamp used as unique ID */
  id: string;
  /** Display name (auto-generated from first user message, or user-set) */
  name: string;
  /** ISO date string */
  createdAt: string;
  messages: Array<{ role: string; content: string }>;
}

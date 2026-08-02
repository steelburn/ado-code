// Messages from Webview → Extension Host
export type WebviewToExtensionMessage =
  | { type: 'userMessage'; content: string; context?: MessageContext }
  | { type: 'fetchWorkItems' }
  | { type: 'selectWorkItem'; workItemId: number }
  | { type: 'startTask'; workItemId: number; title: string }
  | { type: 'updateWorkItem'; workItemId: number; fields: Record<string, any> }
  | { type: 'addComment'; workItemId: number; text: string }
  | { type: 'getConfig' }
  | { type: 'updateConfig'; config: Partial<ExtensionConfig> };

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
  | { type: 'loading'; loading: boolean };

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
}

export interface WorkItemDetail extends WorkItemSummary {
  description: string;
  acceptanceCriteria: string;
  tags: string;
  areaPath: string;
  iterationPath: string;
  comments: WorkItemComment[];
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

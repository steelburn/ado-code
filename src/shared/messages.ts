// Messages from Webview → Extension Host
import { AgentRun, AgentCapability } from '../agents/types';
import { ProjectCreationRequest } from '../webview-ui/src/components/ProjectCreationWizard/types';
import { Skill, SkillExecutionRequest, SkillExecutionResult } from './skillTypes';

/** A tool call surfaced by the agentic loop — live (running → completed) or
 *  recorded in a finished turn's trace. */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, any>;
  result?: string;
  /** false when the user hid tool calls in chat — rendered as a "…" indicator. */
  showDetails?: boolean;
  /** Completion flag for hidden calls, which never carry result content. */
  done?: boolean;
}

/** One segment of a turn's ordered record. `thinking` blocks sit between the
 *  tool calls they introduced — not lumped above them. */
export type TraceEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; call: ToolCallInfo };

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
  | { type: 'updateConfig'; config: Partial<ExtensionConfig> }
  // Task 24: agent delegation protocol
  | { type: 'delegateToAgent'; workItemId: number; prompt: string; agent?: string }
  | { type: 'agentFollowUp'; runId: string; prompt: string }
  | { type: 'agentCancel'; runId: string }
  | { type: 'dismissAgentRun'; runId: string }
  | { type: 'reopenAgentOutput'; runId: string }
  // Open the LIVE progress panel for a run in the editor area (running OR
  // finished — finished runs show the summary inside the same panel).
  | { type: 'openAgentProgress'; runId: string }
  | { type: 'listAgents' }
  | { type: 'clearConversation' }
  | { type: 'stopGeneration' }
  // A finished turn's Thinking/Tools record, handed back by the webview so the
  // host can persist it (the host never sees the reasoning blocks itself — it
  // only emits flat tool/progress events). `content` is the turn's final answer
  // text, which keys the record to the message it belongs to. Sent once per
  // completed turn; the host caps and stores it with that assistant message.
  | { type: 'recordTurnTrace'; content: string; entries: TraceEntry[] }
  // Task 28: task detail review + clarification
  | { type: 'reviewTaskDetail'; workItemId: number }
  | { type: 'requestClarification'; workItemId: number; question: string; mentionCreator: boolean }
  | { type: 'checkTaskReplies'; workItemId: number }
  | { type: 'pickMode' }
  | { type: 'rerunWizard' }
  | { type: 'openSettings' }
  | { type: 'moveChatToEditor' }
  | { type: 'moveChatToSidebar' }
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
  // Generic confirmation: user answer to an in-chat confirmation card
  | { type: 'confirmationResponse'; requestId: string; value: string }
  // Session history
  | { type: 'listSessions' }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'renameSession'; sessionId: string; name: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'clearAllSessions' }
  // Configuration page
  | { type: 'getFullConfig' }
  | { type: 'saveConfig'; config: Record<string, any> }
  // Agent runs: request list of active/recent runs for multi-run display
  | { type: 'listAgentRuns' }
  // Project creation wizard
  | { type: 'openProjectWizard' }
  | { type: 'projectWizardCreate'; request: ProjectCreationRequest }
  // Wizard focus: a full-page wizard (Configuration page / project creation)
  // opened or closed in the chat webview — the host collapses the sibling
  // sidebar views so the wizard gets the whole view container.
  | { type: 'maximizeWizard'; active: boolean }
  // Task 9: skill system
  | { type: 'getSkillCatalog' }
  | { type: 'installSkill'; skillId: string; skill: Skill }
  | { type: 'uninstallSkill'; skillId: string }
  | { type: 'enableSkill'; skillId: string }
  | { type: 'disableSkill'; skillId: string }
  | { type: 'executeSkill'; request: SkillExecutionRequest }
  | { type: 'getSkillDetail'; skillId: string }
  // Skill import from local .json file
  | { type: 'importSkillFromDisk' }
  // Skill registry (remote TSV registries)
  | { type: 'getRegistrySkills' }
  | { type: 'installRegistrySkill'; entry: { slug: string; url: string; description: string } }
  // Mermaid SVG export
  | { type: 'saveSvg'; content: string; defaultName?: string };

// Messages from Extension Host → Webview
export type ExtensionToWebviewMessage =
  // Optional `id` stamps an assistant bubble with a stable identity so a later
  // done:true message with the SAME id REPLACES that bubble's content instead
  // of appending a new one. Used for the live delegation card: the host rewrites
  // one in-thread bubble as the agent run progresses (running → terminal), so
  // the chat never looks finished while background work is still going.
  // `replace` (only meaningful with `id`) forces replacement semantics;
  // without it, id'd messages APPEND to the bubble (self-contained streams
  // such as auto-review that must not fuse with the active turn).
  // `isThinking` marks streamed text that is an agentic iteration's PRE-TOOL
  // reasoning (also surfaced as a thinking block). The webview must not buffer
  // it into the answer: doing so merges reasoning into the reply and duplicates
  // it when the terminal answer arrives.
  | { type: 'assistantMessage'; content: string; done: boolean; id?: string; replace?: boolean; isThinking?: boolean }
  // AI thinking/reasoning text (o1/o3 reasoning_content, Claude extended
  // thinking). `newBlock` marks the start of a DISTINCT reasoning step — the
  // agentic loop posts one complete pre-tool message per iteration — so the
  // webview separates it from earlier reasoning with a blank line. Streamed
  // deltas omit it: fragments of one continuous reasoning stream glue raw.
  | { type: 'thinkingMessage'; content: string; done: boolean; newBlock?: boolean }
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
  | { type: 'error'; message: string }
  | { type: 'loading'; loading: boolean }
  // Task 24: agent delegation protocol
  | { type: 'agentStatus'; run: AgentRun; delta: string }
  | { type: 'agentResult'; run: AgentRun; summary: string }
  | { type: 'agentList'; agents: AgentCapability[] }
  | { type: 'agentRunsList'; runs: AgentRun[] }
  // AI choice prompt: detected question + options from AI response
  | { type: 'choicePrompt'; requestId: string; question: string; options: Array<{ label: string; value: string }> }
  // Task 26: history restore (Q4). `trace` carries the turn's persisted
  // Thinking/Tools record so a reopened session renders like the turn the user
  // watched (reasoning collapsed, tool cards intact).
  | { type: 'historyRestored'; messages: { role: string; content: string; trace?: StoredTurnTrace }[] }
  // Task 28: task detail review + clarification
  | { type: 'taskReplies'; workItemId: number; comments: WorkItemComment[] }
  // Project selection
  | { type: 'projectList'; projects: Array<{ id: string; name: string; state: string }> }
  // Open the in-webview Configuration page (host-side trigger, e.g. from the
  // chat kebab "Configuration…" menu item).
  | { type: 'openSettings' }
  // Wizard model picker — model ids plus OPTIONAL live capability hints from
  // gateways that expose them (OpenRouter/Ollama). Undefined = use heuristic.
  | { type: 'modelList'; models: Array<{ id: string; vision?: boolean; tools?: boolean }> }
  // Input-bar tools: active-editor context block / attached file contents
  | { type: 'editorContext'; text: string }
  | { type: 'attachedFiles'; files: Array<{ name: string; content: string }> }
  // Consent: the agent requires user approval for a mutating tool (inline mode)
  | { type: 'consentRequest'; requestId: string; tool: string; args: Record<string, any>; autoApproveMs?: number; expiresAt?: number }
  // Generic confirmation: ask the user to pick an option (replaces showQuickPick / showWarningMessage)
  | { type: 'confirmationRequest'; requestId: string; title: string; description: string; options: Array<{ label: string; value: string; isDangerous?: boolean }>; expiresAt?: number }
  // A consent/confirmation request resolved by its timeout (auto-approve,
  // auto-deny or auto-cancel) — the webview clears the matching card. Sent
  // so cards never linger as zombies even when they were hidden behind a
  // full-page wizard/config at the moment of expiry.
  | { type: 'promptExpired'; requestId: string; action: 'approve' | 'deny' | 'cancel' }
  // File search results for @ mentions
  | { type: 'fileSearchResults'; results: Array<{ path: string; name: string }> }
  // Session history
  | { type: 'sessionList'; sessions: Session[]; activeId: string | null }
  | { type: 'sessionSwitched'; session: Session }
  // Configuration page: full settings snapshot
  | { type: 'fullConfig'; config: Record<string, any> }
  // Proposed tasks created in ADO after user review
  | { type: 'proposedTasksCreated'; count: number; parentId: number }
  // Project creation wizard result
  | { type: 'projectWizardCreated'; success: boolean; path: string; error?: string }
  // Skill catalog
  | { type: 'openSkillCatalog' }
  // Task 9: skill system
  | { type: 'skillCatalog'; skills: Skill[] }
  | { type: 'skillInstalled'; skillId: string; success: boolean }
  | { type: 'skillUninstalled'; skillId: string; success: boolean }
  | { type: 'skillEnabled'; skillId: string; enabled: boolean }
  | { type: 'skillDetail'; skill: Skill }
  | { type: 'skillExecutionResult'; result: SkillExecutionResult }
  // Skill import result
  | { type: 'skillImportResult'; success: boolean; skill?: Skill; error?: string }
  // Skill registry
  | { type: 'registrySkills'; skills: Skill[] }
  | { type: 'registryInstallResult'; success: boolean; skill?: Skill; error?: string }
  // Right-click context menu: insert text into chat draft
  | { type: 'insertText'; text: string }
  // Chat moved to/from editor area notification for sidebar placeholder
  | { type: 'chatMovedToEditor'; inEditor: boolean };

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
  mode: 'inline' | 'plan' | 'act' | 'yolo';
  agentsEnabled: string[];
  /** Max agentic loop iterations per chat turn (config key 'act.toolBudget' — legacy name kept). */
  actMaxIterations: number;
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
  isEditor?: boolean;
}

// ── Session History ─────────────────────────────────────────────────
/** 0.6.7: a turn's Thinking/Tools record as stored in session history. The
 *  host caps reasoning excerpts (TRACE_THINKING_CAP), tool arguments and
 *  results (TRACE_ARG_CAP / TRACE_RESULT_CAP) and keeps the whole turn under
 *  TRACE_TURN_CAP characters before writing it here. Restored traces render
 *  with thinking collapsed — they are historical context, not live reasoning. */
export interface StoredTurnTrace {
  entries: TraceEntry[];
  /** True when the record was trimmed to fit the per-turn character cap. */
  truncated?: boolean;
}

export interface Session {
  /** ISO timestamp used as unique ID */
  id: string;
  /** Display name (auto-generated from first user message, or user-set) */
  name: string;
  /** ISO date string */
  createdAt: string;
  messages: Array<{ role: string; content: string; trace?: StoredTurnTrace }>;
  /** 0.6.5: ADO work item ids this session has processed (drives the
   *  one-work-item-per-session alert + session-history chips). */
  workItemIds?: number[];
  /** Display titles for the ids above (session-history chips). */
  workItemTitles?: Record<string, string>;
}

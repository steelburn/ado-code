// Webview-facing type surface.
//
// The webview and the extension host share ONE message contract, declared in
// src/shared/messages.ts (and src/shared/sessionRun.ts). This module re-exports
// it rather than duplicating it: the webview project sets `rootDir` to the
// repository root, so the repo-relative paths below resolve and webpack bundles
// them.

// Message contract.
export type {
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  // Turn trace (Thinking & Tools record)
  ToolCallInfo,
  TraceEntry,
  StoredTurnTrace,
  // Attachments / editor context
  ImageAttachment,
  MessageContext,
  // Azure DevOps work items
  WorkItemSummary,
  WorkItemDetail,
  WorkItemComment,
  WorkItemContext,
  // Configuration snapshot + chat sessions
  ExtensionConfig,
  Session,
} from '../../shared/messages';

// Session-list running badge (host-computed; see src/shared/sessionRun.ts).
export type { SessionRunInfo } from '../../shared/sessionRun';

// Agent orchestration types (host-owned).
export type { AgentName, AgentCapability, AgentRun } from '../../agents/types';

// Skill types (host-owned).
export type {
  Skill,
  SkillCategory,
  ToolChainStep,
  SkillConfig,
  SkillExecutionRequest,
  SkillExecutionResult,
} from '../../shared/skillTypes';

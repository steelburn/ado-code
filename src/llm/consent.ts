/**
 * Consent broker for the agentic tool loop.
 *
 * When a mutating tool runs in inline mode, the LLM "requires consent": the
 * host must surface a request to the user (webview card, QuickPick fallback)
 * and wait for an explicit Approve/Reject before the tool executes. The
 * broker owns that wait: it tracks the single in-flight request, resolves it
 * from a webview `consentResponse` message, and hard-fails it on timeout or
 * disposal so the agentic loop can NEVER hang on a missed prompt.
 *
 * Pure module (no `vscode` import) so it is unit-testable without the
 * extension host.
 */

export interface ConsentRequestPayload {
  tool: string;
  args: Record<string, any>;
}

export interface ConsentRequest extends ConsentRequestPayload {
  requestId: string;
}

export interface ConsentBroker {
  /** Register a new consent request; resolves true only on explicit approval. */
  request(payload: ConsentRequestPayload): { requestId: string; decision: Promise<boolean> };
  /** Resolve a pending request from a user response (webview message). */
  resolve(requestId: string, approved: boolean): void;
  /** Fail every pending request (webview disposed, chat cleared, turn aborted). */
  rejectAll(): void;
  /** The in-flight request, if any. */
  readonly pending: ConsentRequest | null;
}

// ---------------------------------------------------------------------------
// Tool-level approval support
//
// Extends the consent system with per-tool approval decisions. The pure
// functions (shouldAutoApprove, getToolApprovalCategory) live here so they
// are unit-testable. The VS Code UI (approveTool) lives in
// tool-approval-ui.ts to keep this module vscode-free.
// ---------------------------------------------------------------------------

import type { TaskLike } from './tools/BaseTool'
import { TOOL_GROUP_MAP, TOOL_DISPLAY_NAMES } from './tools/types'

/**
 * Tool approval categories — maps to the existing ToolGroup system
 * but focused on approval semantics.
 *
 * - 'read': safe, non-mutating — auto-approved when setting is enabled
 * - 'write': file mutations — auto-approved when setting is enabled
 * - 'execute': shell commands — always require explicit approval
 */
export type ToolApprovalCategory = 'read' | 'write' | 'execute'

/**
 * Subset of settings relevant to tool auto-approval.
 * Extracted from ContextProxy so this module stays testable.
 */
export interface ToolApprovalSettings {
  autoApproveReadOnly: boolean
  autoApproveWrite: boolean
}

/**
 * A request to execute a tool that may need user approval.
 */
export interface ToolApprovalRequest {
  /** The tool name (e.g. 'read_file', 'edit_file') */
  toolName: string
  /** Tool parameters from the LLM */
  params: Record<string, unknown>
  /** Task context for UI interactions */
  task: TaskLike
}

/**
 * Result of the auto-approval check.
 */
export type AutoApprovalDecision =
  | { approved: true; reason: 'auto-approved' }
  | { approved: false; reason: 'requires-approval' }

/**
 * Determine the approval category for a tool name.
 * Uses the existing TOOL_GROUP_MAP for consistency with the rest of the
 * tool system.
 *
 * Falls back to 'execute' (most restrictive) for unknown tools.
 */
export function getToolApprovalCategory(toolName: string): ToolApprovalCategory {
  if ((TOOL_GROUP_MAP.read as readonly string[]).includes(toolName)) {
    return 'read'
  }
  if ((TOOL_GROUP_MAP.write as readonly string[]).includes(toolName)) {
    return 'write'
  }
  if ((TOOL_GROUP_MAP.execute as readonly string[]).includes(toolName)) {
    return 'execute'
  }
  // ADO tools are informational reads — safe to auto-approve
  if ((TOOL_GROUP_MAP.ado as readonly string[]).includes(toolName)) {
    return 'read'
  }
  // Unknown tools: always require approval (safest option)
  return 'execute'
}

/**
 * Check if a tool should be auto-approved based on settings.
 * Pure function — no VS Code dependency.
 *
 * Decision matrix:
 * | Category | autoApproveReadOnly | autoApproveWrite | Result |
 * |----------|--------------------:|------------------:|--------|
 * | read     | true                | *                | approved |
 * | read     | false               | *                | ask     |
 * | write    | *                   | true             | approved |
 * | write    | *                   | false            | ask     |
 * | execute  | *                   | *                | always ask |
 */
export function shouldAutoApprove(
  toolName: string,
  settings: ToolApprovalSettings,
): AutoApprovalDecision {
  const category = getToolApprovalCategory(toolName)

  switch (category) {
    case 'read':
      if (settings.autoApproveReadOnly) {
        return { approved: true, reason: 'auto-approved' }
      }
      return { approved: false, reason: 'requires-approval' }

    case 'write':
      if (settings.autoApproveWrite) {
        return { approved: true, reason: 'auto-approved' }
      }
      return { approved: false, reason: 'requires-approval' }

    case 'execute':
      // Execute tools always require explicit user approval
      return { approved: false, reason: 'requires-approval' }

    default:
      return { approved: false, reason: 'requires-approval' }
  }
}

/**
 * Format a tool approval request into a human-readable prompt.
 * Used by the approval UI to show what the tool will do.
 */
export function formatApprovalPrompt(request: ToolApprovalRequest): string {
  const displayName =
    (TOOL_DISPLAY_NAMES as Record<string, string>)[request.toolName] ??
    request.toolName
  const paramSummary = formatToolParams(request.params)
  return paramSummary
    ? `Allow ${displayName}: ${paramSummary}?`
    : `Allow ${displayName}?`
}

/**
 * Format tool parameters into a brief, readable summary.
 * Shows the most important/identifying parameters first.
 */
export function formatToolParams(params: Record<string, unknown>): string {
  const parts: string[] = []

  // Prioritize params that identify what the tool will touch
  const priorityKeys = ['path', 'command', 'glob', 'regex', 'id']
  for (const key of priorityKeys) {
    if (key in params && params[key] !== undefined && params[key] !== null) {
      const val = String(params[key])
      const truncated = val.length > 100 ? val.slice(0, 97) + '...' : val
      parts.push(`${key}: ${truncated}`)
    }
  }

  // For write tools, hint at content length rather than dumping it
  if ('content' in params && params.content !== undefined) {
    const content = String(params.content)
    parts.push(`content: ${content.length} chars`)
  }

  return parts.join(', ')
}

/**
 * Convenience: resolve the tool approval settings from a ContextProxy
 * instance. Call this when wiring the approval system to VS Code.
 *
 * @example
 * ```ts
 * import { ContextProxy } from '../config/ContextProxy'
 * const settings = resolveToolApprovalSettings(ContextProxy.instance)
 * if (shouldAutoApprove('read_file', settings).approved) { ... }
 * ```
 */
export function resolveToolApprovalSettings(proxy: {
  getValue(key: string): unknown
}): ToolApprovalSettings {
  return {
    autoApproveReadOnly: (proxy.getValue('autoApproveReadOnly') as boolean) ?? true,
    autoApproveWrite: (proxy.getValue('autoApproveWrite') as boolean) ?? false,
  }
}

// ---------------------------------------------------------------------------
// End of tool-level approval support
// ---------------------------------------------------------------------------

export function createConsentBroker(timeoutMs = 120000): ConsentBroker {
  let pendingRequest: ConsentRequest | null = null;
  let pendingResolve: ((approved: boolean) => void) | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  function clearPending(): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    pendingRequest = null;
    pendingResolve = null;
  }

  return {
    get pending() {
      return pendingRequest;
    },
    request(payload) {
      // The agentic loop executes tool calls sequentially, so at most one
      // request is outstanding — but never strand a previous one silently.
      if (pendingResolve) {
        pendingResolve(false);
        clearPending();
      }
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      pendingRequest = { requestId, tool: payload.tool, args: payload.args };
      const decision = new Promise<boolean>((resolve) => {
        pendingResolve = resolve;
        pendingTimer = setTimeout(() => {
          // User never answered — DENY. The agentic loop must not block
          // forever on a prompt nobody saw.
          pendingResolve?.(false);
          clearPending();
        }, timeoutMs);
      });
      return { requestId, decision };
    },
    resolve(requestId, approved) {
      if (!pendingRequest || pendingRequest.requestId !== requestId || !pendingResolve) return;
      pendingResolve(approved);
      clearPending();
    },
    rejectAll() {
      if (pendingResolve) {
        pendingResolve(false);
        clearPending();
      }
    },
  };
}

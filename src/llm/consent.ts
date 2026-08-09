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
  /** Fail every pending request (chat cleared, turn aborted, newer message). */
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
// Harmless command classification
// ---------------------------------------------------------------------------

/**
 * Read-only git subcommands — safe to auto-approve with a timer.
 * Used by `isHarmlessCommand()` to classify terminal commands.
 */
const HARMLESS_GIT_SUBCMDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'tag',
  'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list',
  'ls-files', 'ls-remote', 'config', 'assume-unchanged',
])

/**
 * Base commands that are always read-only (no subcommand needed).
 */
const HARMLESS_BASE_CMDS = new Set([
  'ls', 'dir', 'pwd', 'tree', 'find', 'fd',
  'cat', 'head', 'tail', 'less', 'more',
  'wc', 'grep', 'rg', 'ag', 'ack',
  'echo', 'date', 'whoami', 'hostname', 'uname',
  'which', 'where', 'type', 'file', 'stat',
  'env', 'printenv',
  'node', 'python', 'python3', 'npx',
  'cargo', 'rustc',
  'curl', 'wget',
])

/**
 * Commands with read-only subcommands (first arg determines safety).
 */
const HARMLESS_SUBCMD_MAP: Record<string, Set<string>> = {
  git: HARMLESS_GIT_SUBCMDS,
  npm: new Set(['test', 'run', 'list', 'ls', 'info', 'view', 'outdated', 'doctor']),
  pip: new Set(['list', 'show', 'check']),
  yarn: new Set(['list', 'info', 'outdated']),
  pnpm: new Set(['list', 'info', 'outdated']),
}

/**
 * Determine whether a terminal command is harmless (read-only) and safe to
 * auto-approve after a timer. A command is harmless when:
 *
 * 1. It contains no shell operators (`&`, `|`, `;`, backtick, `$`, `<`, `>`,
 *    `(`, `)`, newlines).
 * 2. Its base command + optional subcommand match a known read-only pattern.
 *
 * This is used by the consent timer to decide whether to start a countdown
 * on the consent card. The timer is an additional safety layer — the user
 * can still manually approve or reject before it expires.
 */
export function isHarmlessCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  // Reject shell operators — multi-word commands are fine (e.g. "npm test"),
  // but operators enable injection.
  if (!/^[^&|;`$<>()\r\n]*$/.test(trimmed)) return false

  const tokens = trimmed.match(/"[^"]*"|\S+/g) ?? []
  if (tokens.length === 0) return false

  const base = tokens[0]!.toLowerCase()

  // Base commands that are always safe (no subcommand needed)
  if (HARMLESS_BASE_CMDS.has(base)) return true

  // Commands with subcommand-based safety (e.g. git status, npm test)
  const allowedSubs = HARMLESS_SUBCMD_MAP[base]
  if (allowedSubs) {
    const subcmd = tokens[1]?.toLowerCase()
    if (!subcmd) return false
    return allowedSubs.has(subcmd)
  }

  return false
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

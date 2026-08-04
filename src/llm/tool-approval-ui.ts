/**
 * Tool approval UI — VS Code QuickPick integration for tool-level consent.
 *
 * This module provides the VS Code-dependent piece of the tool approval
 * system. The pure decision logic lives in consent.ts so it stays
 * unit-testable without the extension host.
 *
 * Usage in the agentic loop:
 * ```ts
 * import { shouldAutoApprove, resolveToolApprovalSettings } from './consent'
 * import { approveTool } from './tool-approval-ui'
 *
 * const settings = resolveToolApprovalSettings(ContextProxy.instance)
 * const decision = shouldAutoApprove(toolName, settings)
 * if (!decision.approved) {
 *   const approved = await approveTool({ toolName, params, task })
 *   if (!approved) return 'Tool execution rejected by user'
 * }
 * ```
 */

import * as vscode from 'vscode'
import type { TaskLike } from './tools/BaseTool'
import {
  shouldAutoApprove,
  formatApprovalPrompt,
  resolveToolApprovalSettings,
  type ToolApprovalRequest,
  type ToolApprovalSettings,
} from './consent'

// Re-export pure utilities for convenience
export {
  shouldAutoApprove,
  formatApprovalPrompt,
  resolveToolApprovalSettings,
  type ToolApprovalRequest,
  type ToolApprovalSettings,
  type ToolApprovalCategory,
  type AutoApprovalDecision,
  getToolApprovalCategory,
  formatToolParams,
} from './consent'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Timeout for the quick-pick approval dialog (120 seconds). */
const APPROVAL_TIMEOUT_MS = 120_000

/** Quick-pick items shown to the user. */
const APPROVE_ITEM: vscode.QuickPickItem = {
  label: '$(check) Approve',
  description: 'Allow this tool to execute',
}

const REJECT_ITEM: vscode.QuickPickItem = {
  label: '$(close) Reject',
  description: 'Deny this tool execution',
}

const ALWAYS_ALLOW_ITEM: vscode.QuickPickItem = {
  label: '$(zap) Always Allow This Session',
  description: 'Auto-approve all tools of this type until chat is cleared',
}

// ─── Session-wide approval cache ────────────────────────────────────────────

/**
 * Tracks tools the user has chosen to "always allow" for the current session.
 * Reset when the chat is cleared or a new task starts.
 */
const sessionAutoApprove = new Set<string>()

/**
 * Check if a tool has been session-auto-approved (user chose "Always Allow").
 */
export function isSessionAutoApproved(toolName: string): boolean {
  return sessionAutoApprove.has(toolName)
}

/**
 /** Clear all session-wide auto-approvals.
  * Call this when starting a new task or clearing the chat.
  */
 export function clearSessionAutoApprovals(): void {
   sessionAutoApprove.clear()
   sessionCommandApprove.clear()
 }

 // ─── Per-command session approval (terminal command allowlist) ──────────────

 /**
  * Tracks exact terminal commands the user chose to "allow for session".
  * Key is the trimmed command string. Reset when the chat is cleared.
  */
 const sessionCommandApprove = new Set<string>()

 /** Check if a terminal command has been session-approved. */
 export function isCommandSessionApproved(command: string): boolean {
   return sessionCommandApprove.has(command.trim())
 }

 /** Add a terminal command to the session approval cache. */
 export function addSessionCommandApproval(command: string): void {
   sessionCommandApprove.add(command.trim())
 }

 // ─── Permanent allowlist update ────────────────────────────────────────────

 /**
  * Add a command to the VS Code setting `adoCode.act.terminalAllowlist`.
  * This persists across sessions so the command auto-executes in act mode.
  */
 export async function addToTerminalAllowlist(command: string): Promise<void> {
   const cfg = vscode.workspace.getConfiguration('adoCode')
   const current = cfg.get<string[]>('act.terminalAllowlist', [
     'npm test', 'npm run lint', 'git diff', 'git status',
   ])
   const trimmed = command.trim()
   if (!current.includes(trimmed)) {
     await cfg.update(
       'act.terminalAllowlist',
       [...current, trimmed],
       vscode.ConfigurationTarget.Global,
     )
   }
 }

 // ─── Core approval function ─────────────────────────────────────────────────

/**
 * Ask the user to approve (or reject) a tool execution.
 *
 * Flow:
 * 1. Check session-wide auto-approval cache
 * 2. Check persistent settings (autoApproveReadOnly / autoApproveWrite)
 * 3. If neither applies, show a VS Code QuickPick dialog
 *
 * @param request - The tool approval request
 * @param settings - Optional settings override (otherwise reads from ContextProxy)
 * @returns true if approved, false if rejected or timed out
 */
export async function approveTool(
  request: ToolApprovalRequest,
  settings?: ToolApprovalSettings,
): Promise<boolean> {
  // 1. Session-wide auto-approval (user chose "Always Allow" earlier)
  if (isSessionAutoApproved(request.toolName)) {
    return true
  }

  // 2. Persistent settings check
  const effectiveSettings = settings ?? resolveSettingsSafe()
  if (effectiveSettings) {
    const decision = shouldAutoApprove(request.toolName, effectiveSettings)
    if (decision.approved) {
      return true
    }
  }

  // 3. Show VS Code QuickPick for manual approval
  return showApprovalQuickPick(request)
}

/**
 * High-level approval check that returns a decision object.
 * Useful when the caller needs to distinguish between auto-approved
 * and user-approved for logging/UI purposes.
 */
export async function checkAndApproveTool(
  request: ToolApprovalRequest,
  settings?: ToolApprovalSettings,
): Promise<{ approved: boolean; method: 'auto' | 'session' | 'user' | 'rejected' }> {
  // Session cache
  if (isSessionAutoApproved(request.toolName)) {
    return { approved: true, method: 'session' }
  }

  // Persistent settings
  const effectiveSettings = settings ?? resolveSettingsSafe()
  if (effectiveSettings) {
    const decision = shouldAutoApprove(request.toolName, effectiveSettings)
    if (decision.approved) {
      return { approved: true, method: 'auto' }
    }
  }

  // Manual approval
  const approved = await showApprovalQuickPick(request)
  return { approved, method: approved ? 'user' : 'rejected' }
}

// ─── QuickPick UI ───────────────────────────────────────────────────────────

/**
 * Show a VS Code QuickPick dialog asking the user to approve/reject a tool.
 * Times out after APPROVAL_TIMEOUT_MS and rejects if the user doesn't respond.
 */
async function showApprovalQuickPick(request: ToolApprovalRequest): Promise<boolean> {
  const prompt = formatApprovalPrompt(request)

  const pick = await Promise.race([
    vscode.window.showQuickPick(
      [APPROVE_ITEM, ALWAYS_ALLOW_ITEM, REJECT_ITEM],
      {
        placeHolder: prompt,
        title: 'Tool Approval Required',
        ignoreFocusOut: true, // Don't dismiss if user clicks elsewhere
      },
    ),
    timeout(APPROVAL_TIMEOUT_MS).then(() => undefined),
  ])

  if (!pick) {
    // Timeout or dismissed — treat as rejection
    return false
  }

  if (pick === APPROVE_ITEM) {
    return true
  }

  if (pick === ALWAYS_ALLOW_ITEM) {
    // Add to session cache so future calls for this tool auto-approve
    sessionAutoApprove.add(request.toolName)
    await vscode.window.showInformationMessage(
      `${request.toolName} will be auto-approved for the rest of this session.`,
    )
    return true
  }

  // REJECT_ITEM or anything else
  return false
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a promise that resolves after the given milliseconds.
 * Used for timeout racing against the QuickPick.
 */
function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Safely resolve settings from ContextProxy.
 * Returns null if ContextProxy is not yet initialized (e.g. during testing).
 */
function resolveSettingsSafe(): ToolApprovalSettings | null {
  try {
    // Dynamic import to avoid circular dependency issues
    // and to keep this module loadable even if ContextProxy isn't ready
    const { ContextProxy } = require('../config/ContextProxy') as typeof import('../config/ContextProxy')
    return resolveToolApprovalSettings(ContextProxy.instance)
  } catch {
    // ContextProxy not initialized yet — fall through to manual approval
    return null
  }
}

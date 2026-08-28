/**
 * Tool approval — session-scoped approval caches for tool consent.
 *
 * The pure decision logic lives in consent.ts (unit-testable without the
 * extension host). This module holds the in-memory approval caches the
 * executor / host consult before prompting:
 *
 * - `sessionAutoApprove` — tool names the user chose "Allow for Session" on
 *   (any mutating tool, via the consent card). Auto-approves later calls of
 *   that tool until the chat is cleared or a new session starts.
 * - `sessionCommandApprove` — exact terminal commands the user chose
 *   "Allow for Session" on. Checked by the act-mode gate before prompting,
 *   and by requestConsent for inline mode.
 * - `addToTerminalAllowlist` — persists "Allow Permanently" to the VS Code
 *   setting `adoCode.act.terminalAllowlist` (survives restarts).
 */

import * as vscode from 'vscode'
import { matchesToolPattern, matchesCommandPattern } from './consent'

// Re-export pure utilities for convenience
// (the legacy approval-decision family — shouldAutoApprove, formatApprovalPrompt,
// ToolApprovalRequest & friends — was removed: the live consent flow uses the
// ConsentBroker + gateTool, see src/llm/tools.ts).
export {
  isHarmlessCommand,
  matchesToolPattern,
  matchesCommandPattern,
} from './consent'

// ─── Session-wide tool approval cache ───────────────────────────────────────

/**
 * Tracks tools the user has chosen to "allow for session" via the consent
 * card. Auto-approves every later call of the same tool until the chat is
 * cleared or a new session starts.
 */
const sessionAutoApprove = new Set<string>()

/** Check if a tool has been session-approved ("Allow for Session"). */
export function isSessionAutoApproved(toolName: string): boolean {
  // Exact matches AND wildcard patterns (e.g. the user approved "read_*").
  return matchesToolPattern(toolName, [...sessionAutoApprove]);
}

/** Add a tool to the session approval cache. */
export function addSessionToolApproval(toolName: string): void {
  sessionAutoApprove.add(toolName)
}

/** Clear all session-wide approvals (chat cleared / new session starts). */
export function clearSessionAutoApprovals(): void {
  sessionAutoApprove.clear()
  sessionCommandApprove.clear()
}

// ─── Per-command session approval (terminal command allowlist) ──────────────

/**
 * The commands a run_terminal_command call will execute, in order: the
 * `commands` batch array if present, else the single `command` string.
 * Empty entries are dropped. Shared by the executor gate, the consent
 * session cache and the deny-key logic so single + batch calls agree.
 */
export function terminalCommandList(args: Record<string, any>): string[] {
  if (Array.isArray(args.commands) && args.commands.length > 0) {
    return args.commands.map((c: unknown) => String(c)).filter(Boolean);
  }
  const single = String(args.command ?? '').trim();
  return single ? [single] : [];
}

/**
 * Canonical identity of a terminal-command call (single or batch) used for
 * consent deny keys and session-approval records: the commands joined with
 * ' | ' (e.g. `git status | git diff`). A batch is only auto-approved when
 * the SAME batch was approved before; a single command of the same string
 * is still treated separately.
 */
export function terminalCommandKey(args: Record<string, any>): string {
  return terminalCommandList(args).join(' | ');
}

/**
 * Tracks exact terminal commands the user chose to "allow for session".
 * Key is the trimmed command string. Reset when the chat is cleared.
 */
const sessionCommandApprove = new Set<string>()

/** Check if a terminal command has been session-approved. */
export function isCommandSessionApproved(command: string): boolean {
  // Exact matches AND wildcard patterns (e.g. the user approved "git *").
  return matchesCommandPattern(command.trim(), [...sessionCommandApprove]);
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

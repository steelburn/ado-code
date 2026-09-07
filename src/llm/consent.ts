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
  /** Absolute deadline (ms epoch) of the FIRST timeout that applies — the
   *  auto-approve instant when `autoApproveMs` is set, else the hard-deny
   *  instant. Mirrored to the webview so the card countdown tracks the host
   *  timer exactly (and survives card remounts / full-page wizard detours). */
  expiresAt: number;
  /** When set, the request AUTO-APPROVES after this many ms (harmless
   *  commands). The hard-deny timeout is then only a backstop. */
  autoApproveMs?: number;
}

/** What the host decided when a consent request timed out. */
export type ConsentTimeoutAction = 'approve' | 'deny';

export interface ConsentBroker {
  /**
   * Register a new consent request; resolves true only on explicit approval.
   * `options.autoApproveMs` starts a timer that auto-approves (harmless
   * read-only commands); without it the request hard-denies after the
   * broker timeout. Returns the deadline the card should count down to.
   */
  request(
    payload: ConsentRequestPayload,
    options?: { autoApproveMs?: number }
  ): { requestId: string; decision: Promise<boolean>; expiresAt: number };
  /** Resolve a pending request from a user response (webview message). */
  resolve(requestId: string, approved: boolean): void;
  /** Fail every pending request (chat cleared, turn aborted, newer message). */
  rejectAll(): void;
  /**
   * Freeze the pending request's timers, preserving the time remaining
   * (user switched away from the chat, or a full-page wizard/config is open
   * and the prompt card is not visible). A paused request cannot time out.
   */
  pause(): void;
  /**
   * Un-freeze the timers, re-based onto the frozen remaining time, and push
   * the new deadline onto `pending.expiresAt` so the host can re-post the
   * card with an accurate countdown. No-op when not paused.
   */
  resume(): void;
  /** True while the pending request's timers are frozen. */
  readonly paused: boolean;
  /** The in-flight request, if any. */
  readonly pending: ConsentRequest | null;
}

// ---------------------------------------------------------------------------
// Harmless command classification
//
// The VS Code UI (approveTool / session approval caches) lives in
// tool-approval-ui.ts to keep this module vscode-free.
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

// ---------------------------------------------------------------------------
// Wildcard permission matching
//
// Tools and terminal commands can be auto-approved by glob patterns so users
// can grant broader permission "to a certain extent":
//   - `adoCode.consent.autoApproveTools`  e.g. ["read_*", "get_*"]
//   - `adoCode.act.terminalAllowlist`     e.g. ["git *", "npm run *"]
// Patterns support `*` (any run of characters) and `?` (any single char). A
// trailing bare `*` in a COMMAND pattern swallows any remaining tokens, so
// `git *` permits every git subcommand while `git push *` only permits pushes.
// ---------------------------------------------------------------------------

/** Convert a `*`/`?` glob into a whole-string RegExp (regex chars escaped). */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Split a shell-ish line into tokens, keeping "quoted chunks" together. */
function tokenize(line: string): string[] {
  return line.match(/"[^"]*"|\S+/g) ?? [];
}

function tokenMatches(patternToken: string, token: string): boolean {
  if (!patternToken.includes('*') && !patternToken.includes('?')) {
    return patternToken === token;
  }
  return globToRegExp(patternToken).test(token);
}

/**
 * True when a tool name matches any of the given glob patterns (or equals a
 * literal entry). Patterns match the WHOLE tool name: "read_*" matches
 * read_file and read_workspace_memory; "get_*" matches get_work_items.
 */
export function matchesToolPattern(toolName: string, patterns: string[]): boolean {
  for (const raw of patterns ?? []) {
    const p = raw.trim();
    if (!p) continue;
    if (!p.includes('*') && !p.includes('?')) {
      if (p === toolName) return true;
      continue;
    }
    if (globToRegExp(p).test(toolName)) return true;
  }
  return false;
}

/**
 * True when a terminal command matches any of the given command patterns.
 * Each pattern token is matched against the command token at the same
 * position (per-token glob); a trailing bare `*` swallows any remaining
 * command tokens, so `git *` matches git status AND git push origin main.
 */
export function matchesCommandPattern(command: string, patterns: string[]): boolean {
  const cTokens = tokenize(command.trim());
  if (cTokens.length === 0) return false;
  for (const raw of patterns ?? []) {
    const pTokens = tokenize(raw.trim());
    if (pTokens.length === 0) continue;
    const trailingWild = pTokens[pTokens.length - 1] === '*';
    // With a trailing bare `*`, the required prefix is everything before it;
    // without one, the command must have the SAME token count.
    const required = trailingWild ? pTokens.slice(0, -1) : pTokens;
    if (cTokens.length < required.length) continue;
    if (!trailingWild && cTokens.length !== pTokens.length) continue;
    let ok = true;
    for (let i = 0; i < required.length; i++) {
      if (!tokenMatches(required[i]!, cTokens[i]!)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// End of wildcard permission matching
// ---------------------------------------------------------------------------

export function createConsentBroker(
  timeoutMs = 120000,
  /** Called when a request resolves because its time ran out — lets the host
   *   surface the expiry (e.g. clear the webview card). Never called when the
   *   user answered first. */
  onTimeout?: (request: ConsentRequest, action: ConsentTimeoutAction) => void
): ConsentBroker {
  let pendingRequest: ConsentRequest | null = null;
  let pendingResolve: ((approved: boolean) => void) | null = null;
  // Two independent deadlines: the auto-approve instant (harmless commands)
  // and the hard-deny instant. Whichever fires first wins and cancels both.
  let approveAt: number | undefined;
  let denyAt: number | undefined;
  let approveTimer: ReturnType<typeof setTimeout> | undefined;
  let denyTimer: ReturnType<typeof setTimeout> | undefined;
  // While frozen (pause), the deadlines no longer advance — remaining time
  // is preserved by re-basing them onto `Date.now()` at resume().
  let frozen = false;

  function clearTimers(): void {
    if (approveTimer) clearTimeout(approveTimer);
    if (denyTimer) clearTimeout(denyTimer);
    approveTimer = undefined;
    denyTimer = undefined;
  }

  function clearPending(): void {
    clearTimers();
    frozen = false;
    approveAt = undefined;
    denyAt = undefined;
    pendingRequest = null;
    pendingResolve = null;
  }

  /** Resolve the pending request with the timed-out outcome, if still pending. */
  function settle(requestId: string, action: ConsentTimeoutAction): void {
    // Already answered/superseded? Leave the outcome alone.
    if (!pendingRequest || pendingRequest.requestId !== requestId || !pendingResolve) return;
    onTimeout?.(pendingRequest, action);
    pendingResolve(action === 'approve');
    clearPending();
  }

  /** (Re)arm both timers from their (frozen or fresh) deadlines. */
  function arm(requestId: string): void {
    clearTimers();
    if (frozen || !pendingRequest || pendingRequest.requestId !== requestId) return;
    const now = Date.now();
    if (approveAt !== undefined) {
      const delay = approveAt - now;
      if (delay <= 0) { settle(requestId, 'approve'); return; }
      approveTimer = setTimeout(() => settle(requestId, 'approve'), delay);
    }
    const denyDelay = (denyAt ?? now) - now;
    if (denyDelay <= 0) { settle(requestId, 'deny'); return; }
    denyTimer = setTimeout(() => settle(requestId, 'deny'), denyDelay);
  }

  return {
    get pending() {
      return pendingRequest;
    },
    get paused() {
      return frozen;
    },
    request(payload, options) {
      // The agentic loop executes tool calls sequentially, so at most one
      // request is outstanding — but never strand a previous one silently.
      if (pendingResolve) {
        pendingResolve(false);
        clearPending();
      }
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const autoApproveMs =
        options?.autoApproveMs && options.autoApproveMs > 0 ? options.autoApproveMs : undefined;
      const now = Date.now();
      approveAt = autoApproveMs ? now + autoApproveMs : undefined;
      denyAt = now + timeoutMs;
      // The card counts down to the EARLIER deadline (the one that matters).
      pendingRequest = { requestId, tool: payload.tool, args: payload.args, autoApproveMs, expiresAt: approveAt ?? denyAt };
      const decision = new Promise<boolean>((resolve) => {
        pendingResolve = resolve;
        arm(requestId);
      });
      return { requestId, decision, expiresAt: pendingRequest.expiresAt };
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
    pause() {
      if (frozen || !pendingRequest) return;
      frozen = true;
      clearTimers();
      // Convert the absolute deadlines into REMAINING durations so time spent
      // paused never counts against the user (deadlines don't advance while
      // frozen; resume() re-bases them onto a fresh Date.now()).
      const now = Date.now();
      if (approveAt !== undefined) {
        approveAt = Math.max(0, approveAt - now);
      }
      denyAt = Math.max(0, (denyAt ?? now) - now);
    },
    resume() {
      if (!frozen || !pendingRequest) return;
      frozen = false;
      // approveAt/denyAt currently hold the REMAINING ms frozen at pause().
      const now = Date.now();
      if (approveAt !== undefined) {
        approveAt = now + approveAt;
      }
      denyAt = now + (denyAt ?? 0);
      pendingRequest.expiresAt = approveAt ?? denyAt;
      arm(pendingRequest.requestId);
    },
  };
}

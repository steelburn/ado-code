import React, { useMemo } from 'react';
import { useCountdown, formatCountdown } from './ui/useCountdown';

export interface ConsentRequest {
  requestId: string;
  tool: string;
  args: Record<string, any>;
  /** When set, the request AUTO-APPROVES after this many ms (harmless
   *  read-only commands) — the host enforces the deadline even when the card
   *  is hidden behind a full-page wizard/config. */
  autoApproveMs?: number;
  /** Absolute deadline (epoch ms) of the timeout the host will enforce: the
   *  auto-approve instant when `autoApproveMs` is set, else the auto-deny
   *  instant. The countdown tracks this so it survives card remounts. */
  expiresAt?: number;
}

type ConsentScope = 'once' | 'session' | 'permanent';

interface Props {
  request: ConsentRequest;
  onRespond: (requestId: string, approved: boolean, scope?: ConsentScope) => void;
}

/** One-line human summary of what the tool is about to do (args → hint). */
function summarize(tool: string, args: Record<string, any>): string {
  switch (tool) {
    case 'run_terminal_command':
      return `$ ${String(args.command ?? '')}`;
    case 'edit_file':
      return `Edit ${String(args.path ?? '?')}`;
    case 'apply_diff':
      return `Apply diff to ${String(args.path ?? '?')}`;
    case 'update_work_item_state':
      return `Work item #${String(args.id ?? '?')} → ${String(args.state ?? '?')}`;
    case 'add_comment':
      return `Comment on work item #${String(args.id ?? '?')}`;
    case 'delegate_to_agent':
      return `Delegate to agent${args.agent ? ` (${String(args.agent)})` : ''}: ${String(args.prompt ?? '').slice(0, 120)}${String(args.prompt ?? '').length > 120 ? '…' : ''}`;
    default:
      return `${tool} ${JSON.stringify(args)}`;
  }
}

/**
 * Inline consent card: the agent (LLM) wants to run a mutating tool and the
 * user must approve before it executes (inline mode). Rendered above the
 * input bar so it can't be missed; posts consentResponse.
 *
 * Every mutating tool gets "Allow for Session" (auto-approve this tool until
 * the chat is cleared or a new session starts). Terminal commands get one
 * extra option, "Allow Permanently" (persists to act.terminalAllowlist).
 *
 * Every card shows a countdown to the host-enforced timeout, with the
 * post-timeout action in the label:
 *   - harmless terminal commands (autoApproveMs) → "Auto-approving in m:ss"
 *   - everything else                          → "Auto-denying in m:ss"
 * The user can still click any button to cancel the timer and respond
 * immediately. The countdown is DISPLAY ONLY: the host owns the deadline
 * and resolves it (approve/deny) — even when this card is unmounted or the
 * view hidden, and pausing while the user detours to another view or a
 * full-page wizard/config freezes the time remaining instead of expiring it.
 */
export function ConsentCard({ request, onRespond }: Props) {
  const isTerminal = request.tool === 'run_terminal_command';
  const argsText = Object.keys(request.args).length > 0
    ? JSON.stringify(request.args, null, 2)
    : '{}';

  // Auto-approve (harmless commands) vs auto-deny (everything else).
  const autoApproveMs = request.autoApproveMs;
  const autoApproves = !!autoApproveMs && autoApproveMs > 0;
  // Absolute deadline; legacy producers without expiresAt fall back to a
  // mount-relative auto-approve window so the countdown still appears. The
  // deadline is memoized per request so it never drifts across renders.
  const expiresAt = useMemo(() => {
    if (request.expiresAt) return request.expiresAt;
    return autoApproves ? Date.now() + autoApproveMs! : undefined;
  }, [request.expiresAt, request.requestId, autoApproves, autoApproveMs]);

  // Display-only countdown to the host-enforced deadline. The HOST resolves
  // the request when the deadline passes (auto-approve / auto-deny) and posts
  // promptExpired to clear this card; the card never auto-responds itself, so
  // a paused timer (user on another view / in a full-page wizard) can't be
  // defeated by a client tick firing while the user is away.
  const countdown = useCountdown(expiresAt);

  const showTimer = !!countdown && countdown.remainingMs > 0;

  return (
    <div className="consent-card">
      <div className="consent-card-header">
        <span className="consent-card-icon">🔐</span>
        <div className="consent-card-title">
          <span className="consent-card-heading">Consent required</span>
          <span className="consent-card-sub">
            {isTerminal
              ? 'Terminal command not in allow list'
              : 'The agent wants to run a mutating tool'}
          </span>
        </div>
      </div>
      <div className="consent-card-body">
        <code className="consent-card-tool">{request.tool}</code>
        <div className="consent-card-summary">{summarize(request.tool, request.args)}</div>
        <pre className="consent-card-args">{argsText}</pre>
      </div>
      {/* Countdown to the host-enforced timeout — label names the post-timeout
          action so the user knows what happens if they don't answer. */}
      {showTimer && (
        <div className="consent-card-timer">
          <div className="consent-card-timer-bar">
            <div
              className="consent-card-timer-fill"
              style={{ width: `${(countdown.remainingMs / Math.max(1, countdown.totalMs)) * 100}%` }}
            />
          </div>
          <span className="consent-card-timer-text">
            {autoApproves
              ? `Auto-approving in ${formatCountdown(countdown.remainingMs)}`
              : `Auto-denying in ${formatCountdown(countdown.remainingMs)}`}
          </span>
        </div>
      )}
      <div className="consent-card-actions consent-card-actions--terminal">
        {isTerminal ? (
          <>
            <button
              className="btn btn-approve"
              onClick={() => onRespond(request.requestId, true)}
              title="Allow this command to run one time"
            >
              Allow Once
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => onRespond(request.requestId, true, 'session')}
              title="Allow this exact command for the rest of this session"
            >
              Allow for Session
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => onRespond(request.requestId, true, 'permanent')}
              title="Add this command to the permanent allow list"
            >
              Allow Permanently
            </button>
            <button
              className="btn btn-reject"
              onClick={() => onRespond(request.requestId, false)}
            >
              Deny
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-approve"
              onClick={() => onRespond(request.requestId, true)}
              title="Allow this tool to run one time"
            >
              Approve
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => onRespond(request.requestId, true, 'session')}
              title="Auto-approve this tool for the rest of this session"
            >
              Allow for Session
            </button>
            <button
              className="btn btn-reject"
              onClick={() => onRespond(request.requestId, false)}
            >
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}

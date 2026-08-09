import React, { useState, useEffect, useRef } from 'react';

export interface ConsentRequest {
  requestId: string;
  tool: string;
  args: Record<string, any>;
  /** When set, the card auto-approves after this many milliseconds. */
  autoApproveMs?: number;
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
 * When `autoApproveMs` is set (harmless commands), a countdown timer appears.
 * If the timer expires, the command is auto-approved. The user can still
 * click any button to cancel the timer and respond immediately.
 */
export function ConsentCard({ request, onRespond }: Props) {
  const isTerminal = request.tool === 'run_terminal_command';
  const argsText = Object.keys(request.args).length > 0
    ? JSON.stringify(request.args, null, 2)
    : '{}';

  // ── Auto-approve countdown timer ────────────────────────────────────────
  const autoApproveMs = request.autoApproveMs;
  const [remainingMs, setRemainingMs] = useState(autoApproveMs ?? 0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!autoApproveMs || autoApproveMs <= 0) return;

    setRemainingMs(autoApproveMs);
    firedRef.current = false;

    const tickMs = 100; // update display every 100ms for smooth countdown
    timerRef.current = setInterval(() => {
      setRemainingMs(prev => {
        const next = prev - tickMs;
        if (next <= 0) {
          // Timer expired — auto-approve (once)
          if (timerRef.current) clearInterval(timerRef.current);
          if (!firedRef.current) {
            firedRef.current = true;
            // Defer to avoid setState-during-render
            setTimeout(() => onRespond(request.requestId, true), 0);
          }
          return 0;
        }
        return next;
      });
    }, tickMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoApproveMs, request.requestId, onRespond]);

  // Remaining seconds (ceiling so "5s" shows while > 0)
  const remainingSec = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  const hasTimer = !!autoApproveMs && autoApproveMs > 0;

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
      {/* Auto-approve timer bar */}
      {hasTimer && remainingMs > 0 && (
        <div className="consent-card-timer">
          <div className="consent-card-timer-bar">
            <div
              className="consent-card-timer-fill"
              style={{ width: `${(remainingMs / autoApproveMs!) * 100}%` }}
            />
          </div>
          <span className="consent-card-timer-text">
            Auto-approving in {remainingSec}s
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

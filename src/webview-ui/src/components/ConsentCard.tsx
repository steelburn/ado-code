import React from 'react';

export interface ConsentRequest {
  requestId: string;
  tool: string;
  args: Record<string, any>;
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
 */
export function ConsentCard({ request, onRespond }: Props) {
  const isTerminal = request.tool === 'run_terminal_command';
  const argsText = Object.keys(request.args).length > 0
    ? JSON.stringify(request.args, null, 2)
    : '{}';
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

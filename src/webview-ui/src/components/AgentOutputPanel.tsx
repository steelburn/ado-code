import React, { useState, useRef, useEffect } from 'react';

interface AgentRun {
  id: string;
  workItemId?: number;
  agent: string;
  branch?: string;
  worktreePath?: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}

interface Props {
  run: AgentRun | null;
  output: string;
  loading: boolean;
  onDismiss?: (runId: string) => void;
  onReopen?: (runId: string) => void;
}

export function AgentOutputPanel({ run, output, loading, onDismiss, onReopen }: Props) {
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current && expanded) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, expanded]);

  if (!run) return null;

  const isFinished = run.status !== 'running';

  const statusColors: Record<string, string> = {
    running: 'var(--vscode-progressBar-background)',
    succeeded: 'var(--vscode-terminal-ansiGreen)',
    failed: 'var(--vscode-terminal-ansiRed)',
    cancelled: 'var(--vscode-descriptionForeground)',
    interrupted: 'var(--vscode-terminal-ansiYellow)',
  };

  const statusLabels: Record<string, string> = {
    running: 'Running',
    succeeded: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
  };

  return (
    <div className="agent-output-panel">
      <div className="agent-output-header" onClick={() => setExpanded(!expanded)}>
        <span className={`task-detail-chevron ${expanded ? 'open' : ''}`}>▶</span>
        <span className="agent-output-icon">🤖</span>
        <span className="agent-output-agent">{run.agent}</span>
        <span
          className="agent-output-status"
          style={{ color: statusColors[run.status] || 'inherit' }}
        >
          {loading && run.status === 'running' ? (
            <span className="agent-output-spinner">●</span>
          ) : null}
          {statusLabels[run.status] || run.status}
        </span>
        {run.workItemId && (
          <span className="agent-output-wi">ADO-{run.workItemId}</span>
        )}
        {run.branch && (
          <span
            className="agent-output-branch"
            style={{
              marginLeft: 4,
              padding: '1px 6px',
              borderRadius: 4,
              fontSize: '0.78em',
              background: 'var(--vscode-badge-background, #333)',
              color: 'var(--vscode-badge-foreground, #ccc)',
            }}
            title={run.worktreePath ? `Worktree: ${run.worktreePath}` : 'Branch'}
          >
            {run.branch}
          </span>
        )}
        {isFinished && onReopen && (
          <button
            className="agent-output-close"
            onClick={(e) => {
              e.stopPropagation();
              onReopen(run.id);
            }}
            title="Reopen output in editor panel"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'var(--vscode-textLink-foreground)',
              cursor: 'pointer',
              padding: '2px 6px',
              fontSize: '12px',
              lineHeight: 1,
              borderRadius: '4px',
            }}
          >
            ↗
          </button>
        )}
        {isFinished && onDismiss && (
          <button
            className="agent-output-close"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(run.id);
            }}
            title="Dismiss"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--vscode-descriptionForeground)',
              cursor: 'pointer',
              padding: '2px 6px',
              fontSize: '14px',
              lineHeight: 1,
              borderRadius: '4px',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {expanded && (
        <div className="agent-output-body">
          {output && (
            <div className="agent-output-content" ref={outputRef}>
              <pre>{output}</pre>
            </div>
          )}
          {!output && run.status !== 'running' && (
            <div
              className="agent-output-content"
              style={{
                color: 'var(--vscode-descriptionForeground)',
                fontStyle: 'italic',
                padding: '8px 0',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>Output captured in the editor panel.</span>
              {onReopen && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onReopen(run.id);
                  }}
                  title="Reopen the summary output in the editor panel"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--vscode-textLink-foreground)',
                    cursor: 'pointer',
                    fontStyle: 'normal',
                    fontSize: '12px',
                    padding: '2px 6px',
                    borderRadius: '4px',
                  }}
                >
                  Reopen output ↗
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

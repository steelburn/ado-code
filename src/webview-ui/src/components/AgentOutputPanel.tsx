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
  // Open the run's progress in the editor area (live for running runs,
  // summary view for finished ones).
  onOpenInEditor?: (runId: string) => void;
}

/** mm:ss (or h:mm:ss past an hour) from a millisecond duration. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function AgentOutputPanel({ run, output, loading, onDismiss, onOpenInEditor }: Props) {
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);

  // Live elapsed timer while the run is in progress (improved progress
  // display — see AgentProgressPanel for the full editor-side view).
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!run || run.status !== 'running') {
      setElapsed(0);
      return;
    }
    const start = new Date(run.startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Date.now() - start));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [run, run?.status, run?.startedAt]);

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
          {run.status === 'running' && (
            <span
              className="agent-output-elapsed"
              style={{ color: 'var(--vscode-descriptionForeground)' }}
              title="Elapsed time"
            >
              {' '}· {formatElapsed(elapsed)}
            </span>
          )}
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
        {onOpenInEditor && (
          <button
            className="agent-output-close"
            onClick={(e) => {
              e.stopPropagation();
              onOpenInEditor(run.id);
            }}
            title={isFinished ? 'Reopen output in editor panel' : 'Open live progress in editor panel'}
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
              {onOpenInEditor && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInEditor(run.id);
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

import React, { useState, useRef, useEffect } from 'react';

interface AgentRun {
  id: string;
  workItemId?: number;
  agent: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}

interface Props {
  run: AgentRun | null;
  output: string;
  loading: boolean;
}

export function AgentOutputPanel({ run, output, loading }: Props) {
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current && expanded) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, expanded]);

  if (!run) return null;

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
      </div>

      {expanded && (
        <div className="agent-output-body">
          {output && (
            <div className="agent-output-content" ref={outputRef}>
              <pre>{output}</pre>
            </div>
          )}
          {run.summary && (
            <div className="agent-output-summary">
              <div className="task-detail-section-title">Summary</div>
              <div className="task-detail-section-content">{run.summary}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

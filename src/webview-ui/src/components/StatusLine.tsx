import React from 'react';
import {
  deriveStatusText,
  countRunningTools,
  statusLineText,
  type StatusTraceEntry,
} from '../../../shared/transientStatus';

interface Props {
  loading: boolean;
  activity?: string | null;
  streamText?: string;
  trace?: StatusTraceEntry[];
}

const hasVisibleThinking = (trace: StatusTraceEntry[]): boolean =>
  trace.some(e => e.kind === 'thinking' && typeof e.text === 'string' && e.text.trim() !== '');

/**
 * The single low-contrast transient status line (chat-declutter item 7).
 *
 * Consolidates the in-thread "Working…" headline and the per-tool running
 * spinners into one quiet line pinned above the input, so the thread keeps only
 * durable content while the live state stays legible in one place. Renders
 * nothing when idle (the line collapses entirely).
 */
export function StatusLine({ loading, activity, streamText, trace = [] }: Props) {
  const runningTools = countRunningTools(trace);
  const text = deriveStatusText({
    loading,
    activity,
    streamText,
    hasVisibleThinking: hasVisibleThinking(trace),
    anyToolRunning: runningTools > 0,
  });
  if (!text) return null;
  return (
    <div className="status-line" role="status" aria-live="polite">
      <span className="status-line-dot" aria-hidden="true" />
      <span className="status-line-text">{statusLineText(text, runningTools)}</span>
    </div>
  );
}

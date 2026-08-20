import React, { useRef, useEffect, useState, useCallback } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Tooltip } from './ui/Tooltip';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

interface Message {
  role: string;
  content: string;
  timestamp?: number; // epoch ms
  isError?: boolean;
}

interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, any>;
  result?: string;
  /** false when the user hid tool calls in chat — rendered as a "…" indicator. */
  showDetails?: boolean;
  /** Completion flag for hidden calls, which never carry result content. */
  done?: boolean;
}

interface Props {
  messages: Message[];
  loading: boolean;
  /** AI thinking/reasoning text (o1/o3 reasoning_content, Claude extended thinking) */
  thinking?: string;
  /** Activity indicator text (e.g., "Executing skill: Code Review") */
  activity?: string | null;
  /** Live tool calls from the agentic loop — shown while the turn runs. */
  liveToolCalls?: ToolCallInfo[];
}

// ── Helpers ──────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Extract tool-call blocks from assistant content.
 * Content may contain fenced JSON like:
 *   ```tool_call
 *   { "id": "...", "name": "...", "arguments": {...}, "result": "..." }
 *   ```
 * Returns { toolCalls, textParts } where textParts are the non-tool segments.
 */
function parseToolCalls(content: string): { toolCalls: ToolCallInfo[]; textParts: string[] } {
  const toolCalls: ToolCallInfo[] = [];
  const textParts: string[] = [];
  const regex = /```tool_call\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // Text before this tool_call block
    if (match.index > lastIndex) {
      textParts.push(content.slice(lastIndex, match.index));
    }
    try {
      const data = JSON.parse(match[1].trim());
      toolCalls.push({
        id: data.id || `tc-${toolCalls.length}`,
        name: data.name || 'unknown',
        arguments: data.arguments || {},
        result: data.result,
      });
    } catch {
      // If JSON parse fails, treat as text
      textParts.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last tool_call
  if (lastIndex < content.length) {
    textParts.push(content.slice(lastIndex));
  }

  return { toolCalls, textParts };
}

/** True when a tool result is the JSON error envelope tools return on failure. */
function isErrorResult(result: string): boolean {
  const trimmed = result.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return !!parsed && typeof parsed === 'object' && !!((parsed as any).error || (parsed as any).errorMessage);
  } catch {
    return false;
  }
}

// ── Sub-components ───────────────────────────────────────────────

const ToolCallBlock: React.FC<{ tc: ToolCallInfo }> = ({ tc }) => {
  // Running cards start expanded (so args are visible while the tool works);
  // completed cards collapse to just the header + status badge. The user can
  // always override either way.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? !tc.result;

  // Status: running → spinner badge; done → success; JSON error result → error
  const statusBadge = !tc.result ? (
    <span className="tool-status tool-status-running">
      <span className="tool-status-spinner" />
      running…
    </span>
  ) : (
    <Badge variant={isErrorResult(tc.result) ? 'error' : 'success'}>
      {isErrorResult(tc.result) ? 'error' : 'completed'}
    </Badge>
  );

  return (
    <div
      className="tool-block"
      style={{
        margin: '6px 0',
        border: '1px solid var(--vscode-panel-border)',
        borderRadius: 6,
        overflow: 'hidden',
        fontSize: '0.85em',
      }}
    >
      {/* Header — always visible, clickable */}
      <button
        onClick={() => setUserExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '6px 10px',
          background: 'var(--vscode-sideBar-background)',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--vscode-font-family)',
          color: 'var(--vscode-foreground)',
        }}
      >
        <span style={{ fontSize: '0.8em', transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}>
          ▶
        </span>
        <span style={{ fontWeight: 600 }}>🔧 {tc.name}</span>
        {statusBadge}
      </button>

      {/* Collapsible details */}
      {expanded && (
        <div style={{ padding: '8px 10px', borderTop: '1px solid var(--vscode-panel-border)' }}>
          {Object.keys(tc.arguments).length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 2, color: 'var(--vscode-descriptionForeground)', fontSize: '0.8em' }}>
                ARGUMENTS
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: '6px 8px',
                  background: 'var(--vscode-textCodeBlock-background)',
                  borderRadius: 4,
                  overflow: 'auto',
                  fontFamily: 'var(--vscode-editor-font-family)',
                  fontSize: '0.9em',
                }}
              >
                {JSON.stringify(tc.arguments, null, 2)}
              </pre>
            </div>
          )}
          {tc.result && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2, color: 'var(--vscode-descriptionForeground)', fontSize: '0.8em' }}>
                RESULT
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: '6px 8px',
                  background: 'var(--vscode-textCodeBlock-background)',
                  borderRadius: 4,
                  overflow: 'auto',
                  maxHeight: 200,
                  fontFamily: 'var(--vscode-editor-font-family)',
                  fontSize: '0.9em',
                }}
              >
                {tc.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Wraps MarkdownRenderer to add a copy button on <pre> code blocks.
 * Uses a container ref to intercept rendered DOM after markdown injection.
 */
const MarkdownWithCodeCopy: React.FC<{ content: string }> = ({ content }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // After render, attach copy buttons to code blocks
  useEffect(() => {
    if (!containerRef.current) return;
    const pres = containerRef.current.querySelectorAll('pre');
    pres.forEach((pre) => {
      // Skip if already has a copy button
      if (pre.parentElement?.classList.contains('code-block-wrapper')) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';
      wrapper.style.position = 'relative';

      // Language label from class: <pre><code class="language-xxx">
      const codeEl = pre.querySelector('code');
      let lang = '';
      if (codeEl) {
        const cls = codeEl.className;
        const m = cls.match(/language-(\w+)/);
        if (m) lang = m[1];
      }

      // Create language label
      if (lang) {
        const label = document.createElement('span');
        label.className = 'code-lang-label';
        label.textContent = lang;
        label.style.cssText = `
          position: absolute;
          top: 4px;
          left: 8px;
          font-size: 0.7em;
          color: var(--vscode-descriptionForeground);
          background: var(--vscode-editor-background);
          padding: 1px 6px;
          border-radius: 3px;
          pointer-events: none;
          z-index: 1;
        `;
        wrapper.appendChild(label);
      }

      // Create copy button
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = '📋';
      btn.title = 'Copy to clipboard';
      btn.style.cssText = `
        position: absolute;
        top: 4px;
        right: 4px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        padding: 2px 6px;
        cursor: pointer;
        font-size: 0.8em;
        opacity: 0;
        transition: opacity 0.15s;
        z-index: 1;
      `;
      btn.addEventListener('click', async () => {
        const text = codeEl?.textContent || pre.textContent || '';
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '📋'; }, 1500);
        } catch {
          btn.textContent = '✗';
          setTimeout(() => { btn.textContent = '📋'; }, 1500);
        }
      });

      // Show button on hover
      wrapper.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
      wrapper.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });

      pre.parentNode?.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      wrapper.appendChild(btn);
    });
  }, [content]);

  return (
    <div ref={containerRef}>
      <MarkdownRenderer content={content} />
    </div>
  );
};

/**
 * Compact disclosure for tool calls the user asked to keep out of chat
 * (chat.showToolCalls=false). The host never forwards arguments or result
 * payloads in this mode — this card only lists which tools ran and their
 * status, revealed on an explicit click. Nothing here is persisted to chat
 * history (hidden calls are excluded from the final message merge).
 */
const HiddenToolCalls: React.FC<{ calls: ToolCallInfo[] }> = ({ calls }) => {
  const [expanded, setExpanded] = useState(false);
  const doneCount = calls.filter(c => c.done || !!c.result).length;

  return (
    <div className={expanded ? 'tool-hidden-group expanded' : 'tool-hidden-group'} style={{ marginTop: 4 }}>
      <button
        className="activity-indicator tool-hidden-toggle"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? 'Hide tool activity' : 'Reveal the tools the agent is running'}
      >
        <span
          className="tool-hidden-chevron"
          style={{ transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'none' }}
        >
          ▶
        </span>
        <div className="activity-spinner" />
        <span className="activity-text">Working…</span>
        <span className="tool-hidden-count">
          {doneCount}/{calls.length} tools
        </span>
      </button>

      {expanded && (
        <div className="tool-hidden-list">
          {calls.map(tc => {
            const err = !!tc.result && isErrorResult(tc.result);
            const done = tc.done || !!tc.result;
            return (
              <div key={tc.id} className="tool-hidden-row">
                <span className="tool-hidden-row-icon">🔧</span>
                <span className="tool-hidden-row-name">{tc.name || 'unknown tool'}</span>
                {done ? (
                  <span className={`tool-hidden-row-status ${err ? 'tool-hidden-row-error' : 'tool-hidden-row-done'}`}>
                    {err ? 'error' : 'completed'}
                  </span>
                ) : (
                  <span className="tool-hidden-row-status tool-hidden-row-running">
                    <span className="tool-status-spinner" />
                    running…
                  </span>
                )}
              </div>
            );
          })}
          <div className="tool-hidden-note">
            Arguments and results stay hidden (chat.showToolCalls=false) — nothing here is saved to chat history.
          </div>
        </div>
      )}
    </div>
  );
};

// ── Main Component ───────────────────────────────────────────────

export function MessageList({ messages, loading, thinking, activity, liveToolCalls = [] }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(messages.length);

  // Auto-scroll on new messages — instant for bulk loads (refresh/session switch),
  // smooth for single new messages (streaming).
  useEffect(() => {
    const countDelta = messages.length - prevCountRef.current;
    prevCountRef.current = messages.length;
    // Bulk load (refresh, session switch) → instant scroll, no animation
    // Single message → smooth scroll
    const behavior = countDelta > 1 ? 'instant' : 'smooth';
    bottomRef.current?.scrollIntoView({ behavior });
  }, [messages, loading, thinking, activity, liveToolCalls]);

  if (messages.length === 0 && !loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">💬</div>
        <h3>Start a conversation</h3>
        <p>Ask about your work items, request code changes, or delegate to an agent.</p>
        <div className="empty-state-hints">
          <div className="empty-state-hint">
            <code>/status Active</code> — change work item state (Active, Done, Closed…)
          </div>
          <div className="empty-state-hint">
            <code>/comment Please clarify the requirements</code> — post a comment to the WI thread
          </div>
          <div className="empty-state-hint">
            <code>/assign john@company.com</code> — assign the active work item
          </div>
          <div className="empty-state-hint">
            <code>/delegate claude Fix the failing tests</code> — hand off to an external agent
          </div>
          <div className="empty-state-hint">
            <code>/help</code> — list all commands with usage
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="messages-area">
      {messages.map((m, i) => {
        const isAssistant = m.role === 'assistant';
        const isUser = m.role === 'user';
        const isError = m.isError;

        // Parse tool calls from assistant messages
        const { toolCalls, textParts } = isAssistant ? parseToolCalls(m.content) : { toolCalls: [], textParts: [m.content] };
        const hasText = textParts.some((t) => t.trim().length > 0);

        // Timestamp display
        const timestampEl = m.timestamp ? (
          <Tooltip content={new Date(m.timestamp).toLocaleString()} side="top">
            <span className="message-time" style={{ cursor: 'default' }}>
              {relativeTime(m.timestamp)}
            </span>
          </Tooltip>
        ) : null;

        // Error message styling
        const errorBorder = isError
          ? { borderLeft: '3px solid var(--vscode-inputValidation-errorBorder)', background: 'var(--vscode-inputValidation-errorBackground)' }
          : {};

        return (
          <div
            key={i}
            className={`message message-${m.role}`}
            style={errorBorder}
          >
            <div className={`message-avatar message-avatar-${m.role}`}>
              {isError ? '⚠' : isUser ? 'You' : 'AI'}
            </div>
            <div className="message-body">
              <div className="message-header">
                <span className="message-author">
                  {isUser ? 'You' : 'ADO Code'}
                </span>
                {timestampEl}
                {isError && (
                  <span style={{ marginLeft: 4 }}><Badge variant="error">error</Badge></span>
                )}
              </div>
              <div className="message-content">
                {isUser ? (
                  <p>{m.content}</p>
                ) : (
                  <>
                    {/* Render text parts with markdown */}
                    {hasText && textParts.filter((t) => t.trim()).map((text, j) => (
                      <MarkdownWithCodeCopy key={j} content={text} />
                    ))}

                    {/* Render tool call blocks */}
                    {toolCalls.map((tc) => (
                      <ToolCallBlock key={tc.id} tc={tc} />
                    ))}

                    {/* Fallback: if no text and no tool calls, render raw */}
                    {!hasText && toolCalls.length === 0 && (
                      <MarkdownWithCodeCopy content={m.content} />
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {loading && (
        <div className="message message-assistant">
          <div className="message-avatar message-avatar-assistant">AI</div>
          <div className="message-body">
            <div className="message-header">
              <span className="message-author">ADO Code</span>
            </div>
            <div className="message-content">
              {/* Headline: what the AI is doing right now */}
              <div className="activity-indicator">
                <div className="activity-spinner" />
                <span className="activity-text">{activity ? `${activity}…` : 'Thinking…'}</span>
              </div>

              {/* Live tool calls — running → completed as results land.
                  Detail cards render full arguments/results; hidden calls
                  (chat.showToolCalls=false) collapse into a clickable
                  "Working…" disclosure that lists the tool names on demand
                  (no payload ever leaves the host). */}
              {liveToolCalls.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {liveToolCalls
                    .filter(tc => tc.showDetails !== false)
                    .map(tc => (
                      <ToolCallBlock key={tc.id} tc={tc} />
                    ))}
                  {liveToolCalls.some(tc => tc.showDetails === false) && (
                    <HiddenToolCalls calls={liveToolCalls.filter(tc => tc.showDetails === false)} />
                  )}
                </div>
              )}

              {/* Thinking/reasoning text */}
              {!!thinking && thinking.trim().length > 0 && (
                <div className="thinking-block">
                  <div className="thinking-header">
                    <span className="thinking-icon">💭</span>
                    <span className="thinking-label">Thinking</span>
                  </div>
                  <div className="thinking-content">{thinking}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

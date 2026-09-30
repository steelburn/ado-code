import React, { useRef, useEffect, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Tooltip } from './ui/Tooltip';
import { Badge } from './ui/Badge';
import { processMermaidInContainer } from '../utils/mermaid';
import type { ToolCallInfo, TraceEntry } from '../types';

export type { ToolCallInfo, TraceEntry };

interface Message {
  role: string;
  content: string;
  timestamp?: number; // epoch ms
  isError?: boolean;
  /** Stable bubble id (host run card) — updates REPLACE this bubble. */
  id?: string;
  /** Ordered record of a completed agentic turn: thinking blocks interleaved
   *  with the tool calls that followed them (chronological). Rendered in flow
   *  and left VISIBLE — the turn's work is never collapsed away on completion.
   *  0.6.7: persisted into session history, so a reopened session shows the
   *  same record (thinking collapsed — see ThinkingBlock's defaultOpen). An
   *  array of arrays means the condenser split this turn across several
   *  assistant messages; the segments are still one chronological record. */
  trace?: TraceInput;
  /** True when the persisted record was trimmed to its storage budget (only
   *  ever set for a restored turn — a live turn is shown in full). */
  traceTruncated?: boolean;
}

/** One segment of a turn's ordered record. `thinking` blocks sit between the
 *  tool calls they introduced — not lumped above them. */
export type TraceInput = TraceEntry[] | TraceEntry[][];

/** Live variant — carries a stable key so blocks update in place while the
 *  turn streams (thinking text grows, tool cards flip running → completed). */
export type LiveTraceEntry = TraceEntry & { key: string };

interface Props {
  messages: Message[];
  loading: boolean;
  /** Ordered segments of the CURRENT live turn (thinking blocks + tool cards
   *  in the order they were produced). */
  liveTrace?: LiveTraceEntry[];
  /** Answer text streamed by the current turn — rendered in-flow UNDER the
   *  reasoning + tool cards so the reasoning flows up and scrolls away as the
   *  reply grows (instead of a fixed box pinned at the bottom). */
  streamText?: string;
  /** Activity indicator text (e.g., "Executing skill: Code Review") */
  activity?: string | null;
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
 * Flatten a message's trace into one chronological record. Restored sessions
 * hand back an array per assistant message (the condenser can split a single
 * turn across several), so nested arrays concatenate in order.
 */
function flattenTrace(trace: TraceInput | undefined): TraceEntry[] {
  if (!trace || trace.length === 0) return [];
  return Array.isArray(trace[0])
    ? (trace as TraceEntry[][]).flat()
    : (trace as TraceEntry[]);
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

const SUMMARY_ARG_KEYS = [
  'path', 'paths', 'file', 'file_path', 'pattern', 'query', 'command', 'commands',
  'id', 'ids', 'url', 'name', 'title', 'agent', 'server', 'tool',
];
const SUMMARY_CAP = 72;

/**
 * One-line gist of what a tool call actually did, so a collapsed card is
 * informative ("read_file · src/llm/agentic.ts") instead of just a tool name.
 * Prefers the argument keys that carry the tool's subject; falls back to the
 * first scalar argument so unknown / MCP tools still say something.
 */
function summarizeToolArgs(name: string, args: Record<string, any> | undefined): string {
  if (!args || typeof args !== 'object') return '';
  // The tool name is a useful hint (read_file ⇒ path / edit_file ⇒ path), but
  // the key list is ordered by likelihood across all tools, so a generic scan
  // is both simpler and good enough.
  for (const key of SUMMARY_ARG_KEYS) {
    const value = args[key];
    const text = Array.isArray(value)
      ? value.filter(v => typeof v === 'string').join(', ')
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    if (!text) continue;
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (!oneLine) continue;
    return oneLine.length > SUMMARY_CAP ? `${oneLine.slice(0, SUMMARY_CAP)}…` : oneLine;
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) {
      const oneLine = value.replace(/\s+/g, ' ').trim();
      return oneLine.length > SUMMARY_CAP ? `${oneLine.slice(0, SUMMARY_CAP)}…` : oneLine;
    }
  }
  return name.startsWith('mcp__') ? name.split('__').slice(1).join(' › ') : '';
}

/**
 * Remove ```choice fences (main-model choice offers — surfaced as the
 * clickable option card, never as raw JSON in the bubble). The host strips
 * the fence from agentic turns before posting; this covers the plain
 * streaming path and any restored messages that still carry one.
 */
function stripChoiceFences(content: string): string {
  const stripped = content.replace(/```choice[\s\S]*?(?:```|$)/g, '');
  return stripped === content ? content : stripped.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Sub-components ───────────────────────────────────────────────

const ToolCallBlock: React.FC<{ tc: ToolCallInfo; defaultOpen?: boolean }> = ({ tc, defaultOpen = false }) => {
  // Live cards start expanded while the tool runs; completed cards collapse to
  // just the header + status badge. Finished turn records pass defaultOpen so
  // the tool's work stays visible after the loop ends. The user can always
  // override either way.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  // Completion is derived from `done` FIRST, then from result presence: in the
  // hidden mode (chat.showToolCalls=false) a call is done with no result at
  // all, and a tool whose result is the empty string was still a success —
  // treating "" as "not finished" pinned a "running…" spinner on a finished
  // card forever.
  const done = !!tc.done || tc.result !== undefined;
  const errored = !!tc.result && isErrorResult(tc.result);
  const expanded = userExpanded ?? (defaultOpen || !done);

  const summary = summarizeToolArgs(tc.name, tc.arguments);

  const statusBadge = !done ? (
    <span className="tool-status tool-status-running">
      <span className="tool-status-spinner" />
      running…
    </span>
  ) : (
    <Badge variant={errored ? 'error' : 'success'}>
      {errored ? 'error' : 'completed'}
    </Badge>
  );

  return (
    <div className={`tool-block${done ? '' : ' tool-block-running'}`}>
      {/* Header — always visible, clickable */}
      <button
        className="tool-block-header"
        onClick={() => setUserExpanded(!expanded)}
        aria-expanded={expanded}
        title={`${tc.name}${summary ? ` — ${summary}` : ''}`}
      >
        <span
          className="tool-block-chevron"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}
        >
          ▶
        </span>
        <span className="tool-block-name">{tc.name}</span>
        {summary && <span className="tool-block-summary">{summary}</span>}
        {statusBadge}
      </button>

      {/* Collapsible details */}
      {expanded && (
        <div className="tool-block-details">
          {Object.keys(tc.arguments).length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div className="tool-block-section-label">ARGUMENTS</div>
              <pre className="tool-block-pre arguments">
                {JSON.stringify(tc.arguments, null, 2)}
              </pre>
            </div>
          )}
          {tc.result !== undefined && (
            <div>
              <div className="tool-block-section-label">RESULT</div>
              <pre className="tool-block-pre result">{tc.result}</pre>
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
    processMermaidInContainer(containerRef.current);
    const pres = containerRef.current.querySelectorAll('pre');
    pres.forEach((pre) => {
      // Skip if already in a mermaid container or already has a copy button
      if (pre.closest('.mermaid-container') || pre.parentElement?.classList.contains('code-block-wrapper')) return;

      // Language label from class: <pre><code class="language-xxx">
      const codeEl = pre.querySelector('code');
      let lang = '';
      if (codeEl) {
        const cls = codeEl.className;
        const m = cls.match(/language-(\w+)/);
        if (m) lang = m[1];
      }

      // Skip mermaid blocks
      if (lang.toLowerCase() === 'mermaid' || codeEl?.className.includes('mermaid')) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';
      wrapper.style.position = 'relative';

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

/**
 * Thinking/reasoning block with a collapse toggle.
 * `defaultOpen` is true in the live bubble and the just-finished turn record —
 * reasoning is never hidden while it is being produced — and false for a trace
 * restored from session history, where the reasoning is historical context the
 * user explicitly opted into keeping (click to reveal). The user may override
 * either way.
 */
const ThinkingBlock: React.FC<{ text: string; defaultOpen?: boolean }> = ({ text, defaultOpen = true }) => {
  const [open, setOpen] = useState(defaultOpen);
  // A block that was collapsed by default must SAY it holds reasoning — after
  // a reload an unlabeled collapsed box would read as an empty artifact.
  const preview = !open && text.trim() ? text.trim().replace(/\s+/g, ' ').slice(0, 96) : '';
  return (
    <div className={`thinking-block${defaultOpen ? ' thinking-block-live' : ' thinking-block-restored'}`}>
      <button
        className="thinking-header thinking-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? 'Hide reasoning' : 'Show the reasoning behind this step'}
      >
        <span className="thinking-chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
        <span className="thinking-icon">💭</span>
        <span className="thinking-label">Thinking</span>
        {preview && <span className="thinking-preview">{preview}</span>}
      </button>
      {open && <div className="thinking-content">{text}</div>}
    </div>
  );
};

// ── Main Component ───────────────────────────────────────────────

export function MessageList({ messages, loading, liveTrace = [], streamText, activity }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(messages.length);
  // Headline state: reasoning already on screen + whether any card is still
  // running (drives "Reasoning…" / "Working…" instead of a duplicate label).
  const hasVisibleThinking = liveTrace.some(e => e.kind === 'thinking' && !!e.text.trim());
  const anyToolRunning = liveTrace.some(
    e => e.kind === 'tool' && e.call.showDetails !== false && !(e.call.done || e.call.result !== undefined)
  );
  // Signature of everything the chat area displays. Id-bubble replacements
  // that touch a MID-thread message (e.g. the run card while the user scrolls
  // older content) don't change it, so they never yank the scroll position.
  const prevSigRef = useRef('');

  // Auto-scroll on new messages — instant for bulk loads (refresh/session switch),
  // smooth for single new messages (streaming).
  useEffect(() => {
    const last = messages[messages.length - 1];
    const tailKey = last ? `${last.id ?? ''}|${last.role}|${last.content.length}` : '';
    const liveSig = [
      liveTrace.length,
      liveTrace.reduce((n, e) => n + (e.kind === 'thinking' ? (e.text || '').length : 0), 0),
      liveTrace.filter(e => e.kind === 'tool' && !!(e.call.result || e.call.done)).length,
    ].join('|');
    const sig = [
      messages.length,
      tailKey,
      loading,
      streamText?.length ?? 0,
      liveSig,
      activity ?? '',
    ].join('|');
    if (sig === prevSigRef.current) return;
    prevSigRef.current = sig;

    const countDelta = messages.length - prevCountRef.current;
    prevCountRef.current = messages.length;
    // Bulk load (refresh, session switch) → instant scroll, no animation
    // Single message → smooth scroll
    const behavior = countDelta > 1 ? 'instant' : 'smooth';
    bottomRef.current?.scrollIntoView({ behavior });
  }, [messages, loading, liveTrace, streamText, activity]);

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

        // Choice fences never render as raw JSON in the bubble (the host
        // surfaces them as the clickable option card instead).
        const displayContent = isAssistant ? stripChoiceFences(m.content) : m.content;

        // Parse tool calls from assistant messages
        const { toolCalls, textParts } = isAssistant ? parseToolCalls(displayContent) : { toolCalls: [], textParts: [displayContent] };
        const hasText = textParts.some((t) => t.trim().length > 0);

        // Persisted record for this turn (one entry per assistant message; the
        // condenser can split a single turn across several). The LAST message
        // is the turn the user just watched, so its reasoning stays open —
        // everything earlier is restored history and starts collapsed.
        const traceSegs = isAssistant ? flattenTrace(m.trace) : [];
        const isLiveTurn = isAssistant && i === messages.length - 1;

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
            {/* Author label circles (AI / You) removed: the header row below
                already names the speaker, so the circles only cost width. */}
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
                    {traceSegs.length > 0 ? (
                      <>
                        {/* Ordered record of the agentic turn: each thinking
                            block stays where the model produced it — right
                            before the tool batch it introduced — and nothing is
                            collapsed away when the turn completes. Restored
                            (persisted) reasoning starts CLOSED: it is historical
                            context, and the live view is the one that should
                            make the model's thinking auditable. */}
                        <div className="turn-record">
                          {traceSegs.map((seg, j) =>
                            seg.kind === 'thinking' ? (
                              <ThinkingBlock key={`th-${j}`} text={seg.text} defaultOpen={isLiveTurn} />
                            ) : (
                              <ToolCallBlock key={seg.call.id || `tc-${j}`} tc={seg.call} defaultOpen />
                            )
                          )}
                        </div>
                        {/* Storage cap notice — only a restored record can be
                            trimmed; a live turn is always shown in full. */}
                        {m.traceTruncated && !isLiveTurn && (
                          <div className="turn-record-truncated">
                            Earlier steps of this turn were trimmed when the record was saved.
                          </div>
                        )}
                        {/* Final answer — follows the record chronologically. */}
                        {hasText && textParts.filter((t) => t.trim()).map((text, j) => (
                          <MarkdownWithCodeCopy key={j} content={text} />
                        ))}
                      </>
                    ) : (
                      <>
                        {/* Render text parts with markdown */}
                        {hasText && textParts.filter((t) => t.trim()).map((text, j) => (
                          <MarkdownWithCodeCopy key={j} content={text} />
                        ))}

                        {/* Tool-call fences parsed out of the content. Rendered
                            with the SAME defaults as the turn-trace path above
                            (expanded result, one-line argument summary), so a
                            finished turn looks identical whichever shape
                            produced it. Parsing does not track fence position,
                            so these follow the text — the trace path is the
                            chronological one. */}
                        {toolCalls.map((tc) => (
                          <ToolCallBlock key={tc.id} tc={tc} defaultOpen />
                        ))}

                        {/* Fallback: if no text and no tool calls, render raw */}
                        {!hasText && toolCalls.length === 0 && (
                          <MarkdownWithCodeCopy content={displayContent} />
                        )}
                      </>
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
          <div className="message-body">
            <div className="message-header">
              <span className="message-author">ADO Code</span>
            </div>
            <div className="message-content">
              {/* Headline: what the AI is doing right now. Reasoning already
                  renders below as its own labeled block, so the headline drops
                  the "Thinking…" wording in that case — otherwise every turn
                  repeated the word "Thinking" once per block plus once here.
                  `activity` is reserved for host-driven work a turn doesn't
                  describe on its own (skills, task generation); per-tool
                  progress goes to the status bar, not this headline. */}
              <div className="activity-indicator">
                <div className="activity-spinner" />
                <span className="activity-text">
                  {activity
                    ? `${activity}…`
                    : hasVisibleThinking
                      ? (streamText || anyToolRunning ? 'Working…' : 'Reasoning…')
                      : streamText ? 'Responding…' : 'Thinking…'}
                </span>
              </div>

              {/* Ordered live trace: thinking blocks and tool cards render in
                  the order the loop produced them — each thinking block stays
                  between the tool batches it introduced, and as the answer
                  grows beneath it all, the trace scrolls up naturally. */}
              {liveTrace.length > 0 && (
                <div className="turn-record">
                  {liveTrace.map(seg => {
                    if (seg.kind === 'thinking') {
                      return <ThinkingBlock key={seg.key} text={seg.text} />;
                    }
                    // Hidden calls (chat.showToolCalls=false) never carry
                    // payloads — grouped into the "Working…" disclosure below.
                    if (seg.call.showDetails === false) return null;
                    // Live cards stay compact while running (the header carries
                    // the running badge); the expanding one is the card the user
                    // clicks. Clicking expands either state, so this is purely
                    // about how much a busy turn dumps into the thread.
                    return <ToolCallBlock key={seg.key} tc={seg.call} />;
                  })}
                  {liveTrace.some(seg => seg.kind === 'tool' && seg.call.showDetails === false) && (
                    <HiddenToolCalls
                      calls={liveTrace
                        .filter(seg => seg.kind === 'tool' && seg.call.showDetails === false)
                        .map(seg => (seg as { kind: 'tool'; call: ToolCallInfo }).call)}
                    />
                  )}
                </div>
              )}

              {/* Streamed answer text — flows beneath the reasoning/tool cards
                  while the reply is generated. */}
              {!!streamText && streamText.trim().length > 0 && (
                <div className="stream-answer">
                  <MarkdownWithCodeCopy content={streamText} />
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

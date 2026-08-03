import React, { useRef, useEffect } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Message {
  role: string;
  content: string;
}

interface Props {
  messages: Message[];
  loading: boolean;
}

export function MessageList({ messages, loading }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  if (messages.length === 0 && !loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">💬</div>
        <h3>Start a conversation</h3>
        <p>Ask about your work items, request code changes, or delegate to an agent.</p>
        <div className="empty-state-hints">
          <div className="empty-state-hint">
            <code>/status Done</code> — mark work item complete
          </div>
          <div className="empty-state-hint">
            <code>/comment ...</code> — add a comment to active WI
          </div>
          <div className="empty-state-hint">
            Select a WI from the tree to get context-aware help
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="messages-area">
      {messages.map((m, i) => (
        <div key={i} className={`message message-${m.role}`}>
          <div className={`message-avatar message-avatar-${m.role}`}>
            {m.role === 'user' ? 'You' : 'AI'}
          </div>
          <div className="message-body">
            <div className="message-header">
              <span className="message-author">
                {m.role === 'user' ? 'You' : 'ADO Code'}
              </span>
            </div>
            <div className="message-content">
              {m.role === 'user' ? (
                <p>{m.content}</p>
              ) : (
                <MarkdownRenderer content={m.content} />
              )}
            </div>
          </div>
        </div>
      ))}
      {loading && (
        <div className="message message-assistant">
          <div className="message-avatar message-avatar-assistant">AI</div>
          <div className="message-body">
            <div className="message-header">
              <span className="message-author">ADO Code</span>
            </div>
            <div className="loading-indicator">
              <div className="loading-dots">
                <span /><span /><span />
              </div>
              Thinking…
            </div>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

import React, { useState, useRef, useEffect } from 'react';

interface Props {
  mode: string;
  onSend: (content: string) => void;
  onClear: () => void;
  onModeChange: () => void;
  loading: string; // 'inline' | 'plan' | 'act'
}

export function InputBar({ mode, onSend, onClear, onModeChange, loading }: Props) {
  const [input, setInput] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
  }, [input]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    onSend(trimmed);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = () => {
    setShowConfirm(true);
  };

  const confirmClear = () => {
    setShowConfirm(false);
    onClear();
  };

  const canSend = input.trim().length > 0 && !loading;

  return (
    <>
      <div className="input-section">
        {/* Textarea container */}
        <div className={`input-container ${isFocused ? 'input-focused' : ''}`}>
          <textarea
            ref={textareaRef}
            className="input-field"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Message ADO Code…"
            rows={1}
          />
          {/* Floating send button */}
          <button
            className={`send-btn ${canSend ? 'send-active' : ''}`}
            onClick={handleSend}
            disabled={!canSend}
            title="Send message (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11ZM6.636 10.07l2.761 4.338L14.13 2.576 6.636 10.07Zm6.787-8.239L1.591 6.602l4.339 2.76 7.494-7.493Z"/>
            </svg>
          </button>
        </div>

        {/* Toolbar row */}
        <div className="input-toolbar">
          <div className="toolbar-left">
            <button className="toolbar-btn" title="Add context (@)">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
              </svg>
            </button>
            <button className="toolbar-btn" title="Attach files">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
              </svg>
            </button>
            <button className="toolbar-btn" title="Clear chat" onClick={handleClear}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H5.5l1-1h3l1 1h2.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
              </svg>
            </button>
          </div>
          <div className="toolbar-right">
            <span className="mode-toggle" onClick={onModeChange} title="Click to change mode">
              <span className={`mode-option ${mode === 'inline' ? 'mode-active' : ''}`}>Chat</span>
              <span className={`mode-option ${mode === 'plan' ? 'mode-active' : ''}`}>Plan</span>
              <span className={`mode-option ${mode === 'act' ? 'mode-active' : ''}`}>Act</span>
            </span>
          </div>
        </div>
      </div>

      {showConfirm && (
        <div className="confirm-overlay" onClick={() => setShowConfirm(false)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <p>Clear all chat history?</p>
            <div className="confirm-dialog-actions">
              <button className="btn btn-secondary" onClick={() => setShowConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={confirmClear}>
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

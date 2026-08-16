import React, { useState, useRef, useEffect } from 'react';

interface Session {
  id: string;
  name: string;
  createdAt: string;
  messages: Array<{ role: string; content: string }>;
}

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSwitch: (sessionId: string) => void;
  onNew: () => void;
  onRename: (sessionId: string, name: string) => void;
  onDelete: (sessionId: string) => void;
  onDeleteAll: () => void;
}

export function SessionHistory({
  sessions,
  activeId,
  onSwitch,
  onNew,
  onRename,
  onDelete,
  onDeleteAll,
}: Props) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setRenamingId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const activeSession = sessions.find(s => s.id === activeId);
  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString();
  };

  const handleDoubleClick = (session: Session) => {
    setRenamingId(session.id);
    setRenameValue(session.name);
  };

  const handleRenameSubmit = (sessionId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== sessions.find(s => s.id === sessionId)?.name) {
      onRename(sessionId, trimmed);
    }
    setRenamingId(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === 'Enter') {
      handleRenameSubmit(sessionId);
    } else if (e.key === 'Escape') {
      setRenamingId(null);
    }
  };

  return (
    <div className="session-history" ref={ref}>
      <button
        className="session-history-trigger"
        onClick={() => setOpen(!open)}
        title="Session history"
      >
        <span className="session-history-icon">🕐</span>
        <span className="session-history-label">
          {activeSession?.name || 'Session'}
        </span>
        <span className="session-history-chevron">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="session-history-dropdown">
          <button
            className="session-history-new"
            onClick={() => {
              onNew();
              setOpen(false);
            }}
          >
            + New Session
          </button>

          <div className="session-history-separator" />

          {sortedSessions.length === 0 ? (
            <div className="session-history-empty">No sessions yet</div>
          ) : (
            sortedSessions.map(session => (
              <div
                key={session.id}
                className={`session-history-item${session.id === activeId ? ' active' : ''}`}
              >
                <button
                  className="session-history-item-btn"
                  onClick={() => {
                    onSwitch(session.id);
                    setOpen(false);
                  }}
                  onDoubleClick={() => handleDoubleClick(session)}
                >
                  {renamingId === session.id ? (
                    <input
                      ref={renameInputRef}
                      className="session-history-rename-input"
                      type="text"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => handleRenameSubmit(session.id)}
                      onKeyDown={e => handleRenameKeyDown(e, session.id)}
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span className="session-history-item-name">
                        {session.name}
                      </span>
                      <span className="session-history-item-meta">
                        {session.messages.length} msgs · {formatDate(session.createdAt)}
                      </span>
                    </>
                  )}
                </button>

                <button
                  className="session-history-delete"
                  onClick={e => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                  title="Delete session"
                >
                  ×
                </button>
              </div>
            ))
          )}

          {sortedSessions.length > 0 && (
            <>
              <div className="session-history-separator" />
              <button
                className="session-history-delete-all"
                onClick={() => {
                  onDeleteAll();
                  setOpen(false);
                }}
              >
                🗑️ Delete All Sessions
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

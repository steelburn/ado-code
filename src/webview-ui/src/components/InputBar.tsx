import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Button } from './ui/Button';
import { cn } from './ui/cn';
import { vscode } from '../vscode';

// ── Slash command definitions (mirrors src/shared/slashCommands.ts) ──
interface SlashCommand {
  name: string;
  description: string;
  usage: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'status',    description: 'Set work item state (e.g. Active, Done, Closed)',  usage: '/status <state>' },
  { name: 'comment',   description: 'Post a comment to the active work item',           usage: '/comment <text>' },
  { name: 'pick',      description: 'Select a work item to set as active context',      usage: '/pick' },
  { name: 'assign',    description: 'Assign work item to a team member (name/email)',   usage: '/assign <person>' },
  { name: 'clear',     description: 'Clear all chat messages',                          usage: '/clear' },
  { name: 'mode',      description: 'Switch mode: inline, plan, act, or yolo',          usage: '/mode [mode]' },
  { name: 'undo',      description: 'Revert last state change on active work item',     usage: '/undo' },
  { name: 'help',      description: 'List all available slash commands',                 usage: '/help' },
  { name: 'delegate',  description: 'Hand off task to agent (claude, codex, hermes…)',  usage: '/delegate [agent] <prompt>' },
  { name: 'resume',    description: 'Switch to a previous chat session',                 usage: '/resume' },
  { name: 'remember',  description: 'Store a preference the AI remembers across chats',  usage: '/remember <text>' },
  { name: 'forget',    description: 'Remove all saved notes and preferences',            usage: '/forget' },
  { name: 'generate-tasks', description: 'Generate child tasks for the active user story', usage: '/generate-tasks' },
];

function matchSlashCommands(query: string): SlashCommand[] {
  return SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(query.toLowerCase()));
}

interface Props {
  mode: string;
  value: string;
  onValueChange: (value: string) => void;
  onSend: (content: string, images?: ImageAttachment[]) => void;
  onStop: () => void;
  onClear: () => void;
  onModeSelect: (mode: 'inline' | 'plan' | 'act' | 'yolo') => void;
  onAddContext: () => void;
  onAttachFiles: () => void;
  loading: string; // 'inline' | 'plan' | 'act' | 'yolo' | ''
  /** Active model can accept image input — gates the image button + paste. */
  canAttachImages?: boolean;
}

interface ImageAttachment {
  id: string;
  dataUrl: string;
  name: string;
}

interface FileSuggestion {
  path: string;
  name: string;
}

export function InputBar({ mode, value, onValueChange, onSend, onStop, onClear, onModeSelect, onAddContext, onAttachFiles, loading, canAttachImages = true }: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isFocused, setIsFocused] = useState(false);

  // ── @ mention state ──
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionSuggestions, setMentionSuggestions] = useState<FileSuggestion[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);

  // ── / slash command state ──
  const [slashQuery, setSlashQuery] = useState('');
  const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([]);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [showSlashDropdown, setShowSlashDropdown] = useState(false);
  const [slashStartPos, setSlashStartPos] = useState(0);
  const slashDropdownRef = useRef<HTMLDivElement>(null);

  // ── Image attachments ──
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Message history ──
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // ── File search for @ mentions (wired to extension host via postMessage) ──
  const searchFiles = useCallback((_query: string): FileSuggestion[] => {
    // Send search request to extension host; results arrive via fileSearchResults message
    vscode.postMessage({ type: 'searchFiles', query: _query });
    return [];
  }, []);

  // Listen for file search results from extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'fileSearchResults') {
        setMentionSuggestions(msg.results);
        setShowMentionDropdown(msg.results.length > 0);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
  }, [value]);

  // ── @ mention detection ──
  const detectMention = useCallback((text: string, cursorPos: number) => {
    // Look backwards from cursor to find @ that starts a mention
    const beforeCursor = text.substring(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf('@');

    if (atIndex === -1) {
      setShowMentionDropdown(false);
      return;
    }

    // Ensure @ is at start of line or preceded by a space
    if (atIndex > 0 && beforeCursor[atIndex - 1] !== ' ' && beforeCursor[atIndex - 1] !== '\n') {
      setShowMentionDropdown(false);
      return;
    }

    const query = beforeCursor.substring(atIndex + 1);
    // No spaces allowed in the query part
    if (query.includes(' ')) {
      setShowMentionDropdown(false);
      return;
    }

    setMentionQuery(query);
    setMentionStartPos(atIndex);
    const suggestions = searchFiles(query);
    setMentionSuggestions(suggestions);
    setMentionActiveIndex(0);
    setShowMentionDropdown(suggestions.length > 0);
  }, [searchFiles]);

  // Close mention dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (mentionDropdownRef.current && !mentionDropdownRef.current.contains(e.target as Node)) {
        setShowMentionDropdown(false);
      }
    };
    if (showMentionDropdown) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showMentionDropdown]);

  const insertMention = useCallback((suggestion: FileSuggestion) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const before = value.substring(0, mentionStartPos);
    const after = value.substring(cursorPos);
    const newValue = `${before}@${suggestion.path} ${after}`;

    onValueChange(newValue);
    setShowMentionDropdown(false);

    // Restore cursor position after the inserted mention
    setTimeout(() => {
      const newPos = mentionStartPos + suggestion.path.length + 2; // @path + space
      textarea.selectionStart = newPos;
      textarea.selectionEnd = newPos;
      textarea.focus();
    }, 0);
  }, [value, mentionStartPos, onValueChange]);

  // ── / slash command detection ──
  const detectSlashCommand = useCallback((text: string, cursorPos: number) => {
    const beforeCursor = text.substring(0, cursorPos);
    const slashIndex = beforeCursor.lastIndexOf('/');
    if (slashIndex === -1) { setShowSlashDropdown(false); return; }
    if (slashIndex > 0 && beforeCursor[slashIndex - 1] !== ' ' && beforeCursor[slashIndex - 1] !== '\n') {
      setShowSlashDropdown(false); return;
    }
    const query = beforeCursor.substring(slashIndex + 1);
    if (query.includes(' ')) { setShowSlashDropdown(false); return; }
    setSlashQuery(query);
    setSlashStartPos(slashIndex);
    const matches = matchSlashCommands(query);
    setSlashMatches(matches);
    setSlashActiveIndex(0);
    setShowSlashDropdown(matches.length > 0);
  }, []);

  // Close slash dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (slashDropdownRef.current && !slashDropdownRef.current.contains(e.target as Node)) {
        setShowSlashDropdown(false);
      }
    };
    if (showSlashDropdown) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showSlashDropdown]);

  const insertSlashCommand = useCallback((cmd: SlashCommand) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    const before = value.substring(0, slashStartPos);
    const after = value.substring(cursorPos);
    const newValue = `${before}/${cmd.name} ${after}`;
    onValueChange(newValue);
    setShowSlashDropdown(false);
    setTimeout(() => {
      const newPos = slashStartPos + cmd.name.length + 2;
      textarea.selectionStart = newPos;
      textarea.selectionEnd = newPos;
      textarea.focus();
    }, 0);
  }, [value, slashStartPos, onValueChange]);

  // ── Image paste support ──
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    // Active model has no vision capability → ignore pasted images entirely.
    if (!canAttachImages) return;

    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));

    if (imageItems.length === 0) return;

    e.preventDefault();

    imageItems.forEach(item => {
      const blob = item.getAsFile();
      if (!blob) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const name = item.getAsFile()?.name || `pasted-image-${id}.png`;
        setImages(prev => [...prev, { id, dataUrl, name }]);
      };
      reader.readAsDataURL(blob);
    });
  }, [canAttachImages]);

  const removeImage = useCallback((id: string) => {
    setImages(prev => prev.filter(img => img.id !== id));
  }, []);

  // ── Send logic ──
  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    if (loading) return;

    onSend(trimmed, images.length > 0 ? images : undefined);

    // Add to history
    if (trimmed) {
      setHistory(prev => {
        const newHistory = [trimmed, ...prev.filter(h => h !== trimmed)];
        return newHistory.slice(0, 50); // Keep last 50 messages
      });
    }

    // Reset
    setImages([]);
    setHistoryIndex(-1);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, images, loading, onSend]);

  // ── Keyboard handling ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Handle mention dropdown navigation
    if (showMentionDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionActiveIndex(prev => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionActiveIndex(prev => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (mentionSuggestions[mentionActiveIndex]) {
          insertMention(mentionSuggestions[mentionActiveIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionDropdown(false);
        return;
      }
    }

    // Handle slash command dropdown navigation
    if (showSlashDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashActiveIndex(prev => (prev + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashActiveIndex(prev => (prev - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (slashMatches[slashActiveIndex]) {
          insertSlashCommand(slashMatches[slashActiveIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashDropdown(false);
        return;
      }
    }

    // Enter to send (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    // History navigation with Up arrow (only when at start of textarea)
    if (e.key === 'ArrowUp' && history.length > 0) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0) {
        e.preventDefault();
        const newIndex = historyIndex + 1;
        if (newIndex < history.length) {
          setHistoryIndex(newIndex);
          onValueChange(history[newIndex]);
        }
        return;
      }
    }

    // History navigation with Down arrow
    if (e.key === 'ArrowDown' && historyIndex >= 0) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === textarea.value.length) {
        e.preventDefault();
        const newIndex = historyIndex - 1;
        if (newIndex >= 0) {
          setHistoryIndex(newIndex);
          onValueChange(history[newIndex]);
        } else {
          setHistoryIndex(-1);
          onValueChange('');
        }
        return;
      }
    }
  }, [showMentionDropdown, mentionSuggestions, mentionActiveIndex, insertMention,
    showSlashDropdown, slashMatches, slashActiveIndex, insertSlashCommand,
    handleSend, history, historyIndex, onValueChange]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    onValueChange(newValue);
    detectMention(newValue, e.target.selectionStart);
    detectSlashCommand(newValue, e.target.selectionStart);
    setHistoryIndex(-1);
  }, [onValueChange, detectMention, detectSlashCommand]);

  const handleClear = () => {
    setShowConfirm(true);
  };

  const confirmClear = () => {
    setShowConfirm(false);
    setImages([]);
    onClear();
  };

  const canSend = (value.trim().length > 0 || images.length > 0) && !loading;
  const isLoading = !!loading;

  return (
    <>
      <div className="input-section">
        {/* Image preview strip */}
        {images.length > 0 && (
          <div style={{
            display: 'flex',
            gap: 6,
            padding: '6px 4px',
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}>
            {images.map(img => (
              <div
                key={img.id}
                style={{
                  position: 'relative',
                  flexShrink: 0,
                  width: 56,
                  height: 56,
                  borderRadius: 4,
                  border: '1px solid var(--vscode-input-border)',
                  overflow: 'hidden',
                }}
              >
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
                <button
                  onClick={() => removeImage(img.id)}
                  style={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'rgba(0,0,0,0.6)',
                    color: '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    lineHeight: 1,
                    padding: 0,
                  }}
                  title={`Remove ${img.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea container with @ mention dropdown */}
        <div
          className={cn('input-container', isFocused && 'input-focused')}
          style={{ position: 'relative' }}
        >
          <textarea
            ref={textareaRef}
            className="input-field"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Message ADO Code…"
            rows={1}
          />

          {/* @ Mention dropdown */}
          {showMentionDropdown && mentionSuggestions.length > 0 && (
            <div
              ref={mentionDropdownRef}
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                marginBottom: 4,
                background: 'var(--vscode-dropdown-background)',
                border: '1px solid var(--vscode-dropdown-border)',
                borderRadius: 4,
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
                maxHeight: 200,
                overflowY: 'auto',
                zIndex: 100,
                animation: 'menuFadeIn 0.1s ease-out',
              }}
            >
              <div style={{
                padding: '4px 8px',
                fontSize: '0.75em',
                color: 'var(--vscode-descriptionForeground)',
                borderBottom: '1px solid var(--vscode-dropdown-border)',
              }}>
                Files
              </div>
              {mentionSuggestions.map((suggestion, index) => (
                <div
                  key={suggestion.path}
                  onClick={() => insertMention(suggestion)}
                  style={{
                    padding: '5px 8px',
                    cursor: 'pointer',
                    fontSize: '0.85em',
                    color: 'var(--vscode-dropdown-foreground)',
                    background: index === mentionActiveIndex
                      ? 'var(--vscode-list-activeSelectionBackground)'
                      : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                  onMouseEnter={() => setMentionActiveIndex(index)}
                >
                  <span style={{
                    color: 'var(--vscode-descriptionForeground)',
                    fontSize: '0.85em',
                    flexShrink: 0,
                  }}>
                    📄
                  </span>
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {suggestion.path}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* / Slash command dropdown */}
          {showSlashDropdown && slashMatches.length > 0 && (
            <div
              ref={slashDropdownRef}
              className="slash-dropdown"
            >
              <div className="slash-dropdown-header">Commands</div>
              {slashMatches.map((cmd, index) => (
                <div
                  key={cmd.name}
                  className={cn('slash-option', index === slashActiveIndex && 'slash-active')}
                  onClick={() => insertSlashCommand(cmd)}
                  onMouseEnter={() => setSlashActiveIndex(index)}
                >
                  <span className="slash-name">/{cmd.name}</span>
                  <span className="slash-desc">{cmd.description}</span>
                  <span className="slash-usage">{cmd.usage}</span>
                </div>
              ))}
            </div>
          )}

          {/* Send / Stop button */}
          {isLoading ? (
            <Button
              onClick={onStop}
              variant="ghost"
              title="Stop generation"
              className="input-bar__stop-btn"
              style={{
                position: 'absolute',
                bottom: 6,
                right: 6,
                width: 28,
                height: 28,
                padding: 0,
                borderRadius: '50%',
                minWidth: 'unset',
                zIndex: 2,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 4h8v8H4z"/>
              </svg>
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={!canSend}
              onClick={handleSend}
              title="Send message (Enter)"
              style={{
                position: 'absolute',
                bottom: 6,
                right: 6,
                width: 28,
                height: 28,
                padding: 0,
                borderRadius: 4,
                minWidth: 'unset',
                zIndex: 2,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11ZM6.636 10.07l2.761 4.338L14.13 2.576 6.636 10.07Zm6.787-8.239L1.591 6.602l4.339 2.76 7.494-7.493Z"/>
              </svg>
            </Button>
          )}
        </div>

        {/* Toolbar row */}
        <div className="input-toolbar">
          <div className="toolbar-left">
            <button
              className="toolbar-btn"
              title="Add context (@)"
              onClick={onAddContext}
              disabled={!!loading}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
              </svg>
            </button>
            <button
              className="toolbar-btn"
              title="Attach files"
              onClick={onAttachFiles}
              disabled={!!loading}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
              </svg>
            </button>
            <button
              className="toolbar-btn"
              title={canAttachImages ? 'Paste image (Ctrl+V)' : 'Image input not supported by the active model'}
              onClick={() => fileInputRef.current?.click()}
              disabled={!!loading || !canAttachImages}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                <path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/>
              </svg>
            </button>
            <button className="toolbar-btn" title="Clear chat" onClick={handleClear}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H5.5l1-1h3l1 1h2.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
              </svg>
            </button>
            {/* Hidden file input for image paste */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                files.forEach(file => {
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = reader.result as string;
                    const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    setImages(prev => [...prev, { id, dataUrl, name: file.name }]);
                  };
                  reader.readAsDataURL(file);
                });
                e.target.value = '';
              }}
            />
          </div>
          <div className="toolbar-right">
            <span className="mode-toggle" title="Click to change mode">
              <span className={`mode-option ${mode === 'inline' ? 'mode-active' : ''}`} onClick={() => onModeSelect('inline')}>Chat</span>
              <span className={`mode-option ${mode === 'plan' ? 'mode-active' : ''}`} onClick={() => onModeSelect('plan')}>Plan</span>
              <span className={`mode-option ${mode === 'act' ? 'mode-active' : ''}`} onClick={() => onModeSelect('act')}>Act</span>
              <span className={`mode-option ${mode === 'yolo' ? 'mode-active' : ''}`} onClick={() => onModeSelect('yolo')}>Yolo</span>
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

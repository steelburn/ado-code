import React, { useState, useCallback, useRef } from 'react';

/** Tag/chip input for array settings */
export function ArrayInput({ value, placeholder, onChange }: { value: string[]; placeholder?: string; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const addItems = useCallback((text: string) => {
    const parts = text.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const merged = [...value];
    for (const p of parts) {
      if (!merged.includes(p)) merged.push(p);
    }
    onChange(merged);
    setDraft('');
  }, [value, onChange]);

  const removeItem = useCallback((item: string) => {
    onChange(value.filter(v => v !== item));
  }, [value, onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addItems(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }, [draft, value, addItems, onChange]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (text.includes(',')) {
      e.preventDefault();
      addItems(text);
    }
  }, [addItems]);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="config-tag-input" ref={containerRef} onClick={focusInput}>
      {value.map(item => (
        <span key={item} className="config-tag">
          <span className="config-tag-text">{item}</span>
          <button
            className="config-tag-remove"
            onClick={e => { e.stopPropagation(); removeItem(item); }}
            title={`Remove "${item}"`}
            type="button"
          >×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="config-tag-textbox"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={value.length === 0 ? (placeholder || 'Type and press Enter…') : ''}
      />
    </div>
  );
}

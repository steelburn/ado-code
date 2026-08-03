import React, { useState, useRef, useEffect } from 'react';

interface MenuItem {
  label: string;
  icon?: string;
  action: string;
  separator?: boolean;
}

interface Props {
  items: MenuItem[];
  onSelect: (action: string) => void;
}

export function KebabMenu({ items, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (action: string) => {
    setOpen(false);
    onSelect(action);
  };

  return (
    <div className="kebab-menu" ref={ref}>
      <button
        className="btn btn-icon kebab-trigger"
        onClick={() => setOpen(!open)}
        title="More actions"
      >
        ⋯
      </button>
      {open && (
        <div className="kebab-dropdown">
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="kebab-separator" />
            ) : (
              <button
                key={i}
                className="kebab-item"
                onClick={() => handleSelect(item.action)}
              >
                {item.icon && <span className="kebab-item-icon">{item.icon}</span>}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

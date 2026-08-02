import React from 'react';

export function LoadingSpinner() {
  return (
    <div className="loading-spinner" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', color: 'var(--vscode-descriptionForeground)' }}>
      <span className="codicon codicon-loading codicon-modifier-spin" style={{ fontSize: '16px' }} />
      <span>Working…</span>
    </div>
  );
}

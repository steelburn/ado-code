// src/webview-ui/src/components/SkillCatalog/SkillDetail.tsx

import React, { useState } from 'react';
import { Skill } from '../../types';

interface Props {
  skill: Skill;
  onBack: () => void;
  onInstall: (skillId: string) => void;
  onUninstall: (skillId: string) => void;
  onToggle: (skillId: string, enabled: boolean) => void;
  onExecute: (skillId: string) => void;
}

const CATEGORY_ICONS: Record<string, string> = {
  'code-review': '🔍',
  'documentation': '📝',
  'testing': '🧪',
  'refactoring': '♻️',
  'security': '🔒',
  'performance': '⚡',
  'accessibility': '♿',
  'deployment': '🚀',
  'database': '🗄️',
  'custom': '🧩',
};

export function SkillDetail({ skill, onBack, onInstall, onUninstall, onToggle, onExecute }: Props) {
  const [promptExpanded, setPromptExpanded] = useState(true);
  const catIcon = CATEGORY_ICONS[skill.category] || '✦';

  return (
    <div className="skill-detail">
      {/* Back navigation */}
      <div className="skill-detail-nav">
        <button className="skill-back" onClick={onBack}>
          <span className="skill-back-arrow">←</span>
          <span>Back to Catalog</span>
        </button>
      </div>

      {/* Hero header */}
      <div className="skill-detail-hero">
        <div className="skill-detail-hero-content">
          <div className="skill-detail-icon-wrapper">
            <span className="skill-detail-icon">{skill.icon}</span>
          </div>
          <div className="skill-detail-info">
            <div className="skill-detail-title-row">
              <h2 className="skill-detail-name">{skill.name}</h2>
              {skill.installed && (
                <span className={`skill-detail-status ${skill.enabled ? 'skill-detail-status-active' : 'skill-detail-status-disabled'}`}>
                  <span className="skill-detail-status-dot" />
                  {skill.enabled ? 'Active' : 'Disabled'}
                </span>
              )}
            </div>
            <div className="skill-detail-meta">
              <span className="skill-detail-meta-item">
                <span className="skill-detail-meta-icon">👤</span>
                {skill.author}
              </span>
              <span className="skill-detail-meta-item">
                <span className="skill-detail-meta-icon">📦</span>
                v{skill.version}
              </span>
              <span className={`skill-source skill-source-${skill.source}`}>
                {skill.source}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="skill-detail-section">
        <p className="skill-detail-desc">{skill.description}</p>
      </div>

      {/* Tags */}
      {skill.tags.length > 0 && (
        <div className="skill-detail-section skill-detail-tags-section">
          <div className="skill-detail-tags">
            {skill.tags.map(tag => (
              <span key={tag} className="skill-tag skill-tag-lg">{tag}</span>
            ))}
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="skill-detail-actions">
        {skill.installed ? (
          <>
            <button
              className="skill-btn skill-btn-primary skill-btn-lg"
              onClick={() => onExecute(skill.id)}
              disabled={!skill.enabled}
            >
              <span className="skill-btn-icon">▶</span>
              Execute in Chat
            </button>
            <button
              className="skill-btn skill-btn-secondary"
              onClick={() => onToggle(skill.id, !skill.enabled)}
            >
              <span className="skill-btn-icon">{skill.enabled ? '⏸' : '▶'}</span>
              {skill.enabled ? 'Disable' : 'Enable'}
            </button>
            {!skill.builtin && (
              <button
                className="skill-btn skill-btn-danger"
                onClick={() => onUninstall(skill.id)}
              >
                <span className="skill-btn-icon">🗑</span>
                Uninstall
              </button>
            )}
          </>
        ) : (
          <button
            className="skill-btn skill-btn-primary skill-btn-lg"
            onClick={() => onInstall(skill.id)}
          >
            <span className="skill-btn-icon">⬇</span>
            Install Skill
          </button>
        )}
      </div>

      {/* Prompt Preview */}
      {skill.prompt && (
        <div className="skill-detail-section">
          <button
            className="skill-detail-section-header"
            onClick={() => setPromptExpanded(!promptExpanded)}
          >
            <span className="skill-detail-section-toggle">{promptExpanded ? '▾' : '▸'}</span>
            <span className="skill-detail-section-title">Prompt Template</span>
          </button>
          {promptExpanded && (
            <pre className="skill-prompt-preview">{skill.prompt}</pre>
          )}
        </div>
      )}

      {/* Configuration */}
      {skill.config && skill.config.length > 0 && (
        <div className="skill-detail-section">
          <h3 className="skill-detail-section-title">Configuration</h3>
          <div className="skill-config-list">
            {skill.config.map(cfg => (
              <div key={cfg.id} className="skill-config-item">
                <div className="skill-config-header">
                  <label className="skill-config-label">{cfg.label}</label>
                  <span className="skill-config-type">{cfg.type}</span>
                </div>
                {cfg.description && (
                  <span className="skill-config-desc">{cfg.description}</span>
                )}
                {cfg.default !== undefined && (
                  <span className="skill-config-default">
                    Default: <code>{String(cfg.default)}</code>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom padding */}
      <div className="skill-detail-bottom-pad" />
    </div>
  );
}

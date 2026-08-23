// src/webview-ui/src/components/SkillCatalog/SkillCard.tsx

import React from 'react';
import { Skill } from '../../types';

interface Props {
  skill: Skill;
  onSelect: (skillId: string) => void;
  onInstall: (skillId: string) => void;
  onToggle: (skillId: string, enabled: boolean) => void;
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
  'motion': '🎬',
  'systems': '🧱',
  'visual': '🎨',
  'interaction': '👆',
  'craft': '✨',
  'taste': '🎯',
  'typography': '🔤',
  'color': '🌈',
  '3d': '🧊',
  'frontend': '🌐',
  'architecture': '🏗️',
  'debugging': '🐛',
  'code-quality': '✅',
  'tooling': '🔧',
  'video': '🎬',
  'frameworks': '📦',
};

export function SkillCard({ skill, onSelect, onInstall, onToggle }: Props) {
  const catIcon = CATEGORY_ICONS[skill.category] || '✦';

  return (
    <div
      className={`skill-card ${skill.installed ? 'skill-card-installed' : ''} ${skill.enabled ? 'skill-card-enabled' : ''}`}
      onClick={() => onSelect(skill.id)}
    >
      {/* Accent stripe */}
      <div className="skill-card-stripe" />

      <div className="skill-card-body">
        {/* Header row: icon + info + action */}
        <div className="skill-card-header">
          <span className="skill-card-icon">{skill.icon}</span>
          <div className="skill-card-info">
            <h4 className="skill-card-name">{skill.name}</h4>
            <span className="skill-card-author">by {skill.author}</span>
          </div>
          <div className="skill-card-actions">
            {skill.installed ? (
              <label className="skill-toggle" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onChange={e => onToggle(skill.id, e.target.checked)}
                />
                <span className="skill-toggle-slider" />
              </label>
            ) : (
              <button
                className="skill-install-btn"
                onClick={e => { e.stopPropagation(); onInstall(skill.id); }}
              >
                Install
              </button>
            )}
          </div>
        </div>

        {/* Description */}
        <p className="skill-card-desc">{skill.description}</p>

        {/* Footer: category + tags + version */}
        <div className="skill-card-footer">
          <div className="skill-card-meta-left">
            <span className="skill-card-category">
              <span className="skill-card-cat-icon">{catIcon}</span>
              {skill.category}
            </span>
            <div className="skill-card-tags">
              {skill.tags.slice(0, 3).map(tag => (
                <span key={tag} className="skill-tag">{tag}</span>
              ))}
            </div>
          </div>
          <span className="skill-card-version">v{skill.version}</span>
        </div>

        {/* Status indicator */}
        {skill.installed && (
          <div className={`skill-card-status ${skill.enabled ? 'skill-status-active' : 'skill-status-disabled'}`}>
            <span className="skill-status-dot" />
            {skill.enabled ? 'Active' : 'Disabled'}
          </div>
        )}
      </div>
    </div>
  );
}

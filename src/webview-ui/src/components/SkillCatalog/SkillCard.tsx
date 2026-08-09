// src/webview-ui/src/components/SkillCatalog/SkillCard.tsx

import React from 'react';
import { Skill } from '../../types';

interface Props {
  skill: Skill;
  onSelect: (skillId: string) => void;
  onInstall: (skillId: string) => void;
  onToggle: (skillId: string, enabled: boolean) => void;
}

export function SkillCard({ skill, onSelect, onInstall, onToggle }: Props) {
  return (
    <div className="skill-card" onClick={() => onSelect(skill.id)}>
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
      <p className="skill-card-desc">{skill.description}</p>
      <div className="skill-card-meta">
        <span className="skill-card-category">{skill.category}</span>
        <div className="skill-card-tags">
          {skill.tags.slice(0, 3).map(tag => (
            <span key={tag} className="skill-tag">{tag}</span>
          ))}
        </div>
        <span className="skill-card-version">v{skill.version}</span>
      </div>
    </div>
  );
}

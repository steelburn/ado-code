// src/webview-ui/src/components/SkillCatalog/SkillDetail.tsx

import React from 'react';
import { Skill } from '../../types';

interface Props {
  skill: Skill;
  onBack: () => void;
  onInstall: (skillId: string) => void;
  onUninstall: (skillId: string) => void;
  onToggle: (skillId: string, enabled: boolean) => void;
  onExecute: (skillId: string) => void;
}

export function SkillDetail({ skill, onBack, onInstall, onUninstall, onToggle, onExecute }: Props) {
  return (
    <div className="skill-detail">
      <button className="skill-back" onClick={onBack}>← Back to Catalog</button>
      
      <div className="skill-detail-header">
        <span className="skill-detail-icon">{skill.icon}</span>
        <div className="skill-detail-info">
          <h2 className="skill-detail-name">{skill.name}</h2>
          <div className="skill-detail-meta">
            <span>by {skill.author}</span>
            <span>v{skill.version}</span>
            <span className={`skill-source skill-source-${skill.source}`}>{skill.source}</span>
          </div>
        </div>
      </div>
      
      <p className="skill-detail-desc">{skill.description}</p>
      
      <div className="skill-detail-tags">
        {skill.tags.map(tag => (
          <span key={tag} className="skill-tag">{tag}</span>
        ))}
      </div>
      
      <div className="skill-detail-actions">
        {skill.installed ? (
          <>
            <button
              className="skill-btn skill-btn-primary"
              onClick={() => onExecute(skill.id)}
              disabled={!skill.enabled}
            >
              Execute in Chat
            </button>
            <button
              className="skill-btn skill-btn-secondary"
              onClick={() => onToggle(skill.id, !skill.enabled)}
            >
              {skill.enabled ? 'Disable' : 'Enable'}
            </button>
            {!skill.builtin && (
              <button
                className="skill-btn skill-btn-danger"
                onClick={() => onUninstall(skill.id)}
              >
                Uninstall
              </button>
            )}
          </>
        ) : (
          <button
            className="skill-btn skill-btn-primary"
            onClick={() => onInstall(skill.id)}
          >
            Install Skill
          </button>
        )}
      </div>
      
      {skill.prompt && (
        <div className="skill-detail-section">
          <h3>Prompt Template</h3>
          <pre className="skill-prompt-preview">{skill.prompt}</pre>
        </div>
      )}
      
      {skill.config && skill.config.length > 0 && (
        <div className="skill-detail-section">
          <h3>Configuration</h3>
          <div className="skill-config-list">
            {skill.config.map(cfg => (
              <div key={cfg.id} className="skill-config-item">
                <label>{cfg.label}</label>
                <span className="skill-config-desc">{cfg.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

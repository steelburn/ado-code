// src/webview-ui/src/components/SkillCatalog/index.tsx

import React, { useState, useEffect, useCallback } from 'react';
import { vscode } from '../../vscode';
import { Skill, SkillCategory } from '../../types';
import { SkillCard } from './SkillCard';
import { SkillDetail } from './SkillDetail';
import './styles.css';

interface Props {
  onClose: () => void;
  onExecute?: (skillId: string, skillName: string) => void;
}

const CATEGORIES: { value: SkillCategory | 'all'; label: string; icon: string }[] = [
  { value: 'all', label: 'All Skills', icon: '✦' },
  { value: 'code-review', label: 'Code Review', icon: '🔍' },
  { value: 'documentation', label: 'Documentation', icon: '📝' },
  { value: 'testing', label: 'Testing', icon: '🧪' },
  { value: 'refactoring', label: 'Refactoring', icon: '♻️' },
  { value: 'security', label: 'Security', icon: '🔒' },
  { value: 'performance', label: 'Performance', icon: '⚡' },
  { value: 'deployment', label: 'Deployment', icon: '🚀' },
  { value: 'database', label: 'Database', icon: '🗄️' },
  { value: 'accessibility', label: 'Accessibility', icon: '♿' },
  { value: 'custom', label: 'Custom', icon: '🧩' },
];

export function SkillCatalog({ onClose, onExecute }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<SkillCategory | 'all'>('all');
  const [installedFilter, setInstalledFilter] = useState<boolean | null>(null);

  // Fetch skills on mount
  useEffect(() => {
    vscode.postMessage({ type: 'getSkillCatalog' });

    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'skillCatalog') {
        setSkills(msg.skills);
        setLoading(false);
      } else if (msg.type === 'skillInstalled' || msg.type === 'skillUninstalled') {
        // Refresh catalog
        vscode.postMessage({ type: 'getSkillCatalog' });
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const filteredSkills = skills.filter(skill => {
    const matchesSearch = skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         skill.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         skill.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = categoryFilter === 'all' || skill.category === categoryFilter;
    const matchesInstalled = installedFilter === null || skill.installed === installedFilter;
    return matchesSearch && matchesCategory && matchesInstalled;
  });

  const selectedSkill = selectedSkillId ? skills.find(s => s.id === selectedSkillId) : null;

  const installedCount = skills.filter(s => s.installed).length;
  const enabledCount = skills.filter(s => s.installed && s.enabled).length;

  const handleInstall = useCallback((skillId: string) => {
    vscode.postMessage({ type: 'installSkill', skillId });
  }, []);

  const handleUninstall = useCallback((skillId: string) => {
    vscode.postMessage({ type: 'uninstallSkill', skillId });
  }, []);

  const handleToggle = useCallback((skillId: string, enabled: boolean) => {
    vscode.postMessage({ type: enabled ? 'enableSkill' : 'disableSkill', skillId });
  }, []);

  const handleExecute = useCallback((skillId: string) => {
    const skill = skills.find(s => s.id === skillId);
    vscode.postMessage({ type: 'executeSkill', request: { skillId, input: '' } });
    onExecute?.(skillId, skill?.name || skillId);
    onClose();
  }, [skills, onExecute, onClose]);

  if (selectedSkill) {
    return (
      <SkillDetail
        skill={selectedSkill}
        onBack={() => setSelectedSkillId(null)}
        onInstall={handleInstall}
        onUninstall={handleUninstall}
        onToggle={handleToggle}
        onExecute={handleExecute}
      />
    );
  }

  return (
    <div className="skill-catalog">
      {/* Header */}
      <div className="skill-catalog-header">
        <div className="skill-catalog-header-left">
          <div className="skill-catalog-title-row">
            <span className="skill-catalog-icon">⚡</span>
            <h2 className="skill-catalog-title">Skill Catalog</h2>
          </div>
          <p className="skill-catalog-subtitle">
            {installedCount} installed · {enabledCount} active
          </p>
        </div>
        <button className="skill-catalog-close" onClick={onClose}>×</button>
      </div>

      {/* Toolbar: Search + Import */}
      <div className="skill-catalog-toolbar">
        <div className="skill-search-wrapper">
          <span className="skill-search-icon">⌕</span>
          <input
            className="skill-search"
            type="text"
            placeholder="Search by name, description, or tag..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="skill-search-clear" onClick={() => setSearchQuery('')}>×</button>
          )}
        </div>
        <button className="skill-import-btn" onClick={() => vscode.postMessage({ type: 'importSkillFromDisk' })}>
          <span className="skill-import-btn-icon">+</span>
          Import
        </button>
      </div>

      {/* Category Pills */}
      <div className="skill-catalog-categories">
        {CATEGORIES.map(cat => (
          <button
            key={cat.value}
            className={`skill-category-pill ${categoryFilter === cat.value ? 'skill-category-pill-active' : ''}`}
            onClick={() => setCategoryFilter(cat.value)}
          >
            <span className="skill-category-pill-icon">{cat.icon}</span>
            {cat.label}
          </button>
        ))}
      </div>

      {/* Installed filter tabs */}
      <div className="skill-catalog-tabs">
        <button
          className={`skill-tab ${installedFilter === null ? 'skill-tab-active' : ''}`}
          onClick={() => setInstalledFilter(null)}
        >
          All
          <span className="skill-tab-count">{skills.length}</span>
        </button>
        <button
          className={`skill-tab ${installedFilter === true ? 'skill-tab-active' : ''}`}
          onClick={() => setInstalledFilter(true)}
        >
          Installed
          <span className="skill-tab-count">{installedCount}</span>
        </button>
        <button
          className={`skill-tab ${installedFilter === false ? 'skill-tab-active' : ''}`}
          onClick={() => setInstalledFilter(false)}
        >
          Available
          <span className="skill-tab-count">{skills.length - installedCount}</span>
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="skill-catalog-loading">
          <div className="skill-loading-spinner" />
          <p>Loading skills...</p>
        </div>
      ) : filteredSkills.length === 0 ? (
        <div className="skill-catalog-empty">
          <span className="skill-empty-icon">
            {searchQuery ? '🔍' : '✅'}
          </span>
          <p className="skill-empty-title">
            {searchQuery ? 'No skills found' : 'All skills are loaded'}
          </p>
          <p className="skill-empty-desc">
            {searchQuery
              ? `No results for "${searchQuery}"`
              : 'All builtin skills are installed and enabled. Import a custom skill to add more.'}
          </p>
        </div>
      ) : (
        <div className="skill-catalog-grid">
          {filteredSkills.map(skill => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onSelect={setSelectedSkillId}
              onInstall={handleInstall}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

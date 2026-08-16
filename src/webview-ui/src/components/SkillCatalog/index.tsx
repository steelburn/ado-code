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
  // UI Skills registry categories
  { value: 'accessibility', label: 'Accessibility', icon: '♿' },
  { value: 'motion', label: 'Motion', icon: '🎬' },
  { value: 'systems', label: 'Systems', icon: '🧱' },
  { value: 'visual', label: 'Visual', icon: '🎨' },
  { value: 'interaction', label: 'Interaction', icon: '👆' },
  { value: 'performance', label: 'Performance', icon: '⚡' },
  { value: 'craft', label: 'Craft', icon: '✨' },
  { value: 'taste', label: 'Taste', icon: '🎯' },
  { value: 'typography', label: 'Typography', icon: '🔤' },
  { value: 'color', label: 'Color', icon: '🌈' },
  { value: '3d', label: '3D', icon: '🧊' },
  { value: 'frontend', label: 'Frontend', icon: '🌐' },
  { value: 'architecture', label: 'Architecture', icon: '🏗️' },
  { value: 'testing', label: 'Testing', icon: '🧪' },
  { value: 'tooling', label: 'Tooling', icon: '🔧' },
  // Builtin ADO Code categories
  { value: 'code-review', label: 'Code Review', icon: '🔍' },
  { value: 'documentation', label: 'Documentation', icon: '📝' },
  { value: 'refactoring', label: 'Refactoring', icon: '♻️' },
  { value: 'security', label: 'Security', icon: '🔒' },
  { value: 'deployment', label: 'Deployment', icon: '🚀' },
  { value: 'database', label: 'Database', icon: '🗄️' },
  { value: 'custom', label: 'Custom', icon: '🧩' },
];

type ViewMode = 'catalog' | 'registry';

export function SkillCatalog({ onClose, onExecute }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<SkillCategory | 'all'>('all');
  const [installedFilter, setInstalledFilter] = useState<boolean | null>(null);

  // Registry state
  const [viewMode, setViewMode] = useState<ViewMode>('catalog');
  const [registrySkills, setRegistrySkills] = useState<Skill[]>([]);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryInstalledIds, setRegistryInstalledIds] = useState<Set<string>>(new Set());

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
      } else if (msg.type === 'registrySkills') {
        setRegistrySkills(msg.skills);
        // Track which registry skills are already installed
        const installed = new Set<string>(
          msg.skills.filter((s: Skill) => s.installed).map((s: Skill) => s.id)
        );
        setRegistryInstalledIds(installed);
        setRegistryLoading(false);
      } else if (msg.type === 'registryInstallResult') {
        if (msg.success && msg.skill) {
          setRegistryInstalledIds(prev => new Set([...prev, msg.skill.id]));
          // Refresh the local catalog too
          vscode.postMessage({ type: 'getSkillCatalog' });
        }
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

  const filteredRegistrySkills = registrySkills.filter(skill => {
    const matchesSearch = skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         skill.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         skill.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = categoryFilter === 'all' || skill.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const selectedSkill = selectedSkillId
    ? (viewMode === 'catalog'
        ? skills.find(s => s.id === selectedSkillId)
        : registrySkills.find(s => s.id === selectedSkillId))
    : null;

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

  const handleInstallRegistry = useCallback((entry: { slug: string; url: string; description: string }) => {
    vscode.postMessage({ type: 'installRegistrySkill', entry });
  }, []);

  const handleLoadRegistry = useCallback(() => {
    setRegistryLoading(true);
    vscode.postMessage({ type: 'getRegistrySkills' });
  }, []);

  if (selectedSkill) {
    return (
      <SkillDetail
        skill={selectedSkill}
        onBack={() => setSelectedSkillId(null)}
        onInstall={viewMode === 'registry'
          ? () => handleInstallRegistry({
              slug: selectedSkill.id,
              url: '',
              description: selectedSkill.description,
            })
          : handleInstall}
        onUninstall={handleUninstall}
        onToggle={handleToggle}
        onExecute={handleExecute}
      />
    );
  }

  const activeSkills = viewMode === 'catalog' ? filteredSkills : filteredRegistrySkills;

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
            {viewMode === 'catalog'
              ? `${installedCount} installed · ${enabledCount} active`
              : `${registrySkills.length} available from registry`
            }
          </p>
        </div>
        <button className="skill-catalog-close" onClick={onClose}>×</button>
      </div>

      {/* View Mode Tabs: Catalog | Registry */}
      <div className="skill-catalog-view-tabs">
        <button
          className={`skill-view-tab ${viewMode === 'catalog' ? 'skill-view-tab-active' : ''}`}
          onClick={() => { setViewMode('catalog'); setSelectedSkillId(null); }}
        >
          <span className="skill-view-tab-icon">📦</span>
          Catalog
          <span className="skill-tab-count">{skills.length}</span>
        </button>
        <button
          className={`skill-view-tab ${viewMode === 'registry' ? 'skill-view-tab-active' : ''}`}
          onClick={() => { setViewMode('registry'); setSelectedSkillId(null); }}
        >
          <span className="skill-view-tab-icon">🌐</span>
          Registry
          <span className="skill-tab-count">{registrySkills.length || '—'}</span>
        </button>
      </div>

      {/* Toolbar: Search + Import (catalog only) */}
      <div className="skill-catalog-toolbar">
        <div className="skill-search-wrapper">
          <span className="skill-search-icon">⌕</span>
          <input
            className="skill-search"
            type="text"
            placeholder={viewMode === 'registry' ? 'Search registry skills...' : 'Search by name, description, or tag...'}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="skill-search-clear" onClick={() => setSearchQuery('')}>×</button>
          )}
        </div>
        {viewMode === 'catalog' ? (
          <button className="skill-import-btn" onClick={() => vscode.postMessage({ type: 'importSkillFromDisk' })}>
            <span className="skill-import-btn-icon">+</span>
            Import
          </button>
        ) : (
          <button
            className="skill-import-btn"
            onClick={handleLoadRegistry}
            disabled={registryLoading}
          >
            <span className="skill-import-btn-icon">{registryLoading ? '↻' : '↻'}</span>
            {registryLoading ? 'Loading...' : 'Refresh'}
          </button>
        )}
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

      {/* Installed filter tabs (catalog only) */}
      {viewMode === 'catalog' && (
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
      )}

      {/* Content */}
      {viewMode === 'registry' && !registryLoading && registrySkills.length === 0 ? (
        <div className="skill-catalog-empty">
          <span className="skill-empty-icon">🌐</span>
          <p className="skill-empty-title">No registry skills loaded</p>
          <p className="skill-empty-desc">
            Click "Refresh" to fetch skills from the external registry.
          </p>
        </div>
      ) : (viewMode === 'catalog' && loading) || (viewMode === 'registry' && registryLoading) ? (
        <div className="skill-catalog-loading">
          <div className="skill-loading-spinner" />
          <p>{viewMode === 'registry' ? 'Fetching registry skills...' : 'Loading skills...'}</p>
        </div>
      ) : activeSkills.length === 0 ? (
        <div className="skill-catalog-empty">
          <span className="skill-empty-icon">
            {searchQuery ? '🔍' : '✅'}
          </span>
          <p className="skill-empty-title">
            {searchQuery ? 'No skills found' : viewMode === 'registry' ? 'No registry skills' : 'All skills are loaded'}
          </p>
          <p className="skill-empty-desc">
            {searchQuery
              ? `No results for "${searchQuery}"`
              : viewMode === 'registry'
                ? 'No skills found in the configured registries.'
                : 'All builtin skills are installed and enabled. Import a custom skill to add more.'}
          </p>
        </div>
      ) : (
        <div className="skill-catalog-grid">
          {activeSkills.map(skill => (
            viewMode === 'registry' ? (
              <RegistrySkillCard
                key={skill.id}
                skill={skill}
                installed={registryInstalledIds.has(skill.id)}
                onSelect={setSelectedSkillId}
                onInstall={handleInstallRegistry}
              />
            ) : (
              <SkillCard
                key={skill.id}
                skill={skill}
                onSelect={setSelectedSkillId}
                onInstall={handleInstall}
                onToggle={handleToggle}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

// ── Registry Skill Card ──────────────────────────────────────────────

interface RegistryCardProps {
  skill: Skill;
  installed: boolean;
  onSelect: (skillId: string) => void;
  onInstall: (entry: { slug: string; url: string; description: string }) => void;
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

function RegistrySkillCard({ skill, installed, onSelect, onInstall }: RegistryCardProps) {
  const catIcon = CATEGORY_ICONS[skill.category] || '✦';

  return (
    <div
      className={`skill-card ${installed ? 'skill-card-installed' : ''}`}
      onClick={() => onSelect(skill.id)}
    >
      {/* Accent stripe */}
      <div className="skill-card-stripe skill-card-stripe-registry" />

      <div className="skill-card-body">
        {/* Header row: icon + info + action */}
        <div className="skill-card-header">
          <span className="skill-card-icon">{skill.icon}</span>
          <div className="skill-card-info">
            <h4 className="skill-card-name">{skill.name}</h4>
            <span className="skill-card-author">by {skill.author}</span>
          </div>
          <div className="skill-card-actions">
            {installed ? (
              <span className="skill-registry-installed-badge">Installed</span>
            ) : (
              <button
                className="skill-install-btn"
                onClick={e => {
                  e.stopPropagation();
                  onInstall({
                    slug: skill.id,
                    url: '',
                    description: skill.description,
                  });
                }}
              >
                Install
              </button>
            )}
          </div>
        </div>

        {/* Description */}
        <p className="skill-card-desc">{skill.description}</p>

        {/* Footer: category + tags + source */}
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
          <span className={`skill-source skill-source-${skill.source}`}>
            {skill.source}
          </span>
        </div>
      </div>
    </div>
  );
}

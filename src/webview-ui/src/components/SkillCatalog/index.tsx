// src/webview-ui/src/components/SkillCatalog/index.tsx

import React, { useState, useEffect, useCallback } from 'react';
import { vscode } from '../../vscode';
import { Skill, SkillCategory } from '../../types';
import { SkillCard } from './SkillCard';
import { SkillDetail } from './SkillDetail';
import './styles.css';

interface Props {
  onClose: () => void;
}

const CATEGORIES: { value: SkillCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All Skills' },
  { value: 'code-review', label: 'Code Review' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'testing', label: 'Testing' },
  { value: 'refactoring', label: 'Refactoring' },
  { value: 'security', label: 'Security' },
  { value: 'performance', label: 'Performance' },
  { value: 'custom', label: 'Custom' },
];

export function SkillCatalog({ onClose }: Props) {
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
    // This would trigger skill execution in the chat
    vscode.postMessage({ type: 'executeSkill', request: { skillId, input: '' } });
    onClose();
  }, [onClose]);
  
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
      <div className="skill-catalog-header">
        <h2>Skill Catalog</h2>
        <button className="skill-catalog-close" onClick={onClose}>×</button>
      </div>
      
      <div className="skill-catalog-filters">
        <input
          className="skill-search"
          type="text"
          placeholder="Search skills..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        
        <select
          className="skill-category-filter"
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value as any)}
        >
          {CATEGORIES.map(cat => (
            <option key={cat.value} value={cat.value}>{cat.label}</option>
          ))}
        </select>
        
        <select
          className="skill-installed-filter"
          value={installedFilter === null ? 'all' : installedFilter ? 'installed' : 'available'}
          onChange={e => {
            const val = e.target.value;
            setInstalledFilter(val === 'all' ? null : val === 'installed');
          }}
        >
          <option value="all">All</option>
          <option value="installed">Installed</option>
          <option value="available">Available</option>
        </select>
      </div>
      
      <div className="skill-catalog-stats">
        <span>{filteredSkills.length} skills</span>
        <span>{skills.filter(s => s.installed).length} installed</span>
      </div>
      
      {loading ? (
        <div className="skill-catalog-loading">Loading skills...</div>
      ) : filteredSkills.length === 0 ? (
        <div className="skill-catalog-empty">No skills found</div>
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

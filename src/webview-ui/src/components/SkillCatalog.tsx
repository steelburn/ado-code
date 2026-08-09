import React, { useState, useEffect, useCallback } from 'react';
import { vscode } from '../vscode';

interface Skill {
  name: string;
  description: string;
  category: string;
  loaded: boolean;
}

interface Props {
  onClose: () => void;
}

export function SkillCatalog({ onClose }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Listen for skill catalog data from extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'skillCatalog') {
        setSkills(msg.skills);
        setLoading(false);
      }
    };
    window.addEventListener('message', handler);
    // Request skill catalog data
    vscode.postMessage({ type: 'getSkillCatalog' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // Filter skills by search and category
  const filteredSkills = skills.filter(skill => {
    const matchesSearch = searchQuery === '' ||
      skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || skill.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  // Get unique categories
  const categories = ['all', ...new Set(skills.map(s => s.category))];

  return (
    <div className="skill-catalog">
      <div className="skill-catalog-header">
        <button className="skill-catalog-back" onClick={onClose}>← Back</button>
        <h2 className="skill-catalog-title">Skill Catalog</h2>
      </div>

      <div className="skill-catalog-search">
        <input
          type="text"
          placeholder="Search skills..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="skill-catalog-search-input"
        />
      </div>

      <div className="skill-catalog-categories">
        {categories.map(cat => (
          <button
            key={cat}
            className={`skill-catalog-category ${selectedCategory === cat ? 'skill-catalog-category-active' : ''}`}
            onClick={() => setSelectedCategory(cat)}
          >
            {cat === 'all' ? 'All' : cat}
          </button>
        ))}
      </div>

      <div className="skill-catalog-list">
        {loading ? (
          <div className="skill-catalog-loading">
            <div className="loading-dots"><span /><span /><span /></div>
            <p>Loading skills...</p>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="skill-catalog-empty">
            <p>No skills found{searchQuery ? ` matching "${searchQuery}"` : ''}</p>
          </div>
        ) : (
          filteredSkills.map(skill => (
            <div key={skill.name} className="skill-catalog-item">
              <div className="skill-catalog-item-header">
                <span className="skill-catalog-item-name">{skill.name}</span>
                <span className={`skill-catalog-item-badge ${skill.loaded ? 'skill-catalog-badge-loaded' : 'skill-catalog-badge-available'}`}>
                  {skill.loaded ? 'Loaded' : 'Available'}
                </span>
              </div>
              <p className="skill-catalog-item-desc">{skill.description}</p>
              <span className="skill-catalog-item-category">{skill.category}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

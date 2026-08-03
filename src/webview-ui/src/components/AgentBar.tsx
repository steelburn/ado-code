import React from 'react';

interface Agent {
  name: string;
  displayName: string;
  installed: boolean;
}

interface Props {
  agents: Agent[];
  selectedAgent: string;
  onSelect: (name: string) => void;
  visible: boolean;
}

export function AgentBar({ agents, selectedAgent, onSelect, visible }: Props) {
  if (!visible || agents.length === 0) return null;

  return (
    <div className="agent-bar">
      <span className="agent-bar-label">Agent:</span>
      <select
        value={selectedAgent}
        onChange={e => onSelect(e.target.value)}
      >
        {agents.map(a => (
          <option key={a.name} value={a.name} disabled={!a.installed}>
            {a.displayName}{a.installed ? '' : ' (not installed)'}
          </option>
        ))}
      </select>
    </div>
  );
}

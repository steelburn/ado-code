import React from 'react';

interface Props {
  projects: Array<{ id: string; name: string; state: string }>;
  current: string;
  loading: boolean;
  onSwitch: (projectName: string) => void;
  onRefresh: () => void;
}

/**
 * Project switcher for the main chat header. Lets the user change the active
 * ADO project without re-running the setup wizard; the host persists the
 * choice and refreshes work items. A refresh button always sits next to the
 * select so the list can be re-fetched (initial fetch failed, projects were
 * added, etc.) — it must never be displaced by the select's text.
 */
export function ProjectSwitcher({ projects, current, loading, onSwitch, onRefresh }: Props) {
  const options = projects.map(p => ({ value: p.name, label: p.name }));
  // Always render the current project so the select shows it even when the
  // list hasn't loaded yet (e.g. first fetch failed).
  if (current && !options.some(o => o.value === current)) {
    options.unshift({ value: current, label: current });
  }

  return (
    <div className="project-switcher" title={`Project: ${current || 'none'}`}>
      {loading ? (
        <span className="project-switcher-loading">Fetching projects…</span>
      ) : (
        <>
          {options.length > 0 && (
            <select
              className="project-switcher-select"
              value={current}
              onChange={e => onSwitch(e.target.value)}
              aria-label="Switch project"
            >
              {options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
          <button
            className="project-switcher-refresh"
            onClick={onRefresh}
            title={options.length === 0 ? 'Project list unavailable — retry' : 'Refresh project list'}
            aria-label="Refresh project list"
          >
            ↻
          </button>
        </>
      )}
    </div>
  );
}

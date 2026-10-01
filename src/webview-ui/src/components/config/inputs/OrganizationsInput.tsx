export interface AdoOrg {
  name: string;
  url: string;
  project: string;
  pat?: string;
}

/** Editor for the ADO organizations list — add/remove orgs with name, URL, project. */
export function OrganizationsInput({ value, onChange }: { value: AdoOrg[]; onChange: (orgs: AdoOrg[]) => void }) {
  const addOrg = () => {
    onChange([...value, { name: '', url: '', project: '' }]);
  };

  const removeOrg = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const updateOrg = (idx: number, field: keyof AdoOrg, fieldValue: string) => {
    const updated = [...value];
    updated[idx] = { ...updated[idx], [field]: fieldValue };
    onChange(updated);
  };

  return (
    <div className="config-mcp">
      {value.length === 0 && (
        <div className="config-mcp-empty">No organizations configured. Click + to add one.</div>
      )}
      {value.map((org, idx) => (
        <div key={idx} className="config-mcp-server">
          <div className="config-mcp-server-header">
            <span className="config-mcp-server-num">#{idx + 1}</span>
            <button
              className="config-mcp-remove"
              onClick={() => removeOrg(idx)}
              title="Remove organization"
              type="button"
            >×</button>
          </div>
          <div className="config-mcp-fields">
            <div className="config-mcp-row">
              <label className="config-mcp-label">Name</label>
              <input
                className="config-input"
                type="text"
                value={org.name}
                onChange={e => updateOrg(idx, 'name', e.target.value)}
                placeholder="mycompany"
              />
            </div>
            <div className="config-mcp-row">
              <label className="config-mcp-label">URL</label>
              <input
                className="config-input"
                type="text"
                value={org.url}
                onChange={e => updateOrg(idx, 'url', e.target.value)}
                placeholder="https://dev.azure.com/mycompany"
              />
            </div>
            <div className="config-mcp-row">
              <label className="config-mcp-label">Project</label>
              <input
                className="config-input"
                type="text"
                value={org.project}
                onChange={e => updateOrg(idx, 'project', e.target.value)}
                placeholder="MyProject"
              />
            </div>
            <div className="config-mcp-row">
              <label className="config-mcp-label">PAT (optional)</label>
              <input
                className="config-input"
                type="password"
                value={org.pat ?? ''}
                onChange={e => updateOrg(idx, 'pat', e.target.value)}
                placeholder="Leave blank to use global PAT"
              />
            </div>
          </div>
        </div>
      ))}
      <button className="config-mcp-add" onClick={addOrg} type="button">
        + Add Organization
      </button>
    </div>
  );
}

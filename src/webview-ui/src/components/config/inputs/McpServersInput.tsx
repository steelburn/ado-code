export interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

/** Editor for MCP server configurations — add/remove servers with name, command, args, env. */
export function McpServersInput({ value, onChange }: { value: McpServer[]; onChange: (servers: McpServer[]) => void }) {
  const addServer = () => {
    onChange([...value, { name: '', command: '', args: [] }]);
  };

  const removeServer = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const updateServer = (idx: number, field: keyof McpServer, fieldValue: any) => {
    const updated = [...value];
    updated[idx] = { ...updated[idx], [field]: fieldValue };
    onChange(updated);
  };

  const updateArgs = (idx: number, argsStr: string) => {
    const args = argsStr.split(',').map(s => s.trim()).filter(Boolean);
    updateServer(idx, 'args', args.length > 0 ? args : undefined);
  };

  return (
    <div className="config-mcp">
      {value.length === 0 && (
        <div className="config-mcp-empty">No MCP servers configured. Click + to add one.</div>
      )}
      {value.map((server, idx) => (
        <div key={idx} className="config-mcp-server">
          <div className="config-mcp-server-header">
            <span className="config-mcp-server-num">#{idx + 1}</span>
            <button
              className="config-mcp-remove"
              onClick={() => removeServer(idx)}
              title="Remove server"
              type="button"
            >×</button>
          </div>
          <div className="config-mcp-fields">
            <div className="config-mcp-row">
              <label className="config-mcp-label">Name</label>
              <input
                className="config-input"
                type="text"
                value={server.name}
                onChange={e => updateServer(idx, 'name', e.target.value)}
                placeholder="my-server"
              />
            </div>
            <div className="config-mcp-row">
              <label className="config-mcp-label">Command</label>
              <input
                className="config-input"
                type="text"
                value={server.command}
                onChange={e => updateServer(idx, 'command', e.target.value)}
                placeholder="npx -y @modelcontextprotocol/server-..."
              />
            </div>
            <div className="config-mcp-row">
              <label className="config-mcp-label">Args</label>
              <input
                className="config-input"
                type="text"
                value={server.args?.join(', ') ?? ''}
                onChange={e => updateArgs(idx, e.target.value)}
                placeholder="arg1, arg2"
              />
            </div>
            <div className="config-mcp-row">
              <label className="config-mcp-label">Timeout (ms)</label>
              <input
                className="config-input"
                type="number"
                value={server.timeout ?? ''}
                onChange={e => updateServer(idx, 'timeout', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="30000"
              />
            </div>
          </div>
        </div>
      ))}
      <button className="config-mcp-add" onClick={addServer} type="button">
        + Add Server
      </button>
      <details className="config-mcp-guide">
        <summary>Remote MCP Server Setup Guide</summary>
        <div className="config-mcp-guide-content">
          <p>ADO Code connects to MCP servers via <strong>stdio transport</strong> (spawning a local process). To connect to a <strong>remote HTTP/SSE MCP server</strong>, use <code>mcp-remote</code> as a bridge:</p>
          <div className="config-mcp-guide-example">
            <strong>Example: Remote server via mcp-remote</strong>
            <pre>{`{\n  "name": "my-remote-server",\n  "command": "npx",\n  "args": ["-y", "mcp-remote", "https://your-server.example.com/sse"]\n}`}</pre>
          </div>
          <p><strong>Common remote MCP servers:</strong></p>
          <ul>
            <li><code>npx -y mcp-remote &lt;url&gt;</code> — Generic bridge for any HTTP/SSE MCP server</li>
            <li><code>npx -y @modelcontextprotocol/server-everything &lt;url&gt;</code> — Reference server for testing</li>
          </ul>
          <p><strong>With authentication:</strong></p>
          <pre>{`{\n  "name": "auth-server",\n  "command": "npx",\n  "args": ["-y", "mcp-remote", "https://server.example.com/sse", "--header", "Authorization:Bearer ***"],\n  "env": { "API_KEY": "your-key" }\n}`}</pre>
          <p><strong>Local stdio servers</strong> (no bridge needed):</p>
          <pre>{`{\n  "name": "filesystem",\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]\n}`}</pre>
        </div>
      </details>
    </div>
  );
}

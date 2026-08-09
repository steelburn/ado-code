import React, { useState, useEffect, useCallback, useRef } from 'react';
import { vscode } from '../vscode';

interface Props {
  onBack: () => void;
  /** Fetch model ids with typed-but-unsaved LLM credentials (host does the call). */
  onFetchModels?: (provider?: string, apiUrl?: string, apiKey?: string) => void;
  models?: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  modelsLoading?: boolean;
}

interface ConfigSection {
  title: string;
  icon: string;
  settings: ConfigSetting[];
}

interface ConfigSetting {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'enum' | 'array' | 'mcp' | 'orgs' | 'capOverrides';
  description: string;
  hint?: string;
  min?: number;
  max?: number;
  options?: string[];
  placeholder?: string;
}

const SECTIONS: ConfigSection[] = [
  {
    title: 'Azure DevOps',
    icon: '🔵',
    settings: [
      { key: 'adoOrganization', label: 'Organization', type: 'string', description: 'ADO organization name (e.g. mycompany)', placeholder: 'mycompany' },
      // Active ADO project is intentionally NOT here: the project is bound
      // per workspace (.ado-code/config.json) and switched from the chat
      // header / work item trees.
      { key: 'adoPat', label: 'Personal Access Token', type: 'password', description: 'ADO PAT with Work Items + Project scope', placeholder: 'vso.work_write' },
      { key: 'adoServerUrl', label: 'Server URL (on-prem)', type: 'string', description: 'For ADO Server (TFS) — leave empty for cloud', placeholder: 'https://ado.corp.local/tfs/DefaultCollection' },
      { key: 'organizations', label: 'Organizations', type: 'orgs', description: 'ADO organizations the developer works with. The ACTIVE org is picked per workspace.' },
    ],
  },
  {
    title: 'LLM Provider',
    icon: '🤖',
    settings: [
      { key: 'llmProvider', label: 'Provider', type: 'enum', description: 'LLM API format', options: ['openai', 'anthropic'] },
      { key: 'llmApiUrl', label: 'API URL', type: 'string', description: 'LLM API base URL', placeholder: 'https://api.openai.com/v1' },
      { key: 'llmApiKey', label: 'API Key', type: 'password', description: 'LLM API key', placeholder: 'sk-...' },
      { key: 'llmModel', label: 'Model', type: 'string', description: 'Model name', placeholder: 'gpt-4o' },
      { key: 'llm.choiceDetectionModel', label: 'Choice detection model', type: 'string', description: 'Optional CHEAPER model for detecting choice prompts in AI responses (e.g. gpt-4o-mini). Empty = use the main model. Set to "off" to disable LLM-assisted detection.', placeholder: 'gpt-4o-mini' },
      { key: 'llm.capabilityOverrides', label: 'Capability overrides', type: 'capOverrides', description: 'Per-model vision/tool-calling overrides. You know your model best: declare it here and it beats auto-detection. Leave a field unset to keep the detected value.' },
    ],
  },
  {
    title: 'Mode',
    icon: '⚡',
    settings: [
      { key: 'mode', label: 'Default Mode', type: 'enum', description: 'Tool-use mode for new conversations', options: ['inline', 'plan', 'act', 'yolo'] },
    ],
  },
  {
    title: 'Git',
    icon: '🌿',
    settings: [
      { key: 'git.requireGitRepo', label: 'Require Git repo', type: 'boolean', description: 'Block task pickup when not in a git repo' },
      { key: 'git.createBranchOnTaskStart', label: 'Create branch on task start', type: 'boolean', description: 'Auto-create feature/ADO-<id> branch' },
      { key: 'git.requireCleanTree', label: 'Require clean tree', type: 'boolean', description: 'Warn on branch switch with uncommitted changes' },
      { key: 'git.prOnCompletion', label: 'PR on completion', type: 'boolean', description: 'Offer to push + create PR via gh on task done' },
      { key: 'git.protectedBranches', label: 'Protected PR targets', type: 'array', description: 'Branches create_pull_request must never target (comma-separated)' },
    ],
  },
  {
    title: 'Changelog',
    icon: '📝',
    settings: [
      { key: 'changelog.enabled', label: 'Enabled', type: 'boolean', description: 'Update CHANGELOG.md on task completion' },
      { key: 'changelog.autoCommit', label: 'Auto-commit', type: 'boolean', description: 'Commit CHANGELOG.md automatically' },
      { key: 'changelog.postToAdo', label: 'Post to ADO', type: 'boolean', description: 'Add changelog entry as ADO comment' },
    ],
  },
  {
    title: 'Work Items',
    icon: '📋',
    settings: [
      { key: 'ado.clarificationState', label: 'Clarification state', type: 'string', description: 'State to set when clarification is requested', placeholder: 'Blocked' },
      { key: 'ado.warnOnSparseTask', label: 'Warn on sparse tasks', type: 'boolean', description: 'Warn before starting tasks with no description or AC' },
    ],
  },
  {
    title: 'Act Mode',
    icon: '🚀',
    settings: [
      { key: 'act.toolBudget', label: 'Tool budget', type: 'number', description: 'Max tool calls per act-mode turn', hint: 'Recommended: 15–30. Lower = faster stops, higher = more autonomous. Below 10 may truncate complex tasks.', min: 1, max: 100 },
      { key: 'act.terminalAllowlist', label: 'Terminal allowlist', type: 'array', description: 'Allowed command prefixes in act mode' },
    ],
  },
  {
    title: 'Consent',
    icon: '🔐',
    settings: [
      { key: 'consent.harmlessAutoApprove', label: 'Auto-approve harmless commands', type: 'boolean', description: 'Show a countdown timer on consent cards for read-only commands (git status, npm test, etc.). The command auto-approves when the timer expires.', hint: 'Read-only terminal commands like git status, git diff, npm test, ls, etc. are detected automatically. You can still approve or reject before the timer expires.' },
      { key: 'consent.harmlessAutoApproveSeconds', label: 'Auto-approve delay (seconds)', type: 'number', description: 'Seconds before a harmless command auto-approves', hint: 'How long to wait before auto-approving a harmless command. Lower = faster, higher = more time to review. Range: 1–30 seconds.', min: 1, max: 30 },
    ],
  },
  {
    title: 'Sessions',
    icon: '🕐',
    settings: [
      { key: 'sessions.maxPerProject', label: 'Max sessions per project', type: 'number', description: 'Older sessions auto-pruned beyond this limit' },
    ],
  },
  {
    title: 'Agents',
    icon: '🧑‍💻',
    settings: [
      { key: 'agents.enabled', label: 'Enabled agents', type: 'array', description: 'Which agents may be delegated to' },
      { key: 'agents.verifyCommand', label: 'Verify command', type: 'string', description: 'Shell command to run after agent finishes (e.g. npm test)', placeholder: 'npm test' },
      { key: 'agents.autoSelect', label: 'Default agent', type: 'enum', description: 'Default agent when none specified', options: ['', 'claude', 'codex', 'opencode', 'hermes', 'pi', 'openclaw', 'aider', 'gemini', 'cursor-agent'] },
      { key: 'agents.autoReview', label: 'Auto-review agent changes', type: 'boolean', description: 'Automatically review agent changes via LLM when a run completes' },
    ],
  },
  {
    title: 'Chat',
    icon: '💬',
    settings: [
      { key: 'chat.showThinking', label: 'Show AI thinking', type: 'boolean', description: 'Display the model\'s thinking/reasoning text while it processes (o1/o3 reasoning, Claude extended thinking)', hint: 'When enabled, the model\'s internal reasoning appears in a blue thinking block while it streams. Only works with models that return thinking tokens (o1, o3, Claude with extended thinking). Has no effect on models that don\'t support it.' },
    ],
  },
  {
    title: 'MCP Servers',
    icon: '🔌',
    settings: [
      { key: 'mcp.servers', label: 'Server configurations', type: 'mcp', description: 'Model Context Protocol server connections — each server exposes tools the AI can use' },
    ],
  },
  {
    title: 'Workspace',
    icon: '🛡',
    settings: [
      { key: 'ignore.dotAdoCode', label: 'Keep .ado-code out of version control', type: 'boolean', description: 'Auto-add .ado-code to .gitignore / .dockerignore (prompts once per workspace; "Skip" is remembered)' },
    ],
  },
];

/** Tag/chip input for array settings */
function ArrayInput({ value, placeholder, onChange }: { value: string[]; placeholder?: string; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const addItems = useCallback((text: string) => {
    const parts = text.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const merged = [...value];
    for (const p of parts) {
      if (!merged.includes(p)) merged.push(p);
    }
    onChange(merged);
    setDraft('');
  }, [value, onChange]);

  const removeItem = useCallback((item: string) => {
    onChange(value.filter(v => v !== item));
  }, [value, onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addItems(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }, [draft, value, addItems, onChange]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (text.includes(',')) {
      e.preventDefault();
      addItems(text);
    }
  }, [addItems]);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="config-tag-input" ref={containerRef} onClick={focusInput}>
      {value.map(item => (
        <span key={item} className="config-tag">
          <span className="config-tag-text">{item}</span>
          <button
            className="config-tag-remove"
            onClick={e => { e.stopPropagation(); removeItem(item); }}
            title={`Remove "${item}"`}
            type="button"
          >×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="config-tag-textbox"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={value.length === 0 ? (placeholder || 'Type and press Enter…') : ''}
      />
    </div>
  );
}

interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

/** Editor for MCP server configurations — add/remove servers with name, command, args, env. */
function McpServersInput({ value, onChange }: { value: McpServer[]; onChange: (servers: McpServer[]) => void }) {
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
            <pre>{`{
  "name": "my-remote-server",
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://your-server.example.com/sse"]
}`}</pre>
          </div>
          <p><strong>Common remote MCP servers:</strong></p>
          <ul>
            <li><code>npx -y mcp-remote &lt;url&gt;</code> — Generic bridge for any HTTP/SSE MCP server</li>
            <li><code>npx -y @modelcontextprotocol/server-everything &lt;url&gt;</code> — Reference server for testing</li>
          </ul>
          <p><strong>With authentication:</strong></p>
          <pre>{`{
  "name": "auth-server",
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://server.example.com/sse", "--header", "Authorization:Bearer YOUR_TOKEN"],
  "env": { "API_KEY": "your-key" }
}`}</pre>
          <p><strong>Local stdio servers</strong> (no bridge needed):</p>
          <pre>{`{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
}`}</pre>
        </div>
      </details>
    </div>
  );
}

interface AdoOrg {
  name: string;
  url: string;
  project: string;
}

/** Editor for the ADO organizations list — add/remove orgs with name, URL, project. */
function OrganizationsInput({ value, onChange }: { value: AdoOrg[]; onChange: (orgs: AdoOrg[]) => void }) {
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
          </div>
        </div>
      ))}
      <button className="config-mcp-add" onClick={addOrg} type="button">
        + Add Organization
      </button>
    </div>
  );
}

interface CapOverride {
  model: string;
  vision?: boolean;
  tools?: boolean;
}

/** Editor for per-model capability overrides — add/remove rows with model id
 *  + vision/tools toggles (unset = keep auto-detected). Mirrors McpServersInput. */
function CapabilityOverridesInput({ value, onChange }: { value: CapOverride[]; onChange: (rows: CapOverride[]) => void }) {
  const addRow = () => {
    onChange([...value, { model: '' }]);
  };

  const removeRow = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const updateRow = (idx: number, field: keyof CapOverride, fieldValue: any) => {
    const updated = [...value];
    updated[idx] = { ...updated[idx], [field]: fieldValue };
    onChange(updated);
  };

  return (
    <div className="config-mcp">
      {value.length === 0 && (
        <div className="config-mcp-empty">No capability overrides. Click + to declare vision/tool support for a model the auto-detection gets wrong.</div>
      )}
      {value.map((row, idx) => (
        <div key={idx} className="config-mcp-server">
          <div className="config-mcp-server-header">
            <span className="config-mcp-server-num">#{idx + 1}</span>
            <button
              className="config-mcp-remove"
              onClick={() => removeRow(idx)}
              title="Remove override"
              type="button"
            >×</button>
          </div>
          <div className="config-mcp-fields">
            <div className="config-mcp-row">
              <label className="config-mcp-label">Model id</label>
              <input
                className="config-input"
                type="text"
                value={row.model}
                onChange={e => updateRow(idx, 'model', e.target.value)}
                placeholder="deepseek-v4"
              />
            </div>
            <div className="config-mcp-row config-cap-toggles">
              <label className="config-mcp-label">
                <input
                  type="checkbox"
                  checked={row.vision === true}
                  onChange={e => updateRow(idx, 'vision', e.target.checked ? true : undefined)}
                />{' '}
                Vision
              </label>
              <label className="config-mcp-label">
                <input
                  type="checkbox"
                  checked={row.tools === true}
                  onChange={e => updateRow(idx, 'tools', e.target.checked ? true : undefined)}
                />{' '}
                Tool calling
              </label>
              <span className="config-cap-hint">(unchecked = keep auto-detected)</span>
            </div>
          </div>
        </div>
      ))}
      <button className="config-mcp-add" onClick={addRow} type="button">
        + Add Override
      </button>
    </div>
  );
}

/**
 * Mirror of src/llm/modelCapabilities.ts (host). Kept here so the
 * Configuration page can show capabilities LIVE as the user types/picks a
 * model, without a host round-trip. Keep the patterns in sync.
 */
function inferModelCapabilities(
  modelId: string,
  live?: { vision?: boolean; tools?: boolean },
  overrides?: CapOverride[]
): { vision: boolean; tools: boolean } {
  const id = (modelId ?? '').toLowerCase().trim();
  if (!id) return { vision: false, tools: true };
  const override = overrides?.find(o => (o.model ?? '').toLowerCase().trim() === id);
  const noToolsExact = new Set([
    'dall-e-3', 'dall-e-2', 'whisper-1', 'tts-1', 'tts-1-hd',
    'gpt-3.5-turbo-instruct', 'text-embedding-3-large', 'text-embedding-3-small', 'text-embedding-ada-002',
  ]);
  const vision = override?.vision !== undefined
    ? override.vision
    : live?.vision !== undefined
      ? live.vision
      : /vision|gemini|claude|4o|4\.1|4\.5|gpt-5|pixtral|llava|idefics|cogvlm|moondream|firellava|bakllava|smolvlm|paligemma|internvl|glm-4v|glm-4\.5v|qwen[^ ]*\bvl\b|gpt-4-turbo|\bo[1-9]\b|llama-4|gemma-3|deepseek-vl|minicpm/i.test(id);
  const tools = override?.tools !== undefined
    ? override.tools
    : live?.tools !== undefined
      ? live.tools
      : !noToolsExact.has(id) && !/embedding|whisper|\btts\b|dall-?e/i.test(id);
  return { vision, tools };
}

/**
 * Model list retrieval for the LLM Provider section: visible once the user
 * has typed an API URL and API Key (saved or not — the host fetches with the
 * typed values, exactly like the setup wizard's model picker). Picking a
 * model sets `llmModel` on the form.
 */
function ModelFetcher({
  config,
  models,
  loading,
  error,
  onFetch,
  onPick,
}: {
  config: Record<string, any>;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  loading: boolean;
  error: string | null;
  onFetch: (provider?: string, apiUrl?: string, apiKey?: string) => void;
  onPick: (model: string) => void;
}) {
  const url = String(config.llmApiUrl ?? '').trim();
  const key = String(config.llmApiKey ?? '').trim();
  if (!url || !key) {
    return (
      <div className="config-models">
        <div className="config-desc">Enter an API URL and API Key to fetch the model list.</div>
      </div>
    );
  }
  const current = String(config.llmModel ?? '');
  return (
    <div className="config-models">
      <button
        className="config-models-fetch"
        onClick={() => onFetch(config.llmProvider, config.llmApiUrl, config.llmApiKey)}
        disabled={loading}
        type="button"
      >
        {loading ? 'Fetching…' : models.length > 0 ? '↻ Refresh models' : 'Fetch Models'}
      </button>
      {loading && <div className="config-desc">Fetching models from {url}…</div>}
      {error && <div className="config-models-error">{error}</div>}
      {!loading && models.length > 0 && (
        <select
          className="config-select"
          value={current}
          onChange={e => onPick(e.target.value)}
          title={`${models.length} models available`}
        >
          <option value="">— pick a model —</option>
          {current && !models.some(m => m.id === current) && (
            <option value={current}>{current} (current)</option>
          )}
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Capability readout for the currently selected model (live from the form,
 *  preferring user overrides, then gateway-provided hints from a fetched
 *  model list, then the name heuristic). */
function ModelCapabilitiesLine({ model, models, overrides }: {
  model: string;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  overrides?: CapOverride[];
}) {
  const live = models.find(m => m.id === model);
  const caps = inferModelCapabilities(model, live ? { vision: live.vision, tools: live.tools } : undefined, overrides);
  return (
    <div className="config-models">
      <div className={`config-caps ${caps.tools ? '' : 'config-caps-warn'}`}>
        <span>Capabilities:</span>
        <span className={caps.vision ? 'config-cap-ok' : 'config-cap-no'}>
          🖼 vision {caps.vision ? '✓' : '✗'}
        </span>
        <span className={caps.tools ? 'config-cap-ok' : 'config-cap-no'}>
          🛠 tool calling {caps.tools ? '✓' : '✗'}
        </span>
      </div>
      {!caps.tools && (
        <div className="config-models-error">
          ⚠ This model doesn't support tool calling — agentic modes (Chat/Plan/Act) will degrade to plain chat without tools, file edits, or delegation.
        </div>
      )}
    </div>
  );
}

export function ConfigurationPage({ onBack, onFetchModels, models, modelsLoading }: Props) {
  const [config, setConfig] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Inline display for host fetch failures (the global error banner is not
  // rendered on this page).
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'fullConfig') {
        setConfig(msg.config);
        setLoading(false);
      } else if (msg.type === 'error') {
        setFetchError(msg.message);
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getFullConfig' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleChange = useCallback((key: string, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  }, []);

  const handleSave = useCallback(() => {
    vscode.postMessage({ type: 'saveConfig', config });
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [config]);

  if (loading) {
    return (
      <div className="config-page">
        <div className="config-loading">Loading settings…</div>
      </div>
    );
  }

  return (
    <div className="config-page">
      <div className="config-header">
        <button className="config-back" onClick={onBack} title="Back to chat">← Back</button>
        <h2 className="config-title">Configuration</h2>
        <button
          className={`config-save ${dirty ? 'config-save-dirty' : ''}`}
          onClick={handleSave}
          disabled={!dirty}
        >
          {saved ? '✓ Saved' : 'Save'}
        </button>
      </div>

      <div className="config-body">
        {SECTIONS.map(section => (
          <div key={section.title} className="config-section">
            <h3 className="config-section-title">
              <span className="config-section-icon">{section.icon}</span>
              {section.title}
            </h3>
            {section.settings.map(setting => (
              <div key={setting.key} className="config-field">
                <label className="config-label">{setting.label}</label>
                <div className="config-desc">{setting.description}</div>
                {setting.hint && <div className="config-desc" style={{ fontStyle: 'italic', opacity: 0.7, marginTop: -4, marginBottom: 4 }}>{setting.hint}</div>}
                {setting.type === 'boolean' ? (
                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={!!config[setting.key]}
                      onChange={e => handleChange(setting.key, e.target.checked)}
                    />
                    <span className="config-toggle-slider" />
                  </label>
                ) : setting.type === 'enum' ? (
                  <select
                    className="config-select"
                    value={config[setting.key] ?? ''}
                    onChange={e => handleChange(setting.key, e.target.value)}
                  >
                    {setting.options?.map(opt => (
                      <option key={opt} value={opt}>{opt || '(none)'}</option>
                    ))}
                  </select>
                ) : setting.type === 'number' ? (
                  <input
                    className="config-input"
                    type="number"
                    min={setting.min}
                    max={setting.max}
                    value={config[setting.key] ?? ''}
                    onChange={e => handleChange(setting.key, Number(e.target.value))}
                  />
                ) : setting.type === 'array' ? (
                  <ArrayInput
                    value={Array.isArray(config[setting.key]) ? config[setting.key] : []}
                    placeholder={setting.placeholder}
                    onChange={items => handleChange(setting.key, items)}
                  />
                ) : setting.type === 'mcp' ? (
                  <McpServersInput
                    value={Array.isArray(config[setting.key]) ? config[setting.key] : []}
                    onChange={servers => handleChange(setting.key, servers)}
                  />
                ) : setting.type === 'orgs' ? (
                  <OrganizationsInput
                    value={Array.isArray(config[setting.key]) ? config[setting.key] : []}
                    onChange={orgs => handleChange(setting.key, orgs)}
                  />
                ) : setting.type === 'capOverrides' ? (
                  <CapabilityOverridesInput
                    value={Array.isArray(config[setting.key]) ? config[setting.key] : []}
                    onChange={rows => handleChange(setting.key, rows)}
                  />
                ) : (
                  <input
                    className="config-input"
                    type={setting.type === 'password' ? 'password' : 'text'}
                    value={config[setting.key] ?? ''}
                    onChange={e => handleChange(setting.key, e.target.value)}
                    placeholder={setting.placeholder}
                  />
                )}
              </div>
            ))}
            {section.title === 'LLM Provider' && (
              <>
                <ModelFetcher
                  config={config}
                  models={models ?? []}
                  loading={modelsLoading ?? false}
                  error={fetchError}
                  onFetch={(provider, apiUrl, apiKey) => {
                    setFetchError(null);
                    onFetchModels?.(provider, apiUrl, apiKey);
                  }}
                  onPick={model => handleChange('llmModel', model)}
                />
                <ModelCapabilitiesLine
                  model={String(config.llmModel ?? '')}
                  models={models ?? []}
                  overrides={Array.isArray(config['llm.capabilityOverrides']) ? config['llm.capabilityOverrides'] : []}
                />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Configuration settings catalog — single source of truth for the Configuration page's settings surface.
// Pure data + types (no React, no vscode bridge), so it lives in src/config/
// where the host-side guard tests import it as real data (R5); the webview
// reaches it through a relative import.
//
// `key` is typed as ConfigSettingKey: a typo'd or un-contributed key is now a
// COMPILE error instead of a silently uneditable row.

import type { ConfigSettingKey } from '../shared/configSchema';

export interface ConfigSection {
  title: string;
  icon: string;
  settings: ConfigSetting[];
  /** Render the model fetch/refresh control under this section. */
  showModelFetcher?: boolean;
  /** Render the vision/tools capability readout under this section. */
  showModelCapabilities?: boolean;
}

export interface ConfigCategory {
  id: string;
  title: string;
  icon: string;
  sections: ConfigSection[];
  /**
   * Ids of rows the page renders OUTSIDE `sections` (e.g. the per-mode model rows
   * in Advanced). The sidebar badge derives its count from this, so the badge can
   * never disagree with what is actually rendered.
   */
  extraRows?: readonly string[];
}

export interface ConfigSetting {
  key: ConfigSettingKey;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'enum' | 'array' | 'mcp' | 'orgs' | 'capOverrides' | 'model';
  description: string;
  hint?: string;
  min?: number;
  max?: number;
  options?: string[];
  placeholder?: string;
}

/** A per-mode model row shown in the Advanced category. Rendered by the page
 *  from MODE_ROWS (not a ConfigSetting); the sidebar count derives from it via
 *  ConfigCategory.extraRows, so adding a mode updates the badge automatically. */
export interface ModeRow {
  id: string;
  label: string;
  icon: string;
}

export const MODE_ROWS: readonly ModeRow[] = [
  { id: 'inline', label: 'Chat (Inline)', icon: '💬' },
  { id: 'plan', label: 'Plan', icon: '📋' },
  { id: 'act', label: 'Act', icon: '🚀' },
  { id: 'yolo', label: 'YOLO', icon: '⚡' },
];

/** Express Configuration — simplified settings for most users, grouped into
 *  navigable categories in the sidebar. */
export const CATEGORIES: ConfigCategory[] = [
  {
    id: 'connection',
    title: 'Connection',
    icon: '🔌',
    sections: [
      {
        title: 'Azure DevOps',
        icon: '🔵',
        settings: [
          { key: 'adoOrganization', label: 'Organization', type: 'string', description: 'ADO organization name (e.g. mycompany)', placeholder: 'mycompany' },
          { key: 'adoPat', label: 'Personal Access Token', type: 'password', description: 'ADO PAT with Work Items + Project scope', placeholder: 'vso.work_write' },
          { key: 'adoServerUrl', label: 'Server URL (on-prem)', type: 'string', description: 'For ADO Server (TFS) — leave empty for cloud', placeholder: 'https://ado.corp.local/tfs/DefaultCollection' },
          { key: 'organizations', label: 'Organizations', type: 'orgs', description: 'ADO organizations the developer works with. The ACTIVE org is picked per workspace.' },
        ],
      },
      {
        title: 'LLM Provider',
        showModelFetcher: true,
        showModelCapabilities: true,
        icon: '🤖',
        settings: [
          { key: 'llmProvider', label: 'Provider', type: 'enum', description: 'LLM API format', options: ['openai', 'anthropic'] },
          { key: 'llmApiUrl', label: 'API URL', type: 'string', description: 'LLM API base URL', placeholder: 'https://api.openai.com/v1' },
          { key: 'llmApiKey', label: 'API Key', type: 'password', description: 'LLM API key', placeholder: 'sk-...' },
          { key: 'llmModel', label: 'Model', type: 'model', description: 'Model name (used for all modes)', placeholder: 'gpt-4o' },
        ],
      },
    ],
  },
  {
    id: 'ai-modes',
    title: 'AI & Modes',
    icon: '🤖',
    sections: [
      {
        title: 'Mode',
        icon: '⚡',
        settings: [
          { key: 'mode', label: 'Default Mode', type: 'enum', description: 'Tool-use mode for new conversations', options: ['inline', 'plan', 'act', 'yolo'] },
          { key: 'yolo.pushApproval', label: 'YOLO still asks before pushing', type: 'boolean', description: 'Require approval before code is pushed to the remote repo (push_worktree tool / git push) even in YOLO mode', hint: 'Pushes are hard to undo and reach other people, so they stay gated even under full autonomy. Turn OFF to let YOLO push without asking.' },
        ],
      },
      {
        title: 'Act Mode',
        icon: '🚀',
        settings: [
          { key: 'act.toolBudget', label: 'Iteration budget', type: 'number', description: 'Max agentic loop iterations per chat turn', hint: 'Each iteration is one model round-trip that may run several tool calls in parallel. Recommended: 100+. ADO Code works on large repositories where deep, multi-step work is common — start at 100 and raise it if turns keep hitting the ceiling. Lower = faster stops, higher = more autonomous.', min: 1, max: 1000 },
          { key: 'act.terminalAllowlist', label: 'Terminal allowlist', type: 'array', description: 'Allowed commands in act mode (supports wildcards, e.g. "git *", "npm run *")', hint: 'Entries are matched token-by-token, so they are safe from shell operators. A trailing * matches any remaining tokens: "git *" allows every git subcommand, "git push *" only pushes. Commands not matching any entry ask for approval.' },
        ],
      },
      {
        title: 'Chat',
        icon: '💬',
        settings: [
          { key: 'chat.showThinking', label: 'Show AI thinking', type: 'boolean', description: "Display the model's thinking/reasoning text while it processes (o1/o3 reasoning, Claude extended thinking)", hint: "When enabled, the model's internal reasoning appears inline as quiet, de-emphasized text while it streams. Only works with models that return thinking tokens (o1, o3, Claude with extended thinking). Has no effect on models that don't support it." },
          { key: 'chat.showToolCalls', label: 'Show tool calls in chat', type: 'boolean', description: 'Display tool calls as live cards in the chat while the AI works (running → completed, with arguments and results)', hint: "When enabled, every tool the AI runs appears as a card that flips from running to completed. Turn it off to keep tool details out of the chat — you'll still see a subtle '…' indicator while the AI works, and the tools still run normally." },
          { key: 'chat.inputWhileBusy', label: 'Message while AI is busy', type: 'enum', options: ['steer', 'queue'], description: 'What happens when you send a message while the AI is still processing: Steer applies it to the current turn immediately, Queue holds it and runs it next', hint: 'Steer interrupts the AI current response so your new message lands right away. Queue waits for the AI to finish, then sends your message automatically. The in-chat send button lets you override this per message.' },
          { key: 'chat.suggestDelegation', label: 'Suggest external agents', type: 'boolean', description: 'Show an action card suggesting a hand-off to an installed external coding agent (claude, codex, gemini, …) when a task suits a separate agent run', hint: 'When ON, the assistant may propose delegating a large or self-contained task to another agent. Nothing runs until you accept the suggestion.' },
          { key: 'chat.density', label: 'Chat density', type: 'enum', options: ['comfortable', 'compact', 'answers-only'], description: 'How much per-turn detail the chat shows: Comfortable (everything), Compact (tighter spacing), or Answers only (hide tool/reasoning chrome)', hint: "Comfortable shows tool activity, reasoning and turn summaries. Compact keeps that detail with tighter spacing. Answers only hides the chrome on finished turns — expand a turn to reveal its details on demand." },
        ],
      },
      {
        title: 'Sessions',
        icon: '🕐',
        settings: [
          { key: 'sessions.maxPerProject', label: 'Max sessions per project', type: 'number', description: 'Older sessions auto-pruned beyond this limit' },
        ],
      },
    ],
  },
  {
    id: 'permissions',
    title: 'Permissions',
    icon: '🔐',
    sections: [
      {
        title: 'Consent',
        icon: '🔐',
        settings: [
          { key: 'consent.harmlessAutoApprove', label: 'Auto-approve harmless commands', type: 'boolean', description: 'Run read-only terminal commands (git status/diff/log, npm test, ls, grep, …) immediately, without a consent card or countdown timer', hint: 'When ON, harmless read-only commands like git status, git diff, npm test and ls execute instantly — no approval prompt at all. When OFF, they ask for approval like any other mutating tool. Commands are detected automatically (no shell operators + a known read-only base/subcommand).' },
          { key: 'consent.autoApproveTools', label: 'Auto-approve tools (wildcards)', type: 'array', description: 'Tool names (or patterns) that run without a consent prompt', hint: 'Enter tool names like edit_file, or patterns with * and ? — e.g. "read_*" auto-approves read_file and read_workspace_memory, "get_*" auto-approves all get_* tools. Tools matching here skip the consent card in inline and act modes (plan mode still stays read-only). Terminal commands: "run_terminal_command" or "run_*" auto-approves ALL shell commands — treat that like yolo mode.' },
        ],
      },
    ],
  },
  {
    id: 'workflow',
    title: 'Workflow',
    icon: '🛠️',
    sections: [
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
        title: 'Workspace',
        icon: '🛡',
        settings: [
          { key: 'ignore.dotAdoCode', label: 'Keep .ado-code out of version control', type: 'boolean', description: 'Auto-add .ado-code to .gitignore / .dockerignore (prompts once per workspace; "Skip" is remembered)' },
        ],
      },
      {
        title: 'Understanding',
        icon: '🧠',
        settings: [
          { key: 'understanding.enabled', label: 'Cache repository understanding', type: 'boolean', description: 'Cache repository + work-item understanding in .ado-code/understanding/ and inject it into chat sessions and delegated-agent prompts (so new sessions and agents start from prior knowledge)' },
          { key: 'understanding.agentsMdSync', label: 'Sync AGENTS.md with understanding', type: 'boolean', description: 'Keep AGENTS.md in sync with the repository understanding: generate one when missing, and refresh its generated sections when understanding changes', hint: 'ADO Code rewrites only the managed sections of AGENTS.md on sync; edits you make anywhere else in the file are preserved.' },
          { key: 'understanding.autoSummarize', label: 'Auto-generate LLM repo summary', type: 'boolean', description: 'Generate an LLM repository summary automatically when the repo changes (new branch/commit, edited AGENTS.md/package.json/README). Uses one model call per change. Refresh manually anytime via "ADO Code: Refresh Repository Understanding".' },
        ],
      },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    icon: '🧩',
    sections: [
      {
        title: 'Agents',
        icon: '🧑‍💻',
        settings: [
          { key: 'agents.enabled', label: 'Enabled agents', type: 'array', description: 'Which agents may be delegated to' },
          { key: 'agents.verifyCommand', label: 'Verify command', type: 'string', description: 'Shell command to run after agent finishes (e.g. npm test)', placeholder: 'npm test' },
          { key: 'agents.autoSelect', label: 'Default agent', type: 'enum', description: 'Default agent when none specified', options: ['', 'claude', 'codex', 'opencode', 'hermes', 'pi', 'openclaw', 'aider', 'gemini', 'cursor-agent', 'dsh'] },
          { key: 'agents.autoCompleteChildren', label: 'Auto-complete child items', type: 'boolean', description: 'After a delegated agent run on a parent work item succeeds, transition its children to their terminal state from the Delivery Report (Task/Bug → Closed, Story/Feature/Epic → Done)', hint: 'Off by default. When ON, children the Delivery Report marks DONE are closed automatically after a successful run.' },
          { key: 'agents.progressView', label: 'Agent progress view', type: 'enum', options: ['chat', 'editor'], description: 'Where to show a delegated agent run progress: in the chat transcript, or in a dedicated editor tab', hint: 'Chat keeps everything in one place and updates the run card in the chat. Editor opens a separate tab that streams live while the chat stays usable.' },
          { key: 'agents.autoReview', label: 'Auto-review agent changes', type: 'boolean', description: 'Automatically review agent changes via LLM when a run completes' },
        ],
      },
      {
        title: 'Skills',
        icon: '🧩',
        settings: [
          { key: 'skillRegistryUrls', label: 'Skill registry URLs', type: 'array', description: 'Additional skill registry URLs to fetch skills from (TSV rows: slug, url, description)', hint: 'One registry URL per line, or paste several separated by commas. The built-in UI Skills registry is always included.' },
        ],
      },
      {
        title: 'MCP Servers',
        icon: '🔌',
        settings: [
          { key: 'mcp.servers', label: 'Server configurations', type: 'mcp', description: 'Model Context Protocol server connections — each server exposes tools the AI can use' },
        ],
      },
    ],
  },
];

/** Advanced Configuration — gated by the Advanced toggle in the sidebar.
 *  Per-Mode Model Configuration is special-cased in the render (it needs the
 *  ModeModelConfig components); its rows come from MODE_ROWS, so the sidebar
 *  count is derived from ADVANCED_CATEGORY.extraRows rather than hand-counted. */
export const ADVANCED_CATEGORY: ConfigCategory = {
  id: 'advanced',
  title: 'Advanced',
  icon: '⚙️',
  extraRows: MODE_ROWS.map(m => m.id),
  sections: [
    {
      title: 'Model Capability Overrides',
      icon: '🧠',
      settings: [
        { key: 'llm.capabilityOverrides', label: 'Capability overrides', type: 'capOverrides', description: 'Per-model vision / tool-calling declarations for models the auto-detection gets wrong', hint: 'Add a row per model id. Leaving a toggle unchecked keeps the auto-detected value.' },
      ],
    },
    {
      title: 'Model & Counting',
      showModelFetcher: true,
      icon: '🔢',
      settings: [
        { key: 'llm.choiceDetectionModel', label: 'Choice detection model', type: 'model', description: 'Optional cheaper model for AI choice-prompt detection (empty = use the main model)', placeholder: 'e.g. gpt-4o-mini, claude-haiku; type "off" to disable' },
        { key: 'llm.useNativeTokenCounting', label: 'Native token counting', type: 'boolean', description: 'Use provider-native token counting (Anthropic count_tokens; OpenAI-compatible via usage.prompt_tokens) for status-bar accuracy' },
      ],
    },
  ],
};

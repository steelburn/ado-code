#!/usr/bin/env node
// scripts/update-structure.js
// Generates .hermes/STRUCTURE.md from the live source tree.
// Cross-platform Node.js — no external dependencies.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUTPUT = path.join(ROOT, '.hermes', 'STRUCTURE.md');

// Skip directories
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test']);

// Extension counts
const EXTENSIONS = new Set(['.ts', '.tsx']);

// Purpose descriptions for every source file (relative to src/)
const PURPOSES = {
  // === src/ root ===
  'extension.ts': 'Entry point: activate(), deactivate(), registers commands',
  'services.ts': 'Service orchestration and dependency injection',

  // === src/ado/ ===
  'ado/client.ts': 'ADO REST API client for work items and projects',
  'ado/types.ts': 'TypeScript types for ADO API responses and requests',
  'ado/WorkItemsTreeProvider.ts': 'VS Code tree view provider for ADO work items',
  'ado/WorkItemStatesCache.ts': 'Caches ADO work item state transitions',

  // === src/agents/ ===
  'agents/AgentRunner.ts': 'Orchestrates agent execution lifecycle and streaming',
  'agents/registry.ts': 'Registry for discovering and instantiating agent adapters',
  'agents/types.ts': 'Shared types for agent adapters and runner config',
  'agents/adapters/ClaudeAdapter.ts': 'Adapter for Anthropic Claude Code CLI',
  'agents/adapters/CodexAdapter.ts': 'Adapter for OpenAI Codex CLI',
  'agents/adapters/GeminiAdapter.ts': 'Adapter for Google Gemini CLI',
  'agents/adapters/GenericAdapter.ts': 'Generic adapter for custom shell-based agents',
  'agents/adapters/HermesAdapter.ts': 'Adapter for Hermes Agent CLI',
  'agents/adapters/OpenCodeAdapter.ts': 'Adapter for OpenCode CLI',
  'agents/adapters/PiAdapter.ts': 'Adapter for Pi (interactive REPL) agent',
  'agents/adapters/index.ts': 'Barrel export for all agent adapters',
  'agents/adapters/types.ts': 'Type definitions for agent adapter interface',

  // === src/changelog/ ===
  'changelog/ChangelogService.ts': 'Generates and manages changelogs from git history',

  // === src/config/ ===
    'config/settings.ts': 'Reads and validates extension configuration settings',

  // === src/git/ ===
  'git/GitService.ts': 'Git operations: diff, commit, branch, log via CLI',

  // === src/llm/ ===
  'llm/agentic.ts': 'Agentic loop: plans tasks and orchestrates tool calls',
  'llm/client.ts': 'HTTP client for LLM API calls with retries',
  'llm/consent.ts': 'Consent management for tool execution approvals',
    'llm/modes.ts': 'Conversation mode definitions (chat, code, agentic)',
  'llm/prompts.ts': 'Prompt template assembly and injection',
  'llm/tool-approval-ui.ts': 'UI for reviewing and approving tool executions',
  'llm/tools.ts': 'Tool orchestration: dispatches calls to registered tools',
  'llm/types.ts': 'Shared types for LLM messages, completions, and options',
  'llm/context/condenser.ts': 'Context window condensation and summarization',
  'llm/context/contextManager.ts': 'Manages conversation context and token budgets',
  'llm/context/tokenCounter.ts': 'Token counting for budget enforcement',
  'llm/prompts/system.ts': 'System prompt definitions for each conversation mode',
  'llm/providers/BaseProvider.ts': 'Abstract base class for LLM providers',
    'llm/providers/anthropic.ts': 'Anthropic provider (legacy message-based)',
    'llm/providers/openai.ts': 'OpenAI provider (legacy completions-based)',
                'llm/tools/types.ts': 'Types for tool definitions, parameters, and results',
                
  // === src/services/ ===
  'services/checkpoints/CheckpointService.ts': 'Saves and restores workspace checkpoints',
  'services/checkpoints/types.ts': 'Types for checkpoint data and operations',
  'services/mcp/McpClient.ts': 'MCP protocol client for tool discovery',
  'services/mcp/McpManager.ts': 'Manages MCP server connections and lifecycle',
  'services/mcp/types.ts': 'Types for MCP protocol messages and capabilities',

  // === src/shared/ ===
  'shared/messages.ts': 'Message type constants for webview↔extension IPC',

  // === src/test/ ===
  'test/runTest.ts': 'Test runner bootstrap for VS Code extension host',
  'test/suite/index.ts': 'Mocha test suite loader and configuration',
  'test/suite/ado/clarification.test.ts': 'Tests for ADO work item clarification flow',
  'test/suite/ado/client.test.ts': 'Tests for ADO REST API client',
  'test/suite/agents/adapters.test.ts': 'Tests for agent adapter implementations',
  'test/suite/agents/agentRunner.test.ts': 'Tests for agent runner orchestration',
  'test/suite/agents/registry.test.ts': 'Tests for agent registry discovery',
  'test/suite/changelog/changelogService.test.ts': 'Tests for changelog generation',
  'test/suite/checkpoints/checkpointService.test.ts': 'Tests for checkpoint save/restore',
  'test/suite/git/gitService.test.ts': 'Tests for git service operations',
  'test/suite/llm/agentic.test.ts': 'Tests for agentic loop behavior',
  'test/suite/llm/consent.test.ts': 'Tests for tool consent flow',
  'test/suite/llm/prompts.test.ts': 'Tests for prompt template generation',
  'test/suite/llm/providers.test.ts': 'Tests for LLM provider integrations',
  'test/suite/llm/tools.test.ts': 'Tests for tool dispatch and execution',
  'test/suite/mcp/mcpClient.test.ts': 'Tests for MCP client protocol handling',
  'test/suite/mcp/mockMcpServer.ts': 'Mock MCP server for integration tests',
  'test/suite/webview/chatViewProvider.test.ts': 'Tests for chat webview provider',
  'test/suite/webview/conversation.test.ts': 'Tests for conversation state management',

  // === src/webview/ ===
  'webview/ChatViewProvider.ts': 'VS Code webview provider for chat panel UI',

  // === src/webview-ui/src/ ===
  'webview-ui/src/App.tsx': 'Root React component for webview chat UI',
  'webview-ui/src/index.tsx': 'React entry point that mounts the app',
  'webview-ui/src/types.ts': 'Shared types for webview components and messages',
    'webview-ui/src/components/AgentOutputPanel.tsx': 'Panel displaying agent streaming output',
  'webview-ui/src/components/ConsentCard.tsx': 'Consent approval card for tool calls',
  'webview-ui/src/components/InputBar.tsx': 'Chat input bar with send and attach',
  'webview-ui/src/components/KebabMenu.tsx': 'Overflow menu for conversation actions',
    'webview-ui/src/components/MarkdownRenderer.tsx': 'Renders markdown with syntax highlighting',
  'webview-ui/src/components/MessageList.tsx': 'Scrollable list of chat messages',
  'webview-ui/src/components/ProjectSwitcher.tsx': 'Project/workspace selector dropdown',
  'webview-ui/src/components/TaskDetailPanel.tsx': 'Detailed view for agent task info',
  'webview-ui/src/components/WelcomeScreen.tsx': 'First-run welcome and setup screen',
  'webview-ui/src/components/ui/Badge.tsx': 'Status badge UI primitive',
  'webview-ui/src/components/ui/Button.tsx': 'Reusable button component',
  'webview-ui/src/components/ui/Card.tsx': 'Container card component',
  'webview-ui/src/components/ui/Dialog.tsx': 'Modal dialog component',
  'webview-ui/src/components/ui/ToggleSwitch.tsx': 'Toggle switch input component',
  'webview-ui/src/components/ui/Tooltip.tsx': 'Hover tooltip component',
  'webview-ui/src/components/ui/cn.ts': 'Utility: conditional className joiner',
  'webview-ui/src/components/ui/index.ts': 'Barrel export for UI primitives',
  // === additional current-tree files ===
  'ado/markdownToHtml.ts': 'Converts markdown to HTML for work item descriptions',
  'agents/adapters/DshAdapter.ts': 'Adapter for DeepSeek Harness (headless profile)',
  'git/gitError.ts': 'Git error message parsing and user-facing hints',
  'git/mergeCleanup.ts': 'Post-merge cleanup of agent worktrees and branches',
  'git/mergeConflicts.ts': 'Conflict surfacing for agent-run PRs',
  'llm/confirmation.ts': 'Confirmation broker for user-facing choice prompts',
  'llm/modelCapabilities.ts': 'Three-layer model capability inference',
  'llm/parseChoicePrompt.ts': 'Detects and parses AI choice prompts (A/B/C questions)',
  'memory/UserMemory.ts': 'Per-user preferences stored in VS Code globalState',
  'memory/WorkspaceMemory.ts': 'Per-project conventions stored in .ado-code/memory/',
  'services/ignoreFiles.ts': 'Keeps .ado-code out of .gitignore/.dockerignore',
  'services/logger.ts': 'Output-channel logger',
  'services/SkillManager.ts': 'Skill discovery, extraction, and execution',
  'services/understanding/UnderstandingService.ts': 'Durable repo + work-item understanding cache (.ado-code/understanding/)',
  'shared/agenticLimits.ts': 'Agentic-loop budget constants',
  'shared/extractSkillArchive.ts': 'Extracts skill archives (.tar.gz/.zip) for import',
  'shared/parseSkillMd.ts': 'Parses SKILL.md frontmatter + body',
  'shared/skillTypes.ts': 'Types for the skill catalog',
  'shared/slashCommands.ts': 'Slash command registry and parsing',
  'shared/workItemsMode.ts': 'Shared Work Items tree mode (My/All/Unassigned)',
  'webview/AgentDetailPanel.ts': 'Agent details panel (binary, version, modes, args)',
  'webview/AgentProgressPanel.ts': 'Live agent progress panel in the editor area',
  'webview/AgentSummaryPanel.ts': 'Styled summary panel for finished agent runs',
  'webview/WorkItemDetailPanel.ts': 'Formatted work item detail view',
  'webview/WorktreesTreeProvider.ts': 'Agent-worktree tree view (run status, branches)',
  'webview/StatusPanelProvider.ts': 'Status panel: agents, runs, memory, MCP servers',
  'webview/ProjectCreationService.ts': 'Project scaffolding wizard backend (Node/Python/PHP/.NET)',
  'webview/agentsMd.ts': 'Builds AGENTS.md project-context content for agents',
  'webview/markdown.ts': 'Markdown rendering helpers for webview panels',
  'webview-ui/src/components/ConfigurationPage.tsx': 'Settings/Configuration page UI',
  'webview-ui/src/components/ConfirmationCard.tsx': 'Confirmation card for consent/choice prompts',
  'webview-ui/src/components/SessionHistory.tsx': 'Session history list',
  'webview-ui/src/components/ProjectCreationWizard/index.tsx': 'Project wizard stepper container',
  'webview-ui/src/components/ProjectCreationWizard/StepAdoIntegration.tsx': 'Wizard step: ADO org/project binding',
  'webview-ui/src/components/ProjectCreationWizard/StepGitSetup.tsx': 'Wizard step: git init options',
  'webview-ui/src/components/ProjectCreationWizard/StepProjectDetails.tsx': 'Wizard step: project name/location',
  'webview-ui/src/components/ProjectCreationWizard/StepProjectType.tsx': 'Wizard step: stack template picker',
  'webview-ui/src/components/ProjectCreationWizard/StepReview.tsx': 'Wizard step: review + create',
  'webview-ui/src/components/ProjectCreationWizard/StepTemplateOptions.tsx': 'Wizard step: template option details',
  'webview-ui/src/components/ProjectCreationWizard/types.ts': 'Wizard request/template types',
  'webview-ui/src/components/SkillCatalog/index.tsx': 'Skill catalog browser',
  'webview-ui/src/components/SkillCatalog/SkillCard.tsx': 'Skill catalog card',
  'webview-ui/src/components/SkillCatalog/SkillDetail.tsx': 'Skill catalog detail view',
  'webview-ui/src/utils/highlightCode.ts': 'Syntax highlighting for code blocks',
  'webview-ui/src/vscode.ts': 'Webview VS Code API accessor',
  'test/suite/ado/markdownToHtml.test.ts': 'Tests for markdown→HTML conversion',
  'test/suite/ado/workItemsTreeProvider.test.ts': 'Tests for the Work Items tree provider',
  'test/suite/git/gitError.test.ts': 'Tests for git error parsing',
  'test/suite/git/mergeCleanup.test.ts': 'Tests for post-merge cleanup',
  'test/suite/git/mergeConflicts.test.ts': 'Tests for conflict surfacing',
  'test/suite/llm/modelCapabilities.test.ts': 'Tests for capability inference',
  'test/suite/llm/parseChoicePrompt.test.ts': 'Tests for choice-prompt detection',
  'test/suite/memory/userMemory.test.ts': 'Tests for user memory',
  'test/suite/memory/workspaceMemory.test.ts': 'Tests for workspace memory',
  'test/suite/services/ignoreFiles.test.ts': 'Tests for .ado-code ignore management',
  'test/suite/services/understanding.test.ts': 'Tests for repository understanding cache',
  'test/suite/webview/agentsMd.test.ts': 'Tests for AGENTS.md context builder',
  'test/suite/webview/worktreesTreeProvider.test.ts': 'Tests for the worktrees tree view',
};

function walkDir(dir, callback) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) {
        walkDir(fullPath, callback);
      }
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

function countLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

function isSourceFile(filePath) {
  const ext = path.extname(filePath);
  return EXTENSIONS.has(ext);
}

function getRelativePath(fullPath) {
  return path.relative(ROOT, fullPath).replace(/\\/g, '/');
}

function getSourceRelativePath(fullPath) {
  return path.relative(SRC_DIR, fullPath).replace(/\\/g, '/');
}

function getDirRelative(fullPath) {
  const dir = path.dirname(fullPath);
  const rel = path.relative(ROOT, dir).replace(/\\/g, '/');
  return rel;
}

function main() {
  // Collect file info
  const files = [];
  const dirStats = new Map(); // dir -> { files, lines }

  walkDir(SRC_DIR, (filePath) => {
    if (!isSourceFile(filePath)) return;

    const rel = getSourceRelativePath(filePath);
    // Skip files inside node_modules
    if (rel.includes('node_modules')) return;

    const lines = countLines(filePath);
    const dirKey = getDirRelative(filePath);

    if (!dirStats.has(dirKey)) {
      dirStats.set(dirKey, { files: 0, lines: 0 });
    }
    const ds = dirStats.get(dirKey);
    ds.files++;
    ds.lines += lines;

    const purpose = PURPOSES[rel] || '';
    files.push({ rel, lines, purpose, dir: dirKey });
  });

  // Sort files by directory then name
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // Sort directories
  const sortedDirs = [...dirStats.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Calculate totals
  let totalFiles = 0;
  let totalLines = 0;
  for (const [, ds] of dirStats) {
    totalFiles += ds.files;
    totalLines += ds.lines;
  }

  // Build markdown
  const now = new Date().toISOString();
  let md = '';
  md += '# Codebase Structure (auto-generated)\n';
  md += `> Regenerated by \`node scripts/update-structure.js\` on ${now}\n\n`;

  // Summary table
  md += '## Summary\n';
  md += '| Directory | Files | Lines |\n';
  md += '|-----------|------:|------:|\n';
  for (const [dir, ds] of sortedDirs) {
    md += `| ${dir} | ${ds.files} | ${ds.lines} |\n`;
  }
  md += `| **Total** | **${totalFiles}** | **${totalLines}** |\n\n`;

  // Files table
  md += '## Files\n';
  md += '| File | Lines | Purpose |\n';
  md += '|------|------:|---------|\n';
  for (const f of files) {
    const purposeCell = f.purpose || '_—_';
    md += `| ${f.rel} | ${f.lines} | ${purposeCell} |\n`;
  }

  // Write output
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, md, 'utf8');

  console.log(`✅ Generated ${OUTPUT}`);
  console.log(`   ${totalFiles} files, ${totalLines} lines across ${dirStats.size} directories`);
}

main();

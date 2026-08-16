/**
 * Dynamic system prompt generator — creates mode-specific prompts
 * tailored to the current operating mode, environment, and tool access.
 *
 * Simplified from Roo-Code's prompt architecture. Pure TypeScript,
 * no VS Code dependency.
 */

import type { ModeConfig } from '../modes';
import { TOOL_GROUPS, getToolsForMode } from '../modes';
import { TOOL_DISPLAY_NAMES, type ToolName } from '../tools/types';
import type { Skill } from '../../shared/skillTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for generating a system prompt. */
export interface SystemPromptOptions {
  /** The active mode configuration. */
  mode: ModeConfig;
  /** Absolute path to the workspace root. */
  workspacePath: string;
  /** OS identifier (e.g. 'linux', 'darwin', 'win32'). */
  os: string;
  /** Optional user-provided custom instructions appended at the end. */
  customInstructions?: string;
  /** Tool names actually registered in the runtime. Falls back to mode defaults. */
  availableTools?: string[];
  /** Optional user memory prompt string (from UserMemory.toPromptString()). */
  memoryPrompt?: string;
  /** Optional workspace memory prompt string (from WorkspaceMemory.toPromptString()). */
  workspaceMemoryPrompt?: string;
  /** Optional enabled skills for the execute_skill tool. */
  enabledSkills?: Skill[];
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/** Role definition — the persona and primary directive. */
function buildRoleSection(mode: ModeConfig): string {
  return [
    '## Role',
    '',
    mode.role,
    '',
    `You are operating in **${mode.name}** mode.`,
  ].join('\n');
}

/** Available tools — flat list derived from the mode's tool groups. */
function buildToolsSection(
  mode: ModeConfig,
  availableTools?: string[],
): string {
  const modeTools = getToolsForMode(mode);
  const tools = availableTools
    ? modeTools.filter((t) => availableTools.includes(t))
    : modeTools;

  if (tools.length === 0) {
    return [
      '## Available Tools',
      '',
      'You have no tools available in this mode.',
      'Respond with text only.',
    ].join('\n');
  }

  const lines = ['## Available Tools', ''];
  for (const tool of tools) {
    const display = TOOL_DISPLAY_NAMES[tool as ToolName] ?? tool;
    lines.push(`- **${tool}** — ${display}`);
  }
  return lines.join('\n');
}

/** Per-group usage guidelines. */
function buildToolGuidelines(mode: ModeConfig): string {
  const lines = ['## Tool Use Guidelines', ''];

  const guidelines: Partial<Record<string, string[]>> = {
    read: [
      'Use read tools to understand the codebase before making changes.',
      'Always check existing patterns and conventions before editing.',
      'When searching, prefer `search_files` over reading files one by one.',
    ],
    write: [
      'Prefer `edit_file` for targeted changes; use `write_to_file` for new files or full rewrites.',
      'Preserve existing code style (indentation, naming, imports).',
      'Include only the lines that changed — avoid rewriting entire files when a small edit suffices.',
    ],
    execute: [
      'Explain what each command does before running it.',
      'Prefer non-interactive commands; avoid commands that require user input.',
      'Set a reasonable timeout for long-running commands.',
    ],
  };

  for (const group of mode.toolGroups) {
    const groupGuidelines = guidelines[group];
    if (groupGuidelines && groupGuidelines.length > 0) {
      lines.push(`### ${group.charAt(0).toUpperCase() + group.slice(1)} tools`);
      lines.push('');
      for (const g of groupGuidelines) {
        lines.push(`- ${g}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Environment context — OS, workspace, shell hints. */
function buildEnvironmentSection(
  workspacePath: string,
  os: string,
): string {
  const osName = formatOsName(os);
  return [
    '## Environment',
    '',
    `- **OS:** ${osName}`,
    `- **Workspace:** ${workspacePath}`,
    '',
    'All file paths are relative to the workspace root unless stated otherwise.',
  ].join('\n');
}

/** Output format instructions — how to structure responses. */
function buildOutputFormatSection(): string {
  return [
    '## Output Format',
    '',
    '- Use Markdown for structured output.',
    '- Wrap code blocks with the appropriate language tag.',
    '- Be concise and technical — skip pleasantries.',
    '- When presenting a change, briefly explain *what* changed and *why*.',
    '- When finishing a task, summarize the result clearly.',
  ].join('\n');
}

/** Custom instructions — user-supplied directives appended last. */
function buildCustomInstructionsSection(
  customInstructions?: string,
): string {
  if (!customInstructions || customInstructions.trim().length === 0) {
    return '';
  }
  return [
    '## Custom Instructions',
    '',
    customInstructions.trim(),
  ].join('\n');
}

/** User memories — persistent preferences, instructions, corrections, context. */
function buildMemorySection(memoryPrompt?: string): string {
  if (!memoryPrompt || memoryPrompt.trim().length === 0) {
    return '';
  }
  return memoryPrompt.trim();
}

/** Workspace memory — project-scoped key-value entries. */
function buildWorkspaceMemorySection(workspaceMemoryPrompt?: string): string {
  if (!workspaceMemoryPrompt || workspaceMemoryPrompt.trim().length === 0) {
    return '';
  }
  return workspaceMemoryPrompt.trim();
}

/** Available skills — list enabled skills and the execute_skill tool. */
function buildSkillsSection(enabledSkills?: Skill[]): string {
  if (!enabledSkills || enabledSkills.length === 0) {
    return '';
  }

  const lines = ['## Available Skills', ''];

  lines.push(
    'You have access to specialized skills that can perform focused tasks.',
    'Use the `execute_skill` tool with the skill ID and relevant input when a skill matches the user\'s request.',
    '',
  );

  for (const skill of enabledSkills) {
    lines.push(`### ${skill.icon} ${skill.name}`);
    lines.push(skill.description);
    lines.push(`Category: ${skill.category} | Tags: ${skill.tags.join(', ')}`);
    lines.push('');
  }

  lines.push(
    'To use a skill, invoke the `execute_skill` tool with the skill ID and relevant input.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatOsName(osId: string): string {
  switch (osId) {
    case 'linux':
      return 'Linux';
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    default:
      return osId;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete system prompt for the given mode and environment.
 *
 * The prompt is assembled from discrete sections so it's easy to test
 * and extend without touching a single monolithic template string.
 */
export function generateSystemPrompt(options: SystemPromptOptions): string {
  const { mode, workspacePath, os, customInstructions, availableTools, memoryPrompt, workspaceMemoryPrompt, enabledSkills } =
    options;

  const sections: string[] = [
    buildRoleSection(mode),
    buildToolsSection(mode, availableTools),
    buildToolGuidelines(mode),
    buildSkillsSection(enabledSkills),
    buildMemorySection(memoryPrompt),
    buildWorkspaceMemorySection(workspaceMemoryPrompt),
    buildEnvironmentSection(workspacePath, os),
    buildOutputFormatSection(),
    buildCustomInstructionsSection(customInstructions),
  ].filter((s) => s.length > 0);

  return sections.join('\n\n');
}

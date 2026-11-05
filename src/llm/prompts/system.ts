/**
 * Dynamic system prompt generator — creates mode-specific prompts
 * tailored to the current operating mode, environment, and tool access.
 *
 * Composed from small section builders (role, tools, memory, skills, delegation) that
 * are joined per call. Pure TypeScript, no VS Code dependency.
 */

import type { ModeConfig } from '../modes';
import { getToolsForMode } from '../modes';
import { TOOL_DISPLAY_NAMES, type ToolName } from '../tools/types';
import type { Skill } from '../../shared/skillTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for generating a system prompt. */
export interface SystemPromptOptions {
  /** Allow the AI to suggest delegating work to an external coding agent. */
  suggestDelegation?: boolean;
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
  /** Optional cached repository + work-item understanding block (from UnderstandingService.toPromptString()). */
  understanding?: string;
  /** Optional live session to-do list (from TodoStore.toPromptString()). */
  todos?: string;
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

  // Mode-independent guidance: the model must know it can batch independent
  // calls and that disjoint edits to one file collapse into a single call —
  // otherwise providers+loops that accept parallel tool calls never get used,
  // and every edit costs a round-trip.
  lines.push(
    '- Independent tool calls belong in the SAME request — they run in parallel. Wait for a result only when the next call depends on it.',
    '- Batch by parameter: disjoint changes to one file → one `edit_file` with `edits`; several work items → `get_work_item` `ids`; several commands → `run_terminal_command` `commands` (in order, outputs concatenated); several files → `read_file` `paths` (max 10).',
    '- An `add_comment` that restates a description or acceptance criteria is dropped — comment only NEW findings, decisions and results. Acceptance criteria go to `create_work_item` as `acceptanceCriteria`, never inside its description.',
    '',
  );

  const guidelines: Record<string, string[]> = {
    todo: [
      'When the objective is clear and the work is more than a trivial one-step change, record it with `set_goal` — ONE short outcome line that stays fixed. A DIFFERENT objective replaces it (its steps are archived); a reword of the same objective keeps the list.',
      'Then break that goal into steps with `update_todo_list` BEFORE you start working — always when the user asks for a plan, a multi-file change or a migration — and keep the list current as you go.',
      'The list is MERGED, not replaced: an item you leave out keeps its status, so send the full list with finished items marked `completed`.',
      'Exactly ONE item should be `in_progress` — the one you are working on right now. Flip it to `completed` in the SAME iteration you finish it, never batched at the end of the turn.',
      'New work mid-task is added as a new item instead of being done silently; an item that turns out to be unnecessary is dropped from the list, with the reason stated.',
      'Skip the goal and the list for a trivial single-step request (a question, one small edit) — do not create ceremony.',
    ],
    read: [
      'Orient on the directory structure and documentation FIRST — `list_workspace` maps the layout, and README.md, AGENTS.md, docs/ and package.json scripts are cheaper than source. The `Repository Understanding` block in the prompt already summarizes that layout: start from it and read the files it names only when a step needs them.',
      'Read lazily: a file under ~400 lines comes back in one `read_file` call, so do not slice it into ranges. Use startLine/endLine only for a large file where you need one section, and avoid reading many files up front — read what the current step actually needs.',
      'Check existing patterns and conventions before editing; prefer `search_files` over reading files one by one.',
      'Before a document set, call `list_doc_templates` (optionally with a templateId) to see which documents the template emits and which options it accepts.',
    ],
    write: [
      'Prefer `edit_file` for targeted changes; use `write_to_file` for new files or full rewrites.',
      'For a document set use `build_documentation` instead of hand-writing the tree: it runs the same scaffolder as the New Project wizard (Markdown with front matter, .md + .csv registers, project control, inputs/). Build first, then fill the Markdown in with `edit_file`; a note or a section added to an existing document is a normal `edit_file` — that is not a document set.',
      'Preserve existing code style (indentation, naming, imports). Include only the lines that changed — avoid rewriting entire files when a small edit suffices.',
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

/**
 * Documentation and artifact budget (ADO-27355). Generated files are
 * re-charged on every later turn, so the policy is stated once — and only for
 * a prompt whose tools can actually write files.
 */
function buildDocsPolicySection(hasWrite: boolean): string {
  if (!hasWrite) {
    return '';
  }
  return [
    '## Documentation and artifact budget',
    '',
    'Generated files are re-read on later turns, so documentation is a cost you are spending.',
    '',
    '- Extend an existing document instead of adding one — no `step-1-notes.md`, `summary-<id>.md` or other per-step/per-turn file.',
    '- Never write a .md file to record your own progress or findings: the chat, the to-do list and the work item are the record — answer in the response instead.',
    '- A multi-step change updates the ONE CHANGELOG entry (or the work item), not one file per step.',
    '- A document set is `build_documentation` only; that tree is owned by ADO Code and is garbage-collected.',
  ].join('\n');
}

/**
 * Worktree merge flow. Only emitted when the prompt actually carries the
 * worktree tools, so read-only/plan prompts never pay for it.
 */
function buildMergeFlowSection(hasWorktreeTools: boolean): string {
  if (!hasWorktreeTools) {
    return '';
  }
  return [
    '## Merging agent work',
    '',
    'Delegated runs work in isolated git worktrees on `feature/ADO-<id>` branches. Once a run has FINISHED (or the user asks for the merge), execute the flow yourself:',
    '',
    '1. `commit_worktree(runId)` — commit ALL changes in the run worktree. Finished runs only; tell the user before committing a failed run (`allowFailed`).',
    '2. `push_worktree(runId)` — pushes the branch; never force-pushes, never touches main/master. The run card reflects each step as `mergeStatus`.',
    '3. `create_pull_request(runId)` — refuses protected branches; report the PR link.',
    '4. `resolve_pr_conflicts(runId)` lists the conflicted files read-only — resolve them in `worktreePath`, then commit and push again.',
    '',
    'The runId comes from the finished run\'s output; when it is unknown, ask the user. If a step fails (rejected push, conflicts), stop and report the exact error instead of working around it.',
  ].join('\n');
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
    '',
    // Project-level instruction file (parity with the /delegate handoff,
    // which already says "Read and follow AGENTS.md…"). On-demand read keeps
    // its token cost out of every request/iteration when the file is absent.
    'If an `AGENTS.md` file exists at the workspace root, read it and honor it — it contains the project structure, build commands, conventions, and constraints you must respect.',
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
    '- **Always end your turn with a conclusion.** When your activity is done, close with a short final summary of what you did and the current state. Never stop right after a tool result without a closing message — the user should never see the chat end abruptly mid-work.',
    '- If you hand off work to an agent (`delegate_to_agent`) or start a long-running background task, say so explicitly: tell the user the run continues in the background (its progress streams in the agent panel and updates the run card in this chat) and that you will report the outcome when it completes.',
    '- If your response ends by offering the user a choice of next actions (e.g. "Want me to …?", "Should I … or …?"), append a fenced choice block at the very end — 2 to 6 short imperative options, no numbering or bullets:',
    '',
    '```choice',
    '{"question": "<the question>", "options": ["<option 1>", "<option 2>", "…"]}',
    '```',
    '',
    '  Keep the question readable in your text; do not repeat the options in prose.',
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

/**
 * Cached repository + work-item understanding (UnderstandingService). The
 * block carries its own header + staleness note, so it is embedded verbatim.
 */
function buildUnderstandingSection(understanding?: string): string {
  if (!understanding || understanding.trim().length === 0) {
    return '';
  }
  return understanding.trim();
}

/**
 * The live session to-do list. It carries its own header (todo discipline is
 * in the tool guidelines above), so it is embedded verbatim — this is what
 * keeps the model's plan visible across iterations and condensation.
 */
function buildTodoSection(todos?: string): string {
  if (!todos || todos.trim().length === 0) {
    return '';
  }
  return todos.trim();
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
/**
 * Delegation-suggestion section - opt-in via `chat.suggestDelegation`.
 * Teaches the model to propose handing a task to an external coding agent by
 * emitting a fenced `SUGGEST_DELEGATION` block that the webview renders as an
 * action card. Returns '' when disabled so the capability is never advertised.
 */
function buildDelegationSuggestionSection(enabled?: boolean): string {
  if (!enabled) return '';
  return [
    '## Delegating to external agents',
    '',
    'You may optionally suggest handing part of the work to an installed',
    'external coding agent (e.g. claude, codex, opencode, gemini). Only do this',
    'when the task is a good fit for a separate agent run - a large self-contained',
    'implementation, a long refactor, or work better suited to another agent.',
    'Emit the suggestion as a fenced block so the UI can render an action card:',
    '',
    '## SUGGEST_DELEGATION',
    '```json',
    '[{ "agent": "codex", "reason": "why this agent", "prompt": "full task instructions" }]',
    '```',
    '',
    'Keep the explanation in normal prose; the block is only for the machine-readable',
    'suggestion. Do not emit the block when you can complete the task yourself.',
  ].join('\n');
}

export function generateSystemPrompt(options: SystemPromptOptions): string {
  const { mode, workspacePath, os, customInstructions, availableTools, memoryPrompt, workspaceMemoryPrompt, understanding, todos, enabledSkills } =
    options;

  const toolNames = (availableTools ?? []).map((t) => String(t));

  // Static prefix first: those sections are byte-identical from turn to turn,
  // which is what provider prefix caching (Anthropic cache_control) hits.
  // Everything that varies per turn goes after them.
  const sections: string[] = [
    buildRoleSection(mode),
    buildToolsSection(mode, availableTools),
    buildToolGuidelines(mode),
    buildDocsPolicySection(toolNames.includes('write_to_file')),
    buildMergeFlowSection(toolNames.includes('commit_worktree')),
    buildEnvironmentSection(workspacePath, os),
    buildOutputFormatSection(),
    buildTodoSection(todos),
    buildSkillsSection(enabledSkills),
    buildMemorySection(memoryPrompt),
    buildWorkspaceMemorySection(workspaceMemoryPrompt),
    buildUnderstandingSection(understanding),
    buildCustomInstructionsSection(customInstructions),
    buildDelegationSuggestionSection(options.suggestDelegation),
  ].filter((s) => s.length > 0);

  return sections.join('\n\n');
}

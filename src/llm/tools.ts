import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { LlmTool } from './types';
import { Services } from '../services';
import { getSettings, getActiveOrg } from '../config/settings';
import { isCommandSessionApproved, terminalCommandKey, terminalCommandList } from './tool-approval-ui';
import { matchesToolPattern, matchesCommandPattern } from './consent';
import { countTokens } from './context/tokenCounter';
import type { AdoWorkItem, AdoComment } from '../ado/types';

// ── Tool-result size guard ────────────────────────────────────────────────
// Token optimization: a tool result is stored in the conversation and
// re-sent with EVERY agentic iteration (agentic.ts). Big results — whole
// file reads, long command output, full work-item threads — are the single
// biggest token driver on long turns. `capToolResult` trims the PAYLOAD to
// a token budget with a head+tail strategy and a truncation marker, so the
// model still sees the start, the end, and that output was cut. Kept O(1)
// budget across all iterations.

/** Default token budget for a single tool result fed back to the model. */
const TOOL_RESULT_TOKEN_BUDGET = 4000;
/** When truncating, how much of the budget goes to the HEAD (rest = tail). */
const TOOL_RESULT_HEAD_RATIO = 0.6;

/**
 * Cap a tool result string to roughly `budgetWidth` (default
 * TOOL_RESULT_TOKEN_BUDGET) tokens. Returns the text unchanged when it fits;
 * otherwise returns head + '\n…[truncated; omitted N chars]…\n' + tail.
 */
export function capToolResult(content: string, budgetWidth: number = TOOL_RESULT_TOKEN_BUDGET): string {
  if (!content) return content;
  const tokens = countTokens(content);
  if (tokens <= budgetWidth) return content;
  const headToks = Math.floor(budgetWidth * TOOL_RESULT_HEAD_RATIO);
  const tailToks = budgetWidth - headToks;
  // Convert token budget back to an approximate char budget (chars/token ≈ 4).
  const headChars = headToks * 4;
  const tailChars = tailToks * 4;
  const head = content.slice(0, headChars);
  const tail = content.length - tailChars > headChars ? content.slice(-tailChars) : '';
  const omitted = content.length - head.length - tail.length;
  return `${head}\n\n…[result truncated: ${omitted.toLocaleString()} chars / ~${(tokens - budgetWidth).toLocaleString()} tokens omitted; use a narrower range or targeted query for the rest]…${tail ? '\n\n' + tail : ''}`;
}

// ── Grep line truncation (pi parity) ───────────────────────────────────────
// Each search_files match line is capped at GREP_MAX_LINE_LENGTH chars with an
// explicit marker — mirrors pi's truncateLine(). Long minified/compiled lines
// are the main context blow-up on searches; capping per line keeps a hit useful
// without flooding the conversation.

/** Max chars returned for a single search_files match line. */
export const GREP_MAX_LINE_LENGTH = 500;
/** Default max matches for search_files. */
export const DEFAULT_SEARCH_RESULTS = 100;
/** Absolute ceiling for search_files matches. */
export const MAX_SEARCH_RESULTS = 200;
/** Max files scanned by one search_files call (bounds read cost). */
export const MAX_SEARCH_FILES = 400;
/** Default exclusion glob for search_files (mirrors list_workspace). */
export const SEARCH_EXCLUDE_GLOB = '**/{node_modules,.git,dist,.vscode,out}/**';

/**
 * Truncate a single match line to fit within `maxChars`, adding an explicit
 * marker so the model knows the line was cut (pi: truncateLine).
 */
export function truncateMatchLine(line: string, maxChars: number = GREP_MAX_LINE_LENGTH): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)}... [truncated]`;
}

/** A single grep hit: relative path + 1-indexed line number + (truncated) text. */
export interface GrepLineHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Scan UTF-8 text line-by-line for regex hits (pure — unit-testable).
 * Safe for global/sticky regexes: resets lastIndex per line so `g`-flagged
 * patterns can't skip lines.
 */
export function grepLines(
  text: string,
  re: RegExp,
  truncate: number = GREP_MAX_LINE_LENGTH,
): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i]!)) {
      hits.push({ line: i + 1, text: truncateMatchLine(lines[i]!, truncate) });
    }
  }
  return hits;
}

/**
 * Grep over workspace files as URIs: reads each file, sniffs binary, scans
 * with grepLines, stops once `limit` hits are collected. Failures on
 * individual files (deleted mid-scan, permission) are skipped, never fatal.
 */
async function collectGrepMatches(
  uris: readonly vscode.Uri[],
  re: RegExp,
  limit: number,
  toRel: (uri: vscode.Uri) => string,
): Promise<GrepLineHit[]> {
  const out: GrepLineHit[] = [];
  for (const uri of uris) {
    if (out.length >= limit) break;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await vscode.workspace.fs.readFile(uri));
    } catch {
      continue; // disappeared / unreadable — skip, don't kill the search
    }
    // Null byte in the sample ⇒ binary ⇒ skip (regex on binary is garbage).
    const sample = buffer.subarray(0, Math.min(buffer.length, 512));
    if (sample.includes(0)) continue;
    const hits = grepLines(buffer.toString('utf8'), re);
    const rel = toRel(uri);
    for (const h of hits) {
      if (out.length >= limit) break;
      out.push({ path: rel, line: h.line, text: h.text });
    }
  }
  return out;
}


export interface ToolExecutor {
  tools: LlmTool[];
  /** Q8: current tool-use mode — inline (approval on mutating), plan (read-only), act (auto-approve), yolo (auto-approve everything). */
  mode: 'inline' | 'plan' | 'act' | 'yolo';
  setMode(mode: 'inline' | 'plan' | 'act' | 'yolo'): void;
  /** Reset per-turn state (e.g. consent-denied flag) at the start of a turn. */
  beginTurn(): void;
  execute(name: string, args: Record<string, any>): Promise<string>;
  /**
   * Predict whether execute(name, args) would run WITHOUT prompting the user
   * (read-only, yolo/auto-approved, allowlisted, or blocked-without-consent).
   * The agentic loop uses this to choose parallel batch execution vs
   * sequential: a batch containing a consent-requiring call runs sequentially
   * so approval cards appear one at a time (pi parity).
   */
  canAutoExecute(name: string, args: Record<string, any>): boolean;
}

// Q8: read-only tools are always allowed (inline/plan/act).
// search_files = pure grep (no mutation); execute_skill loads skill
// instructions for the model to follow (no side effects of its own).
const READ_ONLY_TOOLS = new Set(['get_work_items', 'get_work_item', 'read_file', 'search_files', 'get_selection', 'list_workspace', 'read_workspace_memory', 'list_workspace_memory', 'execute_skill', 'resolve_pr_conflicts']);
// Q8: mutating tools need approval in inline mode; auto-approved in act mode;
// BLOCKED in plan mode (plan must never change state).
const MUTATING_TOOLS = new Set(['update_work_item_state', 'add_comment', 'create_work_item', 'delegate_to_agent', 'apply_diff', 'edit_file', 'run_terminal_command', 'write_to_file', 'write_workspace_memory', 'set_memory', 'commit_worktree', 'push_worktree', 'create_pull_request']);

// ── Consent gate (pi parity: split gating from execution) ──────────────────
// The mode/consent decision is shared between execute() (which prompts on
// 'prompt') and canAutoExecute() (which only tests). Keeping it in ONE place
// guarantees the parallel/sequential decision can never disagree with an
// actual execution.

/** Result of the mode/consent gate for a single tool call. */
type GateAction =
  | { action: 'run' }                       // executes now, no user interaction
  | { action: 'prompt' }                    // needs the approval hook
  | { action: 'block'; error: string };     // rejected without prompting

/**
 * Mode + consent gating WITHOUT executing. Side-effect-free apart from
 * reading settings and session-approval cache.
 */
function gateTool(
  name: string,
  args: Record<string, any>,
  state: { mode: 'inline' | 'plan' | 'act' | 'yolo'; deniedKeys: Set<string> },
  hooks: { onApprove?: (name: string, args: Record<string, any>) => Promise<boolean> },
): GateAction {
  // ── Q8 mode gating ────────────────────────────────────────────────
  if (state.mode === 'plan' && !READ_ONLY_TOOLS.has(name)) {
    return { action: 'block', error: `tool '${name}' is not read-only and not allowed in plan mode` };
  }
  if (!MUTATING_TOOLS.has(name)) {
    return { action: 'run' };
  }
  if (state.mode === 'plan') {
    return { action: 'block', error: `tool '${name}' is mutating and not allowed in plan mode` };
  }
  // YOLO mode: skip ALL consent — auto-approve every tool including
  // terminal commands. No allowlist, no prompt. User chose full autonomy.
  if (state.mode === 'yolo') {
    return { action: 'run' };
  }
  // Wildcard permission: tools matching adoCode.consent.autoApproveTools
  // patterns (e.g. "read_*", "get_*") skip ALL consent — no prompt,
  // no terminal allowlist. Read fresh so edits apply without a restart.
  const autoApproveTools = vscode.workspace.getConfiguration('adoCode').get<string[]>('consent.autoApproveTools', []);
  const toolAutoApproved = matchesToolPattern(name, autoApproveTools);
  // C3 fix: inline mode REQUIRES an approval hook. If none is wired, DENY —
  // never silently execute a mutating tool.
  if (state.mode === 'inline' && !toolAutoApproved) {
    if (!hooks?.onApprove) {
      return { action: 'block', error: `tool '${name}' requires approval, but no approval hook is wired` };
    }
    // After one denial, re-prompting the SAME command/tool is pointless —
    // deny it silently for the rest of the turn. A NEW command or tool still
    // pops a consent card (the user may allow it). Terminal commands key by
    // the exact command string (single or batch-joined) so a NEW command in
    // a batch still prompts.
    const denyKey = name === 'run_terminal_command'
      ? `run_terminal_command:${terminalCommandKey(args)}`
      : name;
    if (state.deniedKeys.has(denyKey)) {
      return { action: 'block', error: `tool '${name}' rejected by user (denied earlier this turn)` };
    }
    return { action: 'prompt' };
  }
  // C3 fix: act mode still enforces the terminal allowlist on
  // run_terminal_command (tokenized, operator-free — see helper below).
  // Commands not in the allowlist are routed through the approval hook so
  // the user can allow once, per-session, or permanently. Allowlist entries
  // support wildcards: "git *" permits any git subcommand.
  if (name === 'run_terminal_command' && state.mode === 'act' && !toolAutoApproved) {
    const allowlist = vscode.workspace.getConfiguration('adoCode').get<string[]>('act.terminalAllowlist', ['npm test', 'npm run lint', 'git diff', 'git status']);
    // Single OR batch: EVERY command must pass the allowlist / session cache.
    const commands = terminalCommandList(args);
    if (!commands.every(c => matchesCommandPattern(c, allowlist))) {
      // Check session cache first (user chose "Allow for Session" earlier)
      if (!commands.every(c => isCommandSessionApproved(c))) {
        // Not in allowlist and not session-approved — ask user
        if (!hooks?.onApprove) {
          return { action: 'block', error: `command not allowed in act mode (allowlist + no shell operators): ${commands.join('; ')}` };
        }
        if (state.deniedKeys.has(`run_terminal_command:${terminalCommandKey(args)}`)) {
          return { action: 'block', error: `command rejected by user: ${commands.join('; ')} (denied earlier this turn)` };
        }
        return { action: 'prompt' };
      }
    }
  }
  return { action: 'run' };
}

// ── Per-file mutation serialization (pi parity) ────────────────────────────
// Parallel agentic batches may contain several mutations to the SAME file.
// Read-modify-write on one file must never interleave; mutations to
// DIFFERENT files still run concurrently.
const fileMutationQueues = new Map<string, Promise<unknown>>();
function withFileMutationQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileMutationQueues.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // Store a never-rejecting tail so a failed op doesn't poison the chain.
  fileMutationQueues.set(key, run.catch(() => undefined));
  return run;
}

/**
 * Apply ordered edits to file text (pi parity: one `edit_file` call for
 * several disjoint changes). Each entry's oldText must be present at the
 * time it is applied — later edits match against progressively updated
 * text. Throws loudly on the first miss so a partial application never
 * silently succeeds (C5).
 */
export function applyOrderedEdits(text: string, edits: Array<{ oldText?: string; newText?: string }>): string {
  let updated = text;
  for (const e of edits) {
    if (!e.oldText || !updated.includes(e.oldText)) {
      throw new Error(`oldText not found: ${String(e.oldText ?? '').slice(0, 120)}`);
    }
    updated = updated.replace(e.oldText, e.newText ?? '');
  }
  return updated;
}

export function createToolExecutor(
  services: Services,
  context: vscode.ExtensionContext, // M4: for getActiveOrg (workspaceState)
  hooks?: {
    onDelegate?: (prompt: string, agent?: string) => Promise<string>;
    onUpdateState?: (id: number, state: string) => Promise<void>;
    onApprove?: (name: string, args: Record<string, any>) => Promise<boolean>;
    // Merge flow for finished agent runs (wired by ChatViewProvider).
    onCommitWorktree?: (runId: string, message: string, allowFailed?: boolean) => Promise<{ committed: boolean; reason?: string; hash?: string }>;
    onPushWorktree?: (runId: string) => Promise<{ pushed: boolean; branch?: string; reason?: string }>;
    onCreatePullRequest?: (runId: string, title?: string, description?: string) => Promise<{ pullRequestId: number; url: string; mergeStatus?: string }>;
    /** Conflict surfacing: fetch conflicted files (base/our/their) for a run's PR. */
    onResolvePrConflicts?: (runId: string) => Promise<Array<{ path: string; worktreePath: string; base?: string; ours?: string; theirs?: string; truncated?: boolean }>>;
    /** Create work item with editor-tab preview + confirmation before ADO write. */
    onCreateWorkItem?: (args: { workItemType: string; title: string; description?: string; acceptanceCriteria?: string; assignedTo?: string; tags?: string; parentWorkItemId?: number }) => Promise<{ id: number; url: string } | null>;
  }
): ToolExecutor {
  // M-6 fix: mode lives on `state` (mutated by setMode) — no closure var.
  // `deniedKeys` = per-turn set of consent denials, keyed so a NEW command or
  // tool still prompts: terminal commands by exact command string, other
  // mutating tools by tool name.
  const state = { mode: 'inline' as 'inline' | 'plan' | 'act' | 'yolo', deniedKeys: new Set<string>() };
  const allTools: LlmTool[] = [
    {
      name: 'get_work_items',
      description: 'List open work items assigned to the current user in Azure DevOps',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_work_item',
      description: 'Get details (description, acceptance criteria, comments) of one or more work items. For SEVERAL items, pass ALL ids in the `ids` array — ONE call instead of repeated ones (max 20 per call).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Work item ID (single fetch)' },
          ids: { type: 'array', items: { type: 'number' }, description: 'Batch fetch: multiple work item IDs to fetch in this one call' },
        },
      },
    },
    {
      name: 'update_work_item_state',
      description: "Change a work item's state (e.g. Active, Resolved, Done, Closed)",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          state: { type: 'string', description: 'New state' },
        },
        required: ['id', 'state'],
      },
    },
    {
      name: 'add_comment',
      description: 'Add a comment to a work item discussion thread',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    },
    {
      name: 'create_work_item',
      description: 'Create a new Azure DevOps work item (Task, Bug, Test Case, etc.) under a parent',
      parameters: {
        type: 'object',
        properties: {
          workItemType: { type: 'string', description: 'Work item type (Task, Bug, Test Case, etc.)' },
          title: { type: 'string', description: 'Work item title' },
          description: { type: 'string', description: 'Description or details' },
          acceptanceCriteria: { type: 'string', description: 'Acceptance criteria' },
          parentWorkItemId: { type: 'number', description: 'Parent work item ID (to create under)' },
          assignedTo: { type: 'string', description: 'Assign to (email or display name)' },
          tags: { type: 'string', description: 'Tags (comma-separated)' },
        },
        required: ['workItemType', 'title'],
      },
    },
    {
      name: 'delegate_to_agent',
      description: 'Hand a coding task to an installed external agent CLI; returns the agent output',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Full task instructions for the agent' },
          agent: { type: 'string', description: 'Agent name (claude, codex, opencode, hermes, pi, openclaw, aider, gemini, cursor-agent, dsh); omit for auto-pick' },
        },
        required: ['prompt'],
      },
    },
    // ── Merge flow: commit / push / PR for a finished agent run's worktree ──
    {
      name: 'commit_worktree',
      description: "Commit ALL changes in a finished agent run's worktree. After the agent finishes, so its work is preserved. Never touches main. Set allowFailed to commit a failed-verification run deliberately.",
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run id of the finished agent run (from the agent output)' },
          message: { type: 'string', description: 'Commit message; omit to default to ADO <id> + work item title' },
          allowFailed: { type: 'boolean', description: 'Set true to commit a run whose verification FAILED (e.g. adapter crashed with no code changes). Omit for succeeded runs.' },
        },
        required: ['runId'],
      },
    },
    {
      name: 'push_worktree',
      description: 'Push an agent run\'s worktree branch to origin (never force-pushes, never pushes main/master). Call AFTER commit_worktree.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run id of the finished agent run' },
        },
        required: ['runId'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create an ADO pull request from an agent run branch into the base branch. Call AFTER push_worktree. Refuses protected branches.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run id of the finished agent run' },
          title: { type: 'string', description: 'PR title; omit to default to ADO <id> + work item title' },
          description: { type: 'string', description: 'PR description (summary of the changes)' },
        },
        required: ['runId'],
      },
    },
    {
      name: 'resolve_pr_conflicts',
      description: 'List conflicted files (base/our/their) for a run whose PR reports conflicts. READ-ONLY; resolve via edit_file/apply_diff on the worktreePath, then commit_worktree + push_worktree again.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run id of the finished agent run whose PR conflicts' },
        },
        required: ['runId'],
      },
    },
    // ── Q3 resolution: code tools ─────────────────────────────────────────
    {
      name: 'read_file',
      description: 'Read a workspace file or a line range (startLine/endLine). Without a range, long files return only their first 200 lines with a truncation note. Prefer narrow ranges or search_files over whole files — every read stays in the conversation context for the session.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_files',
      description: 'Grep a workspace file/directory for a regex; returns up to `limit` matches as path:line text (per-line truncated to 500 chars). READ-ONLY. Prefer this over reading whole files when locating code.',
      parameters: {
        type: 'object',
        properties: {
          regex: { type: 'string', description: 'Regular expression to search for (engine: VS Code/JS regex)' },
          path: { type: 'string', description: 'Workspace-relative file or directory to restrict the search to (optional; default: whole workspace)' },
          file_pattern: { type: 'string', description: 'Glob to restrict files, e.g. "src/**/*.ts", "*.test.ts" (takes precedence over path)' },
          limit: { type: 'number', description: 'Max matches to return (default 100, max 200)' },
        },
        required: ['regex'],
      },
    },
    {
      name: 'get_selection',
      description: 'Return the text currently selected in the active editor',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_workspace',
      description: 'Map the workspace structure: list files (optionally filtered by a glob like `src/**/*.ts`; capped at 500 entries). Use this to see directory layout before reading files.',
      parameters: {
        type: 'object',
        properties: { glob: { type: 'string', description: 'e.g. src/**/*.ts' } },
      },
    },
    {
      name: 'apply_diff',
      description: 'Apply a unified diff to a workspace file (mutating)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          diff: { type: 'string', description: 'Unified diff text' },
        },
        required: ['path', 'diff'],
      },
    },
    {
      name: 'edit_file',
      description: 'Replace text in a workspace file (mutating). For several disjoint changes to the SAME file, pass them as one call with the edits array instead of separate calls.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string', description: 'Exact text to replace (required when edits is omitted)' },
          newText: { type: 'string', description: 'Replacement text (required when edits is omitted)' },
          edits: {
            type: 'array',
            description: 'Batch of independent replacements in one call; applied in order. Use this for multiple disjoint edits to the same file.',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text to find' },
                newText: { type: 'string', description: 'Replacement text' },
              },
              required: ['oldText', 'newText'],
            },
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'run_terminal_command',
      description: 'Run a shell command in the workspace (mutating; restricted in act mode). For several quick commands, pass the `commands` array — ONE call runs them all in order (outputs concatenated) instead of repeated calls.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Single command to run' },
          commands: { type: 'array', items: { type: 'string' }, description: 'Batch: commands to run in this one call (each is still checked for shell operators)' },
        },
      },
    },
    {
      name: 'write_to_file',
      description: 'Create or overwrite a file in the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'restore_checkpoint',
      description: 'Restore workspace files to a previously saved checkpoint state (undo AI edits)',
      parameters: {
        type: 'object',
        properties: {
          checkpointId: { type: 'string', description: 'Checkpoint ID to restore' },
          taskId: { type: 'string', description: 'Task ID the checkpoint belongs to' },
        },
        required: ['checkpointId', 'taskId'],
      },
    },
    {
      name: 'set_memory',
      description: 'Store a user memory (preference, instruction, correction, or context) that persists across sessions and is injected into future conversations',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique key for this memory (e.g. "code_style", "no_semicolons")' },
          category: { type: 'string', enum: ['preference', 'instruction', 'correction', 'context'], description: 'Memory category' },
          content: { type: 'string', description: 'The memory content to store' },
        },
        required: ['key', 'category', 'content'],
      },
    },
    {
      name: 'execute_skill',
      description: 'Load a skill\'s instructions (prompt/knowledge) plus your input so you can carry them out. READ-ONLY — returns the skill content for you to follow, it does not run anything itself.',
      parameters: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: 'Skill ID (see Available Skills in the system prompt)' },
          input: { type: 'string', description: 'Task input/context to combine with the skill instructions' },
        },
        required: ['skillId', 'input'],
      },
    },
    // ── Workspace memory tools ──────────────────────────────────────
    {
      name: 'read_workspace_memory',
      description: 'Read a workspace-scoped memory entry by key',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Memory key to read' } },
        required: ['key'],
      },
    },
    {
      name: 'write_workspace_memory',
      description: 'Write or overwrite a workspace-scoped memory entry (key-value store under .ado-code/memory/)',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          value: { type: 'string', description: 'Content to store' },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'list_workspace_memory',
      description: 'List all workspace memory keys',
      parameters: { type: 'object', properties: {} },
    },
  ];

  const settings = getSettings();
  // M4 fix: don't capture `project` once — resolve the ACTIVE project per
  // execute() so an org switch (Q1) takes effect without recreating the executor.
  const activeProject = () => getActiveOrg(context, settings).project;

  /**
   * Return the tool schemas relevant to the current mode. Plan mode is
   * read-only, so sending ONLY read-only tools saves per-request tokens and
   * reduces the chance of the model attempting a blocked tool. Other modes
   * send the full set.
   */
  const filteredTools = (): LlmTool[] =>
    state.mode === 'plan'
      ? allTools.filter(t => READ_ONLY_TOOLS.has(t.name))
      : allTools;

  return {
    get tools() { return filteredTools(); },
    // M-6 fix: mode lives on a mutable `state` object — the closure var would
    // leave the exported property stale after setMode. Reads/writes go through
    // `state.mode`.
    get mode() { return state.mode; },
    setMode(m: 'inline' | 'plan' | 'act') { state.mode = m; },
    // New turn → the user can be asked again (a previous turn's denials must
    // not lock this turn out of consent prompts).
    beginTurn() { state.deniedKeys.clear(); },
    canAutoExecute(name, args) {
      // Read-only, yolo/auto-approved, allowlisted, or block-without-consent
      // calls run without user interaction → safe to parallelize. Calls that
      // would pop a consent card must stay sequential (one card at a time).
      return gateTool(name, args, state, { onApprove: hooks?.onApprove }).action !== 'prompt';
    },
    async execute(name, args) {
      // ── Q8 mode + consent gate ─────────────────────────────────────
      // Runs FIRST — before any project/ADO resolution — so blocked tools are
      // rejected even without a workspace (and security checks can't crash).
      // Gating logic lives in gateTool() and is shared with canAutoExecute()
      // so the parallel/sequential decision can never disagree with execution.
      const gate = gateTool(name, args, state, { onApprove: hooks?.onApprove });
      if (gate.action === 'block') {
        return JSON.stringify({ error: gate.error });
      }
      if (gate.action === 'prompt') {
        // Gate guarantees onApprove exists for 'prompt', but re-check so a
        // vanished hook degrades to a crisp error instead of a crash (C3).
        const approve = hooks?.onApprove;
        if (!approve) {
          return JSON.stringify({ error: `tool '${name}' requires approval, but no approval hook is wired` });
        }
        const denyKey = name === 'run_terminal_command'
          ? `run_terminal_command:${terminalCommandKey(args)}`
          : name;
        const ok = await approve(name, args);
        if (!ok) {
          state.deniedKeys.add(denyKey);
          return JSON.stringify({ error: `tool '${name}' rejected by user` });
        }
      }
      // M4 fix: resolve the ACTIVE project lazily — only ADO-bound tools need
      // it, and org switches (Q1) take effect per-execute without recreating
      // the executor.
      // Auto-checkpoint before file mutations
      if (['edit_file', 'write_to_file', 'apply_diff'].includes(name) && args.path) {
        try {
          services.checkpoints.save('__auto__', [args.path]);
        } catch { /* best-effort */ }
      }
      const project = activeProject();
      try {
        switch (name) {
        case 'get_work_items': {
          const items = await services.ado.getWorkItemsAssignedTo(project);
          return JSON.stringify(items.map(i => ({ id: i.id, title: i.fields['System.Title'], state: i.fields['System.State'], type: i.fields['System.WorkItemType'] })));
        }
        case 'get_work_item': {
          // Single (`id`) OR batch (`ids`) — the batch path replaces N
          // repeated calls with one: details via the by-ids endpoint (chunked
          // internally), comments fetched per item in parallel.
          const ids: number[] = [];
          if (Array.isArray(args.ids)) {
            for (const raw of args.ids) {
              const n = Number(raw);
              if (Number.isFinite(n) && n > 0) ids.push(n);
            }
          }
          if (args.id != null && Number.isFinite(Number(args.id))) ids.unshift(Number(args.id));
          const batch = Array.isArray(args.ids);
          if (ids.length === 0) {
            return JSON.stringify({ error: 'get_work_item: provide id or ids' });
          }
          const wanted = ids.slice(0, 20);
          const byId = new Map<number, AdoWorkItem>();
          for (const wi of await services.ado.getWorkItemsByIds(wanted)) {
            byId.set(wi.id, wi);
          }
          const items = await Promise.all(wanted.map(async (id): Promise<Record<string, unknown>> => {
            const detail = byId.get(id);
            if (!detail) return { id, error: `work item ${id} not found` };
            let comments: AdoComment[] = [];
            try {
              comments = await services.ado.getComments(project, id);
            } catch {
              // Comments are a nice-to-have; one failing thread must not sink
              // the whole batch.
            }
            return {
              id: detail.id,
              title: detail.fields['System.Title'],
              state: detail.fields['System.State'],
              description: capToolResult(String(detail.fields['System.Description'] ?? ''), 1500),
              acceptanceCriteria: capToolResult(String(detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? ''), 800),
              tags: detail.fields['System.Tags'],
              thread: (comments ?? []).slice(0, 20).map(c => ({ author: c.createdBy?.displayName ?? '?', text: capToolResult(String(c.text ?? ''), 400) })),
            };
          }));
          // `id` alone → the same single-object shape as before; `ids` → array.
          const payload = batch ? items : items[0];
          return capToolResult(JSON.stringify(payload));
        }
        case 'update_work_item_state':
          // Route through the ChatViewProvider hook so the changelog completion
          // flow (Task 11) fires on Done/Closed. Fallback: direct ADO PATCH.
          if (hooks?.onUpdateState) {
            await hooks.onUpdateState(args.id, args.state);
          } else {
            await services.ado.updateWorkItem(project, args.id, [
              { op: 'add', path: '/fields/System.State', value: args.state },
            ]);
          }
          return JSON.stringify({ ok: true, id: args.id, state: args.state });
        case 'add_comment': {
          const c = await services.ado.addComment(project, args.id, args.text);
          return JSON.stringify({ ok: true, commentId: c.id });
        }
        case 'create_work_item': {
          // Route through the editor-tab preview + confirmation hook so the
          // user can review/edit details before the work item is created in ADO.
          if (hooks?.onCreateWorkItem) {
            const result = await hooks.onCreateWorkItem({
              workItemType: args.workItemType,
              title: args.title,
              description: args.description,
              acceptanceCriteria: args.acceptanceCriteria,
              assignedTo: args.assignedTo,
              tags: args.tags,
              parentWorkItemId: args.parentWorkItemId ? Number(args.parentWorkItemId) : undefined,
            });
            if (!result) {
              return JSON.stringify({ cancelled: true, message: 'Work item creation cancelled by user' });
            }
            return JSON.stringify({ ok: true, id: result.id, url: result.url });
          }
          // Fallback: direct creation if no hook is wired (e.g. headless).
          const result = await services.ado.createWorkItem(project, args.workItemType, {
            title: args.title,
            description: args.description,
            acceptanceCriteria: args.acceptanceCriteria,
            assignedTo: args.assignedTo,
            tags: args.tags,
          }, args.parentWorkItemId ? Number(args.parentWorkItemId) : undefined);
          return JSON.stringify({ ok: true, id: result.id, url: result.url });
        }
        case 'delegate_to_agent':
          return hooks?.onDelegate
            ? await hooks.onDelegate(args.prompt, args.agent)
            : JSON.stringify({ error: 'agent delegation not wired' });
        case 'commit_worktree':
          return hooks?.onCommitWorktree
            ? JSON.stringify(await hooks.onCommitWorktree(String(args.runId ?? ''), String(args.message ?? ''), Boolean(args.allowFailed)))
            : JSON.stringify({ error: 'worktree commit not wired' });
        case 'push_worktree':
          return hooks?.onPushWorktree
            ? JSON.stringify(await hooks.onPushWorktree(String(args.runId ?? '')))
            : JSON.stringify({ error: 'worktree push not wired' });
        case 'create_pull_request':
          return hooks?.onCreatePullRequest
            ? JSON.stringify(await hooks.onCreatePullRequest(String(args.runId ?? ''), args.title ? String(args.title) : undefined, args.description ? String(args.description) : undefined))
            : JSON.stringify({ error: 'pull request creation not wired' });
        case 'resolve_pr_conflicts':
          return hooks?.onResolvePrConflicts
            ? JSON.stringify(await hooks.onResolvePrConflicts(String(args.runId ?? '')))
            : JSON.stringify({ error: 'conflict resolution not wired' });
        // ── Q3 code tools (implemented via VS Code APIs) ─────────────
        case 'read_file': {
          const uri = resolveWorkspacePath(args.path); // C4: path confinement
          const doc = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(doc).toString('utf8');
          const lines = text.split('\n');
          // Token optimization: reading a WHOLE file unbounded returns
          // thousands of tokens that persist across every loop iteration.
          // Default to a bounded window (still honoring explicit ranges) and
          // cap the returned payload to the tool-result token budget.
          const hasStart = args.startLine != null;
          const hasEnd = args.endLine != null;
          const start = hasStart ? Math.max(0, (args.startLine - 1)) : 0;
          let end = hasEnd ? args.endLine : lines.length;
          let note = '';
          if (!hasStart && !hasEnd && lines.length > 200) {
            end = 200;
            note = `\n\n…[read_file truncated: showing first ${end} of ${lines.length} lines; pass startLine/endLine to read a specific range]`;
          }
          return capToolResult(lines.slice(start, end).join('\n') + note);
        }
        case 'search_files': {
          // pi-parity grep with per-line truncation: locate code by regex
          // without dumping whole files into context.
          const query = String(args.regex ?? '');
          if (!query) {
            return JSON.stringify({ error: 'search_files: missing required parameter: regex' });
          }
          let re: RegExp;
          try {
            re = new RegExp(query);
          } catch (err) {
            return JSON.stringify({ error: `search_files: invalid regex: ${err instanceof Error ? err.message : String(err)}` });
          }
          const limit = typeof args.limit === 'number'
            ? Math.min(Math.max(Math.floor(args.limit), 1), MAX_SEARCH_RESULTS)
            : DEFAULT_SEARCH_RESULTS;
          // One include glob: file_pattern wins; else path (confinement-checked)
          // is narrowed to a file or directory glob; else the whole workspace.
          const filePattern = args.file_pattern ? String(args.file_pattern) : undefined;
          const searchPath = args.path ? String(args.path) : undefined;
          let include: string;
          if (filePattern) {
            // '*.ts' in findFiles globs means root-only; treat bare patterns as
            // recursive (pi/ripgrep semantics) unless they already carry a path.
            include = filePattern.includes('/') || filePattern.includes('**')
              ? filePattern
              : `**/${filePattern}`;
          } else if (searchPath) {
            const uri = resolveWorkspacePath(searchPath); // C4: path confinement
            include = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
            const lastSegment = include.split('/').pop() ?? '';
            // No extension in the last segment → treat as a directory prefix.
            if (!lastSegment.includes('.')) include += '/**';
          } else {
            include = '**/*';
          }

          const uris = await vscode.workspace.findFiles(include, SEARCH_EXCLUDE_GLOB, MAX_SEARCH_FILES);
          const matches = await collectGrepMatches(
            uris,
            re,
            limit,
            (uri) => vscode.workspace.asRelativePath(uri),
          );

          if (matches.length === 0) {
            return 'No matches found';
          }
          const body = matches
            .map((m) => `${m.path}:${m.line}  ${m.text}`)
            .join('\n');
          const header = `${matches.length} match(es) for /${query}/`;
          return capToolResult(`${header}\n${body}`);
        }
        case 'get_selection': {
          const editor = vscode.window.activeTextEditor;
          return editor ? editor.document.getText(editor.selection) : '';
        }
        case 'list_workspace': {
          // C4/M18: exclude .git, node_modules, dist, and common secret dirs
          const files = await vscode.workspace.findFiles(args.glob ?? '**/*', '**/{node_modules,.git,dist,.vscode}/**', 500);
          return capToolResult(JSON.stringify(files.map(f => vscode.workspace.asRelativePath(f))), 2000);
        }
        case 'write_to_file': {
          const uri = resolveWorkspacePath(args.path); // C4: path confinement
          const content = Buffer.from(args.content, 'utf8');
          await vscode.workspace.fs.writeFile(uri, content);
          return JSON.stringify({ ok: true, path: args.path, bytes: content.length });
        }
        case 'apply_diff':
        case 'edit_file': {
          const uri = resolveWorkspacePath(args.path); // C4: path confinement
          // pi-parity: mutations to the SAME file must serialize while
          // mutations to DIFFERENT files still run in parallel (batches).
          return withFileMutationQueue(uri.fsPath, async () => {
            const doc = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(doc).toString('utf8');
            let updated: string;
            if (name === 'edit_file') {
              // pi-parity: `edits` batches several disjoint changes into ONE
              // call (fewer round-trips + fewer tokens). C5: each replacement
              // must actually match — no silent no-op, fail loudly on the
              // first miss so a partial application never succeeds.
              const edits = Array.isArray(args.edits) && args.edits.length > 0
                ? (args.edits as Array<{ oldText?: string; newText?: string }>)
                : [{ oldText: args.oldText, newText: args.newText }];
              try {
                updated = applyOrderedEdits(text, edits);
              } catch (err) {
                return JSON.stringify({ error: `edit_file: ${err instanceof Error ? err.message : String(err)} (in ${args.path})` });
              }
            } else {
              updated = applyUnifiedDiff(text, args.diff);
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
            return JSON.stringify({ ok: true, path: args.path });
          });
        }
        case 'restore_checkpoint': {
          const restored = services.checkpoints.restore(args.checkpointId, args.taskId);
          return JSON.stringify({ ok: true, restored });
        }
        case 'run_terminal_command': {
          // C3 fix: execFile with arg array and NO shell — `sh -c` would give
          // full shell semantics and nullify the allowlist. Tokenize the
          // command and reject shell operators. C-2 fix: `\s` must NOT be in
          // the operator class (spaces are legal — allowlist entries like
          // `npm test` are multi-word); operators are the dangerous chars.
          // Batch (`commands` array) runs each command in order — same
          // checks, one call, concatenated outputs.
          const commands = terminalCommandList(args);
          if (commands.length === 0) {
            return JSON.stringify({ error: 'run_terminal_command: empty command' });
          }
          for (const cmd of commands) {
            if (!/^[^&|;`$<>()\r\n]*$/.test(cmd)) {
              return JSON.stringify({ error: `run_terminal_command: shell operators not allowed: ${cmd}` });
            }
          }
          const outputs: string[] = [];
          for (const cmd of commands) {
            const argv = cmd.match(/"[^"]*"|\S+/g) ?? [];
            if (!argv[0]) {
              return JSON.stringify({ error: 'run_terminal_command: no command to run' });
            }
            const result = await new Promise<string>((resolve) => {
              execFile(argv[0]!, argv.slice(1), { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, timeout: 120000 }, (err: any, stdout: any, stderr: any) => {
                resolve(stdout || stderr || (err?.message ?? ''));
              });
            });
            outputs.push(result);
          }
          const joined = commands.length > 1
            ? outputs.map((o, i) => `$ ${commands[i]}\n${o}`).join('\n\n')
            : (outputs[0] ?? '');
          return capToolResult(joined.slice(0, 8000));
        }
        case 'set_memory': {
          services.memory.set(args.key, args.category, args.content);
          return JSON.stringify({ ok: true, key: args.key, category: args.category });
        }
        case 'execute_skill': {
          // Pure loader: returns the skill's prompt/knowledge combined with the
          // model's input so the model can follow it (see SkillManager.executeSkill).
          const result = await services.skills.executeSkill({
            skillId: String(args.skillId ?? ''),
            input: String(args.input ?? ''),
          });
          return result.success
            ? result.output
            : JSON.stringify({ error: result.error ?? 'skill execution failed' });
        }
        case 'read_workspace_memory': {
          const val = services.workspaceMemory.read(args.key);
          if (val === null) {
            return JSON.stringify({ error: `key '${args.key}' not found in workspace memory` });
          }
          return JSON.stringify({ key: args.key, value: val });
        }
        case 'write_workspace_memory': {
          services.workspaceMemory.write(args.key, args.value);
          return JSON.stringify({ ok: true, key: args.key });
        }
        case 'list_workspace_memory': {
          const keys = services.workspaceMemory.list();
          return JSON.stringify(keys);
        }
        default:
          // MCP tools use the mcp__<server>__<tool> prefix convention
          if (name.startsWith('mcp__')) {
            return await services.mcp.callTool(name, args);
          }
          return JSON.stringify({ error: `unknown tool: ${name}` });
        }
      } catch (err) {
        // Agentic-loop safety: tool errors must come back as JSON text, not
        // unhandled rejections (a throw would kill the whole loop).
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

/** C4: resolve a workspace-relative path and refuse anything escaping the root. */
function resolveWorkspacePath(relativePath: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error('no workspace folder open');
  // M-8 fix: Uri.joinPath NORMALIZES `../` segments instead of leaving them
  // for the check — resolve the fsPath explicitly so escapes are detectable.
  const rootFs = path.resolve(root.uri.fsPath);
  const targetFs = path.resolve(path.join(rootFs, relativePath));
  const sep = path.sep;
  if (!(targetFs === rootFs || targetFs.startsWith(rootFs + sep))) {
    throw new Error(`path escapes workspace: ${relativePath}`);
  }
  return vscode.Uri.file(targetFs);
}

/** C5: minimal unified-diff application — hunk-line-aware, verified against source. */
function applyUnifiedDiff(source: string, diff: string): string {
  // Real production implementations should use the `diff` npm package; this
  // inline version handles the common case (single hunk with line numbers)
  // and FAILS LOUDLY instead of corrupting:
  const lines = source.split('\n');
  const hunks = diff.split(/(?=^@@)/m).filter(h => h.startsWith('@@'));
  if (hunks.length === 0) throw new Error('apply_diff: no hunks in diff');
  const result = [...lines];
  let offset = 0; // H-7: cumulative line shift from previously applied hunks
  for (const hunk of hunks) {
    const header = hunk.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) throw new Error('apply_diff: malformed hunk header');
    const body = hunk.split('\n').slice(1);
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of body) {
      if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) { added.push(line.slice(1)); }
      else if (line.startsWith(' ')) { removed.push(line.slice(1)); added.push(line.slice(1)); }
      else if (line.trim() === '') continue; // trailing blank
    }
    // H-7 fix: verify removed lines against the OLD-file position, and track a
    // running offset so MULTIPLE hunks apply cumulatively (each hunk's `-`
    // line numbers refer to the ORIGINAL file; result is mutated as we go).
    const oldStart = parseInt(header[1], 10) - 1;
    const applied = oldStart + offset;
    for (let i = 0; i < removed.length; i++) {
      if (result[applied + i] !== removed[i]) {
        throw new Error(`apply_diff: context mismatch at line ${applied + i + 1}`);
      }
    }
    result.splice(applied, removed.length, ...added);
    offset += added.length - removed.length;
  }
  return result.join('\n');
}

import * as vscode from 'vscode';
import { LlmTool } from './types';
import { Services } from '../services';
import { getSettings, getActiveOrg } from '../config/settings';
import { isCommandSessionApproved } from './tool-approval-ui';

export interface ToolExecutor {
  tools: LlmTool[];
  /** Q8: current tool-use mode — inline (approval on mutating), plan (read-only), act (auto-approve). */
  mode: 'inline' | 'plan' | 'act';
  setMode(mode: 'inline' | 'plan' | 'act'): void;
  /** Reset per-turn state (e.g. consent-denied flag) at the start of a turn. */
  beginTurn(): void;
  execute(name: string, args: Record<string, any>): Promise<string>;
}

// Q8: read-only tools are always allowed (inline/plan/act).
const READ_ONLY_TOOLS = new Set(['get_work_items', 'get_work_item', 'read_file', 'get_selection', 'list_workspace', 'read_workspace_memory', 'list_workspace_memory']);
// Q8: mutating tools need approval in inline mode; auto-approved in act mode;
// BLOCKED in plan mode (plan must never change state).
const MUTATING_TOOLS = new Set(['update_work_item_state', 'add_comment', 'delegate_to_agent', 'apply_diff', 'edit_file', 'run_terminal_command', 'write_to_file', 'write_workspace_memory', 'set_memory', 'commit_worktree', 'push_worktree', 'create_pull_request']);

export function createToolExecutor(
  services: Services,
  context: vscode.ExtensionContext, // M4: for getActiveOrg (workspaceState)
  hooks?: {
    onDelegate?: (prompt: string, agent?: string) => Promise<string>;
    onUpdateState?: (id: number, state: string) => Promise<void>;
    onApprove?: (name: string, args: Record<string, any>) => Promise<boolean>;
    // Merge flow for finished agent runs (wired by ChatViewProvider).
    onCommitWorktree?: (runId: string, message: string) => Promise<{ committed: boolean; reason?: string; hash?: string }>;
    onPushWorktree?: (runId: string) => Promise<{ pushed: boolean; branch?: string; reason?: string }>;
    onCreatePullRequest?: (runId: string, title?: string, description?: string) => Promise<{ pullRequestId: number; url: string }>;
  }
): ToolExecutor {
  // M-6 fix: mode lives on `state` (mutated by setMode) — no closure var.
  // `deniedKeys` = per-turn set of consent denials, keyed so a NEW command or
  // tool still prompts: terminal commands by exact command string, other
  // mutating tools by tool name.
  const state = { mode: 'inline' as 'inline' | 'plan' | 'act', deniedKeys: new Set<string>() };
  const tools: LlmTool[] = [
    {
      name: 'get_work_items',
      description: 'List open work items assigned to the current user in Azure DevOps',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_work_item',
      description: 'Get details (description, acceptance criteria, comments) of one work item',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Work item ID' } },
        required: ['id'],
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
      name: 'delegate_to_agent',
      description: 'Hand a coding task to an installed external agent CLI (Claude Code, Codex, OpenCode, Hermes, Pi, OpenClaw, Aider, Gemini, Cursor). Returns the agent output.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Full task instructions for the agent' },
          agent: { type: 'string', description: 'Agent name (claude, codex, opencode, hermes, pi, openclaw, aider, gemini, cursor-agent); omit for auto-pick' },
        },
        required: ['prompt'],
      },
    },
    // ── Merge flow: commit / push / PR for a finished agent run's worktree ──
    {
      name: 'commit_worktree',
      description: 'Commit ALL changes in a finished agent run\'s worktree (the isolated branch for a delegated run). Use after the agent finished so its work is preserved. Never touches main.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run id of the finished agent run (from the agent output)' },
          message: { type: 'string', description: 'Commit message; omit to default to ADO <id> + work item title' },
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
      description: 'Create an Azure DevOps pull request from an agent run\'s branch into the base branch. Call AFTER push_worktree.',
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
    // ── Q3 resolution: code tools ─────────────────────────────────────────
    {
      name: 'read_file',
      description: 'Read a workspace file (or a line range) and return its contents',
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
      name: 'get_selection',
      description: 'Return the text currently selected in the active editor',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_workspace',
      description: 'List files in the workspace root (optionally filtered by glob)',
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
      description: 'Replace text in a workspace file (mutating)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
    {
      name: 'run_terminal_command',
      description: 'Run a shell command in the workspace (mutating; restricted in act mode)',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
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

  return {
    tools,
    // M-6 fix: mode lives on a mutable `state` object — the closure var would
    // leave the exported property stale after setMode. Reads/writes go through
    // `state.mode`.
    get mode() { return state.mode; },
    setMode(m: 'inline' | 'plan' | 'act') { state.mode = m; },
    // New turn → the user can be asked again (a previous turn's denials must
    // not lock this turn out of consent prompts).
    beginTurn() { state.deniedKeys.clear(); },
    async execute(name, args) {
      // ── Q8 mode gating ─────────────────────────────────────────────
      // Runs FIRST — before any project/ADO resolution — so blocked tools are
      // rejected even without a workspace (and security checks can't crash).
      if (state.mode === 'plan' && !READ_ONLY_TOOLS.has(name)) {
        return JSON.stringify({ error: `tool '${name}' is not read-only and not allowed in plan mode` });
      }
      if (MUTATING_TOOLS.has(name)) {
        if (state.mode === 'plan') {
          return JSON.stringify({ error: `tool '${name}' is mutating and not allowed in plan mode` });
        }
        // C3 fix: inline mode REQUIRES an approval hook. If none is wired,
        // DENY — never silently execute a mutating tool.
        if (state.mode === 'inline') {
          if (!hooks?.onApprove) {
            return JSON.stringify({ error: `tool '${name}' requires approval, but no approval hook is wired` });
          }
          // After one denial, re-prompting the SAME command/tool is pointless
          // — deny it silently for the rest of the turn. A NEW command or
          // tool still pops a consent card (the user may allow it).
          const denyKey = name === 'run_terminal_command'
            ? `run_terminal_command:${String(args.command ?? '')}`
            : name;
          if (state.deniedKeys.has(denyKey)) {
            return JSON.stringify({ error: `tool '${name}' rejected by user (denied earlier this turn)` });
          }
          const ok = await hooks.onApprove(name, args);
          if (!ok) {
            state.deniedKeys.add(denyKey);
            return JSON.stringify({ error: `tool '${name}' rejected by user` });
          }
        }
        // C3 fix: act mode still enforces the terminal allowlist on
        // run_terminal_command (tokenized, operator-free — see helper below).
        // Commands not in the allowlist are routed through the approval hook
        // so the user can allow once, per-session, or permanently.
        if (name === 'run_terminal_command' && state.mode === 'act') {
          const allowlist = vscode.workspace.getConfiguration('adoCode').get<string[]>('act.terminalAllowlist', ['npm test', 'npm run lint', 'git diff', 'git status']);
          const command = String(args.command ?? '');
          if (!isAllowlistedCommand(command, allowlist)) {
            // Check session cache first (user chose "Allow for Session" earlier)
            if (!isCommandSessionApproved(command)) {
              // Not in allowlist and not session-approved — ask user
              if (!hooks?.onApprove) {
                return JSON.stringify({ error: `command not allowed in act mode (allowlist + no shell operators): ${command}` });
              }
              if (state.deniedKeys.has(`run_terminal_command:${command}`)) {
                return JSON.stringify({ error: `command rejected by user: ${command} (denied earlier this turn)` });
              }
              const ok = await hooks.onApprove(name, args);
              if (!ok) {
                state.deniedKeys.add(`run_terminal_command:${command}`);
                return JSON.stringify({ error: `command rejected by user: ${command}` });
              }
            }
          }
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
          const { detail, comments } = await services.ado.getWorkItemWithDiscussion(project, args.id);
          return JSON.stringify({
            id: detail.id,
            title: detail.fields['System.Title'],
            state: detail.fields['System.State'],
            description: detail.fields['System.Description'],
            acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'],
            tags: detail.fields['System.Tags'],
            thread: comments.map(c => ({ author: c.createdBy.displayName, text: c.text })),
          });
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
        case 'delegate_to_agent':
          return hooks?.onDelegate
            ? await hooks.onDelegate(args.prompt, args.agent)
            : JSON.stringify({ error: 'agent delegation not wired' });
        case 'commit_worktree':
          return hooks?.onCommitWorktree
            ? JSON.stringify(await hooks.onCommitWorktree(String(args.runId ?? ''), String(args.message ?? '')))
            : JSON.stringify({ error: 'worktree commit not wired' });
        case 'push_worktree':
          return hooks?.onPushWorktree
            ? JSON.stringify(await hooks.onPushWorktree(String(args.runId ?? '')))
            : JSON.stringify({ error: 'worktree push not wired' });
        case 'create_pull_request':
          return hooks?.onCreatePullRequest
            ? JSON.stringify(await hooks.onCreatePullRequest(String(args.runId ?? ''), args.title ? String(args.title) : undefined, args.description ? String(args.description) : undefined))
            : JSON.stringify({ error: 'pull request creation not wired' });
        // ── Q3 code tools (implemented via VS Code APIs) ─────────────
        case 'read_file': {
          const uri = resolveWorkspacePath(args.path); // C4: path confinement
          const doc = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(doc).toString('utf8');
          const lines = text.split('\n');
          const start = (args.startLine ?? 1) - 1;
          const end = args.endLine ?? lines.length;
          return lines.slice(start, end).join('\n');
        }
        case 'get_selection': {
          const editor = vscode.window.activeTextEditor;
          return editor ? editor.document.getText(editor.selection) : '';
        }
        case 'list_workspace': {
          // C4/M18: exclude .git, node_modules, dist, and common secret dirs
          const files = await vscode.workspace.findFiles(args.glob ?? '**/*', '**/{node_modules,.git,dist,.vscode}/**', 500);
          return JSON.stringify(files.map(f => vscode.workspace.asRelativePath(f)));
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
          const doc = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(doc).toString('utf8');
          let updated: string;
          if (name === 'edit_file') {
            // C5: verify the replacement actually matched — no silent no-op.
            if (!args.oldText || !text.includes(args.oldText)) {
              return JSON.stringify({ error: `edit_file: oldText not found in ${args.path}` });
            }
            updated = text.replace(args.oldText, args.newText);
          } else {
            updated = applyUnifiedDiff(text, args.diff);
          }
          await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
          return JSON.stringify({ ok: true, path: args.path });
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
          const cmd = String(args.command ?? '').trim();
          if (!cmd) {
            return JSON.stringify({ error: 'run_terminal_command: empty command' });
          }
          if (!/^[^&|;`$<>()\r\n]*$/.test(cmd)) {
            return JSON.stringify({ error: `run_terminal_command: shell operators not allowed: ${args.command}` });
          }
          const { execFile } = require('child_process') as typeof import('child_process');
          const argv = cmd.match(/"[^"]*"|\S+/g) ?? [];
          if (!argv[0]) {
            return JSON.stringify({ error: 'run_terminal_command: no command to run' });
          }
          const result = await new Promise<string>((resolve) => {
            execFile(argv[0]!, argv.slice(1), { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, timeout: 120000 }, (err: any, stdout: any, stderr: any) => {
              resolve(stdout || stderr || (err?.message ?? ''));
            });
          });
          return result.slice(0, 8000);
        }
        case 'set_memory': {
          services.memory.set(args.key, args.category, args.content);
          return JSON.stringify({ ok: true, key: args.key, category: args.category });
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

/** C3: allowlist check — command must tokenize to EXACTLY one allowlisted argv, no shell operators. */
function isAllowlistedCommand(command: string, allowlist: string[]): boolean {
  // C-2 fix: `\s` NOT in the operator class (multi-word commands are legal);
  // newlines rejected so multi-line smuggling can't bypass the argv match.
  if (!command || !/^[^&|;`$<>()\r\n]*$/.test(command)) return false;
  const argv = command.match(/"[^"]*"|\S+/g) ?? [];
  return allowlist.some(entry => {
    const expected = entry.match(/"[^"]*"|\S+/g) ?? [];
    return argv.length === expected.length && argv.every((a, i) => a === expected[i]);
  });
}

/** C4: resolve a workspace-relative path and refuse anything escaping the root. */
function resolveWorkspacePath(relativePath: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error('no workspace folder open');
  // M-8 fix: Uri.joinPath NORMALIZES `../` segments instead of leaving them
  // for the check — resolve the fsPath explicitly so escapes are detectable.
  const pathMod = require('path') as typeof import('path');
  const rootFs = pathMod.resolve(root.uri.fsPath);
  const targetFs = pathMod.resolve(pathMod.join(rootFs, relativePath));
  const sep = pathMod.sep;
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
  let result = [...lines];
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

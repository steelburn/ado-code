import { WorkItemContext } from '../shared/messages';

/**
 * Merge-flow instructions for the chat assistant: after a delegated agent
 * run finishes, the assistant can execute commit → push → PR itself via the
 * worktree tools (guarded — never force-push, never touch main).
 */
const MERGE_FLOW_INSTRUCTIONS = `## Merging agent work

Delegated agents work in isolated git worktrees on feature/ADO-<id> branches. When a run finishes (or the user asks to merge agent work), you can execute the whole merge flow yourself:

1. commit_worktree(runId) — commit ALL changes in the run's worktree. Only for FINISHED runs (never while the run is still 'running'); if the run failed, tell the user before committing.
2. push_worktree(runId) — push the branch to origin. NEVER force-push; NEVER push main/master.
3. create_pull_request(runId) — create the ADO pull request from the run's branch into the base branch. The result includes mergeStatus: if it reads 'conflicts', DO NOT stop — resolve them:
   a. resolve_pr_conflicts(runId) — lists the conflicted files with the base/our/their contents and the worktree-relative path of each.
   b. For each conflicted file, propose/apply a resolution via edit_file or apply_diff on its worktreePath (the file lives in the run's worktree, not the main checkout).
   c. commit_worktree(runId) + push_worktree(runId) again to re-trigger the ADO merge; if the PR still reports conflicts, repeat.
4. Once the PR is up (and the user confirms), you may update_work_item_state to Resolved.

Guardrails: commit/push/PR are mutating tools — inline mode prompts for consent, act mode auto-runs. Use the runId of the finished run; if you don't know it, ask the user. If any step fails (e.g. push rejected), stop and report the exact error instead of working around it.`;

/** Frame memory blocks for an external agent as explicit instructions. */
export function wrapMemoryContext(memoryContext: string): string {
  return `## ADO Code Memory (instructions you MUST honor)\n\n${memoryContext}`;
}

// ── Parent delegation: child delivery checklist ────────────────────────────

/** One entry of a delegated parent's child checklist. */
export interface ChildChecklistItem {
  id: number;
  type: string;
  state: string;
  title: string;
}

/**
 * The delivery-checklist block appended to a delegated parent's prompt.
 * Unlike the old free-form "implement ALL of them" prose, it fixes the
 * contract: the agent must end with a '## Delivery Report' section marking
 * each child DONE / BLOCKED / INCOMPLETE so the extension can sync ADO states
 * after the run (see syncDelegatedChildren in ChatViewProvider).
 */
export function buildChildChecklist(children: ChildChecklistItem[]): string {
  const lines = [
    '## Child Tasks (delivery checklist)',
    '',
    `This work item has ${children.length} child item(s) that are part of this work item. Implement ALL of them.`,
    '',
    ...children.map((c, i) => `${i + 1}. #${c.id} [${c.type}] [${c.state}] — ${c.title}`),
    '',
    'When you finish, end your output with a Delivery Report section — exactly one line per child, using ONLY these statuses:',
    '',
    '## Delivery Report',
    ...children.map(c => `- #${c.id}: DONE`),
    '',
    'DONE = fully implemented and verified. BLOCKED = cannot proceed (missing info, external dependency). INCOMPLETE = not finished. Items marked DONE will be closed in ADO automatically; BLOCKED/INCOMPLETE items stay open.',
  ];
  return lines.join('\n');
}

type ChildStatus = 'DONE' | 'BLOCKED' | 'INCOMPLETE';

/**
 * Tolerant parser for the agent's '## Delivery Report' section. Every listed
 * child id resolves to a status; ids the agent never mentioned default to
 * INCOMPLETE — never assume done from silence.
 */
export function parseDeliveryReport(report: string, childIds: number[]): Record<number, ChildStatus> {
  const out: Record<number, ChildStatus> = {};
  for (const id of childIds) out[id] = 'INCOMPLETE';
  for (const raw of report.split('\n')) {
    const line = raw.trim();
    const m = line.match(/#(\d+)/);
    if (!m) continue;
    const id = Number(m[1]);
    if (!(id in out)) continue;
    const up = line.toUpperCase();
    if (/\b(BLOCKED|BLOCKER|STUCK)\b/.test(up)) out[id] = 'BLOCKED';
    else if (/\[ \]|INCOMPLETE|NOT DONE|UNFINISHED|PARTIAL/.test(up)) out[id] = 'INCOMPLETE';
    else if (/\[X\]|✅|✔|DONE|COMPLETE|COMPLETED|FINISHED|CLOSED/.test(up)) out[id] = 'DONE';
  }
  return out;
}

/**
 * Pull the '## Delivery Report' section out of an agent's full output so the
 * post-run child-completion sync can parse per-item statuses. Returns ''
 * when the agent never emitted one.
 */
export function extractDeliveryReport(output: string): string {
  const idx = output.search(/^##\s*Delivery Report\s*$/im);
  if (idx === -1) return '';
  const rest = output.slice(idx);
  const next = rest.search(/\n##\s/m); // the next heading ends the section
  const section = next === -1 ? rest : rest.slice(0, next);
  return section.trim();
}

/**
 * Canonical markdown rendering of a work item's context. Shared by the
 * UnderstandingService cache (workitem-<id>.md) so chat, agents, and the
 * cache all describe the item identically. Comments are kept in the order
 * given — ADO returns them NEWEST-FIRST and callers must NOT reverse.
 */
export function formatWorkItemContext(workItem: WorkItemContext): string {
  const lines = [
    `Current work item: #${workItem.id} - ${workItem.title}`,
    `State: ${workItem.state || 'N/A'}`,
    `Description: ${workItem.description || 'N/A'}`,
    `Acceptance Criteria: ${workItem.acceptanceCriteria || 'N/A'}`,
    `Tags: ${workItem.tags || 'N/A'}`,
  ];
  if (workItem.comments && workItem.comments.length > 0) {
    lines.push('', 'Discussion thread (latest first):');
    for (const c of workItem.comments) {
      lines.push(`- ${c.author}: ${c.text}`);
    }
  }
  return lines.join('\n');
}

export function buildAgentPrompt(
  workItem: WorkItemContext & { state?: string },
  branch: string,
  projectContext?: string,
  memoryContext?: string,
  understanding?: string
): string {
  const lines = [
    `Read and follow AGENTS.md in the current directory — it contains the project structure, build commands, conventions, and constraints you must respect.`,
    ``,
    `You are working on Azure DevOps work item #${workItem.id}: ${workItem.title}`,
    ``,
    `State: ${workItem.state || 'N/A'}`,
    `Description:`,
    workItem.description || '(none)',
    ``,
    `Acceptance criteria:`,
    workItem.acceptanceCriteria || '(none)',
    ``,
    `Tags: ${workItem.tags || '(none)'}`,
  ];

  // Include the discussion thread — especially clarification Q&A the developer
  // collected before handoff (Task 28). This is the whole point of the
  // review-and-clarify step: the agent must build against the clarified spec.
  if (workItem.comments && workItem.comments.length > 0) {
    // LIVE-TEST FIX: ADO returns comments NEWEST-FIRST — do NOT reverse.
    lines.push(``, `Discussion thread (clarifications, latest first):`);
    for (const c of workItem.comments) {
      lines.push(`- ${c.author}: ${c.text}`);
    }
  }

  lines.push(
    projectContext ? `\nProject context:\n${projectContext}` : '',
    ``,
    `Working branch: ${branch}`,
    `When finished: run the project's tests/lint if present, then summarize what you changed and why. Do NOT commit unless asked.`
  );

  // Memory-driven instructions (user + workspace memory) — the external
  // agent must honor them like any other project convention. The executable
  // hook keys (agent.before / agent.after) are excluded upstream because the
  // runner executes them automatically around the run.
  if (memoryContext && memoryContext.trim().length > 0) {
    lines.push('', wrapMemoryContext(memoryContext.trim()));
  }

  // Cached repository + work-item understanding — the same block the chat
  // system prompt receives, so delegated agents start from the same picture.
  if (understanding && understanding.trim().length > 0) {
    lines.push('', understanding.trim());
  }

  return lines.join('\n');
}

export function buildSystemPrompt(activeWorkItem?: WorkItemContext, memoryPrompt?: string, workspaceMemoryPrompt?: string, understanding?: string): string {
  let prompt = `You are ADO Code, an AI coding assistant integrated into VS Code.
You help developers write, understand, and debug code.
You have access to the developer's Azure DevOps work items.
When the user references a task, use its description, acceptance criteria, AND the discussion thread (especially any clarification Q&A) to guide your assistance.
Be concise, helpful, and focused on code.`;

  if (activeWorkItem) {
    prompt += `\n\n${formatWorkItemContext(activeWorkItem)}`;
  }

  if (memoryPrompt && memoryPrompt.trim().length > 0) {
    prompt += `\n\n${memoryPrompt.trim()}`;
  }

  if (workspaceMemoryPrompt && workspaceMemoryPrompt.trim().length > 0) {
    prompt += `\n\n${workspaceMemoryPrompt.trim()}`;
  }

  if (understanding && understanding.trim().length > 0) {
    prompt += `\n\n${understanding.trim()}`;
  }

  prompt += `\n\n${MERGE_FLOW_INSTRUCTIONS}`;

  return prompt;
}

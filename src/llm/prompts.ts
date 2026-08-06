import { WorkItemContext } from '../shared/messages';

/** Frame memory blocks for an external agent as explicit instructions. */
export function wrapMemoryContext(memoryContext: string): string {
  return `## ADO Code Memory (instructions you MUST honor)\n\n${memoryContext}`;
}

export function buildAgentPrompt(
  workItem: WorkItemContext & { state?: string },
  branch: string,
  projectContext?: string,
  memoryContext?: string
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

  return lines.join('\n');
}

export function buildSystemPrompt(activeWorkItem?: WorkItemContext, memoryPrompt?: string, workspaceMemoryPrompt?: string): string {
  let prompt = `You are ADO Code, an AI coding assistant integrated into VS Code.
You help developers write, understand, and debug code.
You have access to the developer's Azure DevOps work items.
When the user references a task, use its description, acceptance criteria, AND the discussion thread (especially any clarification Q&A) to guide your assistance.
Be concise, helpful, and focused on code.`;

  if (activeWorkItem) {
    prompt += `\n\nCurrent work item: #${activeWorkItem.id} - ${activeWorkItem.title}
Description: ${activeWorkItem.description || 'N/A'}
Acceptance Criteria: ${activeWorkItem.acceptanceCriteria || 'N/A'}
Tags: ${activeWorkItem.tags || 'N/A'}`;

    if (activeWorkItem.comments && activeWorkItem.comments.length > 0) {
      // LIVE-TEST FIX: ADO returns comments NEWEST-FIRST (verified live:
      // id 21076637 precedes 21076636). Do NOT reverse — the thread is
      // already in the order the header claims.
      prompt += `\n\nDiscussion thread (latest first):`;
      for (const c of activeWorkItem.comments) {
        prompt += `\n- ${c.author}: ${c.text}`;
      }
    }
  }

  if (memoryPrompt && memoryPrompt.trim().length > 0) {
    prompt += `\n\n${memoryPrompt.trim()}`;
  }

  if (workspaceMemoryPrompt && workspaceMemoryPrompt.trim().length > 0) {
    prompt += `\n\n${workspaceMemoryPrompt.trim()}`;
  }

  return prompt;
}

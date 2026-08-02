import { WorkItemContext } from '../shared/messages';

export function buildSystemPrompt(activeWorkItem?: WorkItemContext): string {
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
      prompt += `\n\nDiscussion thread (latest first):`;
      for (const c of activeWorkItem.comments.slice().reverse()) {
        prompt += `\n- ${c.author}: ${c.text}`;
      }
    }
  }

  return prompt;
}

/**
 * execute_skill — Execute a specialized AI skill.
 *
 * Skills are reusable capabilities for code review, documentation,
 * testing, refactoring, security auditing, and more. Each skill has
 * a prompt template that guides the AI's behavior for that task.
 */
import type { ToolDefinition } from './types'

const EXECUTE_SKILL_DESCRIPTION = `Execute a specialized skill to perform a task. Skills are reusable capabilities for code review, documentation, testing, refactoring, security auditing, and more. Each skill provides a focused prompt template and knowledge base for a specific type of task.

Use this tool when the user's request matches a skill's purpose. The skill's prompt will guide the AI's approach to the task, ensuring consistent, high-quality output.

Parameters:
- skillId: (required) The ID of the skill to execute (e.g., "code-review", "test-generator", "documentation-gen")
- input: (required) The input/context for the skill (e.g., code to review, file path, task description)

Example: { "skillId": "code-review", "input": "Review the authentication module in src/auth/login.ts" }
Example: { "skillId": "test-generator", "input": "Generate unit tests for the UserService class in src/services/user.ts" }`

const execute_skill: ToolDefinition = {
  type: 'function',
  function: {
    name: 'execute_skill',
    description: EXECUTE_SKILL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        skillId: {
          type: 'string',
          description:
            'The ID of the skill to execute (e.g., "code-review", "test-generator", "documentation-gen")',
        },
        input: {
          type: 'string',
          description:
            'The input/context for the skill (e.g., code to review, file path, task description)',
        },
      },
      required: ['skillId', 'input'],
      additionalProperties: false,
    },
  },
}

export default execute_skill

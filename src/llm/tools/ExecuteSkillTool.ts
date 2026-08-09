/**
 * ExecuteSkillTool — Execute an AI skill by ID.
 *
 * Delegates to SkillManager to look up and run the skill, returning
 * the result as JSON for the LLM conversation.
 */

import { BaseTool, type TaskLike, type ToolCallbacks } from './BaseTool'
import { SkillManager } from '../../services/SkillManager'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Typed params for execute_skill. */
interface ExecuteSkillParams {
  skillId: string
  input: string
}

// ─── Tool Implementation ──────────────────────────────────────────────────────

/**
 * ExecuteSkillTool — invokes a registered skill via SkillManager.
 *
 * The skill's prompt template is combined with the user's input and
 * returned as the tool result, enabling the LLM to follow the skill's
 * specialized instructions.
 */
export class ExecuteSkillTool extends BaseTool {
  readonly name = 'execute_skill' as const

  constructor(private skillManager: SkillManager) {
    super()
  }

  async execute(
    params: Record<string, unknown>,
    _task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const { pushToolResult, toolCallId, handleError } = callbacks

    try {
      const { skillId, input } = params as unknown as ExecuteSkillParams

      // Validate required parameters
      if (!skillId || typeof skillId !== 'string') {
        const errorMsg = `Tool call 'execute_skill' is missing required parameter: skillId`
        console.error(errorMsg)
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      if (!input || typeof input !== 'string') {
        const errorMsg = `Tool call 'execute_skill' is missing required parameter: input`
        console.error(errorMsg)
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      // Execute the skill via SkillManager
      const result = await this.skillManager.executeSkill({
        skillId,
        input,
      })

      if (!result.success) {
        pushToolResult(
          toolCallId,
          JSON.stringify({ error: result.error }),
        )
        return
      }

      pushToolResult(
        toolCallId,
        JSON.stringify({
          success: true,
          output: result.output,
          toolCalls: result.toolCalls,
        }),
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`Error in execute_skill: ${errorMsg}`)
      await handleError(
        'executing skill',
        error instanceof Error ? error : new Error(errorMsg),
      )
      pushToolResult(toolCallId, `Error executing skill: ${errorMsg}`)
    } finally {
      this.resetPartialState()
    }
  }
}

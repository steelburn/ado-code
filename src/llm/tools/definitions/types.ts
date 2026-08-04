/**
 * Local type definitions mirroring OpenAI's function-calling tool format.
 *
 * These mirror the shape of `OpenAI.Chat.ChatCompletionTool` without
 * requiring the `openai` package as a dependency. This keeps the
 * extension bundle small while maintaining API-compatible types.
 *
 * When the providers send requests, they translate these to the
 * provider-specific format (OpenAI wraps in `{ type: 'function', ... }`,
 * Anthropic uses `{ name, description, input_schema }`).
 */

/** JSON Schema property definition (simplified). */
export interface ToolSchemaProperty {
  type: string | string[]
  description?: string
  enum?: string[]
  properties?: Record<string, ToolSchemaProperty>
  required?: string[]
  default?: unknown
}

/** JSON Schema object definition for tool parameters. */
export interface ToolParametersSchema {
  type: 'object'
  properties: Record<string, ToolSchemaProperty>
  required: string[]
  additionalProperties: false
}

/** A function-calling tool definition in OpenAI-compatible format. */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParametersSchema
  }
}

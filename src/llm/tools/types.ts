/**
 * Tool system types — callback signatures, tool-use interfaces, and tool grouping.
 *
 * Adapted from Roo-Code's tool type system, simplified for our project.
 * Does NOT conflict with src/llm/types.ts (which defines LLM-level types).
 */

// ---------------------------------------------------------------------------
// Callback types — passed to tools at execution time
// ---------------------------------------------------------------------------

/** Request user approval for a mutating operation. */
export type AskApproval = (type: string, message?: string) => Promise<boolean>

/** Report an error that occurred during tool execution. */
export type HandleError = (action: string, error: Error) => Promise<void>

/** Push the tool's result back into the conversation. */
export type PushToolResult = (content: string | Uint8Array) => void

// ---------------------------------------------------------------------------
// Tool names & parameters
// ---------------------------------------------------------------------------

/** All built-in tool names. */
export type ToolName =
  | 'read_file'
  | 'search_files'
  | 'edit_file'
  | 'list_files'
  | 'execute_command'
  | 'write_to_file'
  | 'ask_followup_question'
  | 'attempt_completion'
  | 'get_work_items'
  | 'get_work_item'
  | 'get_selection'
  | 'list_workspace'
  | 'apply_diff'
  | 'update_work_item_state'
  | 'add_comment'
  | 'delegate_to_agent'
  | 'create_work_item'
  | 'read_workspace_memory'
  | 'write_workspace_memory'
  | 'list_workspace_memory'
  | 'set_memory'

/**
 * Type map defining the native (typed) argument structure for each tool.
 * Tools not listed here will fall back to `Record<string, unknown>`.
 */
export interface NativeToolArgs {
  read_file: { path: string; offset?: number; limit?: number }
  search_files: { path: string; regex: string; file_pattern?: string | null }
  edit_file: { path: string; oldText: string; newText: string }
  list_files: { glob: string; recursive?: boolean }
  execute_command: { command: string; cwd?: string; timeout?: number }
  write_to_file: { path: string; content: string }
  ask_followup_question: { question: string; follow_up?: Array<{ text: string; mode?: string }> }
  attempt_completion: { result: string }
  get_work_items: Record<string, never>
  get_work_item: { id: number }
  get_selection: Record<string, never>
  list_workspace: { glob?: string }
  apply_diff: { path: string; diff: string }
  update_work_item_state: { id: number; state: string }
  add_comment: { id: number; text: string }
  delegate_to_agent: { prompt: string; agent?: string }
  create_work_item: { workItemType: string; title: string; description?: string; acceptanceCriteria?: string; parentWorkItemId?: number; assignedTo?: string; tags?: string }
}

/**
 * Typed tool-use block from an assistant message.
 * Provides full typing for native args when TName is in NativeToolArgs.
 *
 * @template TName - The specific tool name, which determines nativeArgs type.
 */
export interface ToolUse<TName extends ToolName = ToolName> {
  type: 'tool_use'
  id: string
  name: TName
  params: Record<string, unknown>
  nativeArgs?: TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : never
  partial: boolean
}

// ---------------------------------------------------------------------------
// Tool grouping
// ---------------------------------------------------------------------------

/** Logical groupings of tools for UI and mode-gating. */
export type ToolGroup = 'read' | 'write' | 'execute' | 'mcp' | 'ado' | 'memory'

/** Maps each ToolGroup to its member ToolNames. */
export interface ToolGroupMap {
  read: ('read_file' | 'search_files' | 'list_files' | 'get_selection' | 'list_workspace')[]
  write: ('edit_file' | 'write_to_file' | 'apply_diff')[]
  execute: ('execute_command' | 'delegate_to_agent')[]
  mcp: never[]
  ado: ('get_work_items' | 'get_work_item' | 'update_work_item_state' | 'add_comment' | 'create_work_item')[]
  memory: ('read_workspace_memory' | 'write_workspace_memory' | 'list_workspace_memory' | 'set_memory')[]
}

/** Default group-to-tools mapping. */
export const TOOL_GROUP_MAP: ToolGroupMap = {
  read: ['read_file', 'search_files', 'list_files', 'get_selection', 'list_workspace'],
  write: ['edit_file', 'write_to_file', 'apply_diff'],
  execute: ['execute_command', 'delegate_to_agent'],
  mcp: [],
  ado: ['get_work_items', 'get_work_item', 'update_work_item_state', 'add_comment', 'create_work_item'],
  memory: ['read_workspace_memory', 'write_workspace_memory', 'list_workspace_memory', 'set_memory'],
}

/** Human-readable display names for each tool. */
export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
  read_file: 'Read file',
  search_files: 'Search files',
  edit_file: 'Edit file',
  list_files: 'List files',
  execute_command: 'Run command',
  write_to_file: 'Write file',
  ask_followup_question: 'Ask question',
  attempt_completion: 'Complete task',
  get_work_items: 'List work items',
  get_work_item: 'Get work item',
  get_selection: 'Get selection',
  list_workspace: 'List workspace',
  apply_diff: 'Apply diff',
  update_work_item_state: 'Update state',
  add_comment: 'Add comment',
  create_work_item: 'Create work item',
  delegate_to_agent: 'Delegate to agent',
  read_workspace_memory: 'Read workspace memory',
  write_workspace_memory: 'Write workspace memory',
  list_workspace_memory: 'List workspace memory',
  set_memory: 'Set user memory',
}

// ---------------------------------------------------------------------------
// Re-export tool param names for backward compat
// ---------------------------------------------------------------------------

export const TOOL_PARAM_NAMES = [
  'command', 'path', 'content', 'regex', 'file_pattern', 'recursive',
  'action', 'url', 'text', 'question', 'result', 'diff',
  'startLine', 'endLine', 'offset', 'limit', 'glob',
  'id', 'state', 'prompt', 'agent', 'oldText', 'newText',
] as const

export type ToolParamName = (typeof TOOL_PARAM_NAMES)[number]

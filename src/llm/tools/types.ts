/**
 * Tool system types — callback signatures, tool-use interfaces, and tool grouping.
 *
 * In-house tool type system: the tool names and callback signatures are specific
 * to this extension (Azure DevOps work items and the agentic loop), not a generic
 * framework. Does NOT conflict with src/llm/types.ts (which defines LLM-level types).
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
  | 'execute_command'
  | 'write_to_file'
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
  | 'execute_skill'
  | 'delete_file'
  | 'update_todo_list'
  | 'read_todo_list'
  | 'set_goal'

/**
 * Type map defining the native (typed) argument structure for each tool.
 * Tools not listed here will fall back to `Record<string, unknown>`.
 */
export interface NativeToolArgs {
  read_file: { path?: string; paths?: string[]; startLine?: number; endLine?: number; offset?: number; limit?: number }
  search_files: { path?: string; regex: string; flags?: string; file_pattern?: string | null; limit?: number }
  edit_file: { path: string; oldText: string; newText: string }
  execute_command: { command: string; cwd?: string; timeout?: number }
  write_to_file: { path: string; content: string }
  delete_file: { path: string; recursive?: boolean }
  get_work_items: Record<string, never>
  get_work_item: { id: number }
  get_selection: Record<string, never>
  list_workspace: { glob?: string; details?: boolean }
  apply_diff: { path: string; diff: string }
  update_work_item_state: { id: number; state: string }
  add_comment: { id: number; text: string }
  delegate_to_agent: { prompt: string; agent?: string }
  create_work_item: { workItemType: string; title: string; description?: string; acceptanceCriteria?: string; parentWorkItemId?: number; assignedTo?: string; tags?: string }
  execute_skill: { skillId: string; input: string }
  update_todo_list: { todos: Array<{ content: string; status?: string; activeForm?: string }> }
  read_todo_list: Record<string, never>
  set_goal: { goal: string }
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
export type ToolGroup = 'read' | 'write' | 'execute' | 'mcp' | 'ado' | 'memory' | 'todo'

/** Maps each ToolGroup to its member ToolNames. */
export interface ToolGroupMap {
  read: ('read_file' | 'search_files' | 'get_selection' | 'list_workspace' | 'execute_skill')[]
  write: ('edit_file' | 'write_to_file' | 'apply_diff' | 'delete_file')[]
  execute: ('execute_command' | 'delegate_to_agent')[]
  mcp: never[]
  ado: ('get_work_items' | 'get_work_item' | 'update_work_item_state' | 'add_comment' | 'create_work_item')[]
  memory: ('read_workspace_memory' | 'write_workspace_memory' | 'list_workspace_memory' | 'set_memory')[]
  // The session goal + to-do list are the model's OWN task ledger, not
  // workspace source: they are available in every mode (plan included) so the
  // objective and its plan can be written down while planning and ticked off
  // while acting.
  todo: ('set_goal' | 'update_todo_list' | 'read_todo_list')[]
}

/** Default group-to-tools mapping. */
export const TOOL_GROUP_MAP: ToolGroupMap = {
  read: ['read_file', 'search_files', 'get_selection', 'list_workspace', 'execute_skill'],
  write: ['edit_file', 'write_to_file', 'apply_diff', 'delete_file'],
  execute: ['execute_command', 'delegate_to_agent'],
  mcp: [],
  ado: ['get_work_items', 'get_work_item', 'update_work_item_state', 'add_comment', 'create_work_item'],
  memory: ['read_workspace_memory', 'write_workspace_memory', 'list_workspace_memory', 'set_memory'],
  todo: ['set_goal', 'update_todo_list', 'read_todo_list'],
}

/** Human-readable display names for each tool. */
export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
  read_file: 'Read file',
  search_files: 'Search files',
  edit_file: 'Edit file',
  execute_command: 'Run command',
  write_to_file: 'Write file',
  delete_file: 'Delete file',
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
  execute_skill: 'Execute skill',
  update_todo_list: 'Update to-do list',
  read_todo_list: 'Read to-do list',
  set_goal: 'Set session goal',
}

// ---------------------------------------------------------------------------
// Re-export tool param names for backward compat
// ---------------------------------------------------------------------------

export const TOOL_PARAM_NAMES = [
  'command', 'path', 'content', 'regex', 'file_pattern', 'recursive',
  'diff', 'skillId', 'input',
  'startLine', 'endLine', 'offset', 'limit', 'glob',
  'id', 'state', 'prompt', 'agent', 'oldText', 'newText',
] as const

export type ToolParamName = (typeof TOOL_PARAM_NAMES)[number]

// Note: TOOL_GROUP_MAP drives the prompt DISPLAY via modes.ts/getToolsForMode.
// The LIVE executor's allowed/blocked sets live in src/llm/tools.ts
// (READ_ONLY_TOOLS / MUTATING_TOOLS) and are the authoritative gate.
// Legacy BaseTool/ToolRegistry/definitions/ implementations were removed —
// all tool execution now lives in the single createToolExecutor() switch.

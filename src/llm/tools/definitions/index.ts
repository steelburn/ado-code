/**
 * Native tool definitions — OpenAI function-calling compatible.
 *
 * Each tool is exported as a default from its own file. This index
 * re-exports them all and provides `getNativeTools()` which returns
 * the full array for passing to the LLM API.
 *
 * Adapted from Roo-Code's native-tools pattern.
 */

import read_file from './read_file'
import search_files from './search_files'
import edit_file from './edit_file'
import list_files from './list_files'
import execute_command from './execute_command'
import write_to_file from './write_to_file'

export { default as read_file } from './read_file'
export { default as search_files } from './search_files'
export { default as edit_file } from './edit_file'
export { default as list_files } from './list_files'
export { default as execute_command } from './execute_command'
export { default as write_to_file } from './write_to_file'

/**
 * All native tool definitions.
 */
export const ALL_NATIVE_TOOLS = [
  read_file,
  search_files,
  edit_file,
  list_files,
  execute_command,
  write_to_file,
]

/**
 * Get the native tools array for passing to the LLM API.
 *
 * @returns Array of tool definitions in OpenAI function-calling format.
 */
export function getNativeTools() {
  return ALL_NATIVE_TOOLS
}

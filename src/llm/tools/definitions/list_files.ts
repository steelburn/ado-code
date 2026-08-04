/**
 * list_files — List files and directories within a directory.
 *
 * Adapted from Roo-Code's list_files. Supports top-level or recursive listing.
 */
import type { ToolDefinition } from './types'

const LIST_FILES_DESCRIPTION = `Request to list files and directories within the specified directory. If recursive is true, it will list all files and directories recursively. If recursive is false or not provided, it will only list the top-level contents. Do not use this tool to confirm the existence of files you may have created, as the user will let you know if the files were created successfully or not.

Parameters:
- path: (required) The path of the directory to list contents for (relative to the current workspace directory)
- recursive: (required) Whether to list files recursively. Use true for recursive listing, false for top-level only.

Example: { "path": ".", "recursive": false }
Example: { "path": "src", "recursive": true }`

const list_files: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_files',
    description: LIST_FILES_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to inspect, relative to the workspace',
        },
        recursive: {
          type: 'boolean',
          description: 'Set true to list contents recursively; false to show only the top level',
        },
      },
      required: ['path', 'recursive'],
      additionalProperties: false,
    },
  },
}

export default list_files

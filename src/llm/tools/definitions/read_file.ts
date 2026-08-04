/**
 * read_file — Read a file's contents.
 *
 * Simplified from Roo-Code's read_file. Supports slice-mode reading
 * with offset/limit. Does NOT include indentation mode (can be added later).
 */
import type { ToolDefinition } from './types'

const READ_FILE_DESCRIPTION = `Read a file and return its contents with line numbers.
This tool reads exactly one file per call. If you need multiple files, issue multiple parallel read_file calls.
By default, returns up to 2000 lines per file. Lines longer than 2000 characters are truncated.
Supports text extraction from PDF and DOCX files, but may not handle other binary files properly.

Parameters:
- path: (required) Path to the file to read, relative to the workspace
- offset: (optional) 1-based line number to start reading from (default: 1)
- limit: (optional) Maximum number of lines to return (default: 2000)

Example: { "path": "src/app.ts" }
Example: { "path": "src/app.ts", "offset": 50, "limit": 100 }`

const read_file: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: READ_FILE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read, relative to the workspace',
        },
        offset: {
          type: 'number',
          description: '1-based line offset to start reading from (default: 1)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return (default: 2000)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}

export default read_file

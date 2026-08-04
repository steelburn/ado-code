/**
 * search_files — Regex search across files in a directory.
 *
 * Simplified from Roo-Code's search_files. Uses ripgrep-backed regex
 * with optional file glob filtering.
 */
import type { ToolDefinition } from './types'

const SEARCH_FILES_DESCRIPTION = `Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context.

Craft your regex patterns carefully to balance specificity and flexibility. Use this tool to find code patterns, TODO comments, function definitions, or any text-based information across the project. The results include surrounding context, so analyze the surrounding code to better understand the matches. Leverage this tool in combination with other tools for more comprehensive analysis.

Parameters:
- path: (required) The path of the directory to search in (relative to the current workspace directory). This directory will be recursively searched.
- regex: (required) The regular expression pattern to search for. Uses Rust regex syntax.
- file_pattern: (optional) Glob pattern to filter files (e.g., '*.ts' for TypeScript files). If not provided, it will search all files (*).
- limit: (optional) Maximum number of results to return (default: 50).

Example: { "path": ".", "regex": ".*", "file_pattern": "*.ts" }
Example: { "path": "src", "regex": "function\\\\s+\\\\w+", "file_pattern": "*.js" }`

const search_files: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_files',
    description: SEARCH_FILES_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to search recursively, relative to the workspace',
        },
        regex: {
          type: 'string',
          description: 'Rust-compatible regular expression pattern to match',
        },
        file_pattern: {
          type: ['string', 'null'],
          description: 'Optional glob to limit which files are searched (e.g., *.ts)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 50)',
        },
      },
      required: ['path', 'regex', 'file_pattern'],
      additionalProperties: false,
    },
  },
}

export default search_files

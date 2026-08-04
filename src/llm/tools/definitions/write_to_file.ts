/**
 * write_to_file — Write content to a file (create or overwrite).
 *
 * Adapted from Roo-Code's write_to_file. Primary use case is new file
 * creation or complete rewrites. Prefer edit_file for incremental changes.
 */
import type { ToolDefinition } from './types'

const WRITE_TO_FILE_DESCRIPTION = `Request to write content to a file. This tool is primarily used for creating new files or for scenarios where a complete rewrite of an existing file is intentionally required. If the file exists, it will be overwritten. If it doesn't exist, it will be created. This tool will automatically create any directories needed to write the file.

**Important:** You should prefer using other editing tools over write_to_file when making changes to existing files, since write_to_file is slower and cannot handle large files. Use write_to_file primarily for new file creation.

When using this tool, use it directly with the desired content. You do not need to display the content before using the tool. ALWAYS provide the COMPLETE file content in your response. This is NON-NEGOTIABLE. Partial updates or placeholders like '// rest of code unchanged' are STRICTLY FORBIDDEN. Failure to do so will result in incomplete or broken code.

When creating a new project, organize all new files within a dedicated project directory unless the user specifies otherwise. Structure the project logically, adhering to best practices for the specific type of project being created.

Example: { "path": "config.json", "content": "{ \\"key\\": \\"value\\" }" }`

const write_to_file: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_to_file',
    description: WRITE_TO_FILE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path of the file to write to (relative to the current workspace directory)',
        },
        content: {
          type: 'string',
          description:
            "The content to write to the file. ALWAYS provide the COMPLETE intended content of the file, without any truncation or omissions. You MUST include ALL parts of the file, even if they haven't been modified. Do NOT include line numbers in the content.",
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
}

export default write_to_file

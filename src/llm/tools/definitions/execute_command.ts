/**
 * execute_command — Execute a CLI command on the system.
 *
 * Adapted from Roo-Code's execute_command. Supports command, optional
 * working directory, and timeout for long-running processes.
 */
import type { ToolDefinition } from './types'

const EXECUTE_COMMAND_DESCRIPTION = `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Prefer relative commands and paths that avoid location sensitivity for terminal consistency.

Parameters:
- command: (required) The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.
- cwd: (optional) The working directory to execute the command in
- timeout: (optional) Timeout in seconds. When exceeded, the command keeps running in the background and you receive the output so far. Set this for commands that may run indefinitely, such as dev servers or file watchers, so you can proceed without waiting for them to exit.

Example: { "command": "npm run dev" }
Example: { "command": "ls -la", "cwd": "/home/user/projects" }
Example: { "command": "npm run build", "timeout": 30 }`

const execute_command: ToolDefinition = {
  type: 'function',
  function: {
    name: 'execute_command',
    description: EXECUTE_COMMAND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        cwd: {
          type: ['string', 'null'],
          description: 'Optional working directory for the command, relative or absolute',
        },
        timeout: {
          type: ['number', 'null'],
          description:
            'Timeout in seconds. When exceeded, the command continues running in the background and output collected so far is returned. Use this for long-running processes like dev servers, file watchers, or any command that may not exit on its own',
        },
      },
      required: ['command', 'cwd', 'timeout'],
      additionalProperties: false,
    },
  },
}

export default execute_command

/**
 * ExecuteCommandTool - Execute shell commands as a child process.
 *
 * Adapted from Roo-Code's ExecuteCommandTool, simplified for our project.
 * Spawns a child process with the given command and captures stdout/stderr.
 *
 * Features:
 * - Command execution via child_process.spawn
 * - Optional custom working directory (defaults to task.cwd)
 * - Configurable timeout (default 30s, max 120s)
 * - Captures stdout and stderr
 * - Graceful error handling
 *
 * NOTE: No approval workflow yet — that's Task 4.2.
 */
import { spawn, type ChildProcess } from "child_process"
import * as path from "path"

import { BaseTool, type TaskLike, type ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "./types"

// ─── Types ────────────────────────────────────────────────────────────────────

type ExecuteCommandParams = NativeToolArgs["execute_command"]

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default timeout in milliseconds (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000

/** Maximum allowed timeout in milliseconds (120 seconds). */
const MAX_TIMEOUT_MS = 120_000

// ─── Tool Implementation ──────────────────────────────────────────────────────

/**
 * ExecuteCommandTool - Executes shell commands via child_process.spawn.
 *
 * This is a simplified version that spawns a child process directly,
 * rather than using VS Code terminals (which will be added later).
 */
export class ExecuteCommandTool extends BaseTool {
  readonly name = "execute_command" as const

  async execute(
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const { pushToolResult, toolCallId, handleError } = callbacks

    try {
      // Cast params to the expected type
      const typedParams = params as unknown as ExecuteCommandParams

      // Validate command parameter
      if (!typedParams.command) {
        const errorMsg = `Tool call 'execute_command' is missing required parameter: command`
        console.error(errorMsg)
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      const command = typedParams.command

      // Resolve working directory
      const workingDir = this.resolveWorkingDir(typedParams.cwd, task.cwd)

      // Validate timeout
      const timeoutMs = this.resolveTimeout(typedParams.timeout)

      // Execute the command
      const result = await this.executeCommand(command, workingDir, timeoutMs)

      // Build result string
      let resultText = ""

      // Include stdout if present
      if (result.stdout) {
        resultText += result.stdout
      }

      // Include stderr if present
      if (result.stderr) {
        if (resultText) {
          resultText += "\n\n"
        }
        resultText += `stderr:\n${result.stderr}`
      }

      // Include exit code and signal info
      if (result.timedOut) {
        resultText += `\n\nCommand timed out after ${timeoutMs / 1000} seconds.`
      } else if (result.exitCode !== null) {
        if (result.exitCode !== 0) {
          if (resultText) {
            resultText += "\n\n"
          }
          resultText += `Exit code: ${result.exitCode}`
        }
      } else if (result.signal) {
        if (resultText) {
          resultText += "\n\n"
        }
        resultText += `Process terminated by signal: ${result.signal}`
      }

      // If no output at all, provide a message
      if (!resultText) {
        resultText = "(no output)"
      }

      pushToolResult(toolCallId, resultText)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`Error in execute_command: ${errorMsg}`)
      await handleError("executing command", error instanceof Error ? error : new Error(errorMsg))
      pushToolResult(toolCallId, `Error executing command: ${errorMsg}`)
    } finally {
      this.resetPartialState()
    }
  }

  /**
   * Handle partial (streaming) tool messages.
   * Shows the command as it's being typed.
   */
  override async handlePartial(
    _task: TaskLike,
    block: { id: string; name: string; params: Record<string, unknown>; partial: boolean },
  ): Promise<void> {
    const command = block.params?.command as string | undefined

    if (this.hasPathStabilized(command) && command) {
      // Command has stabilized - could show a status message here
      // For now, we just wait for the full execution
    }
  }

  /**
   * Resolve the working directory for command execution.
   *
   * @param customCwd - Optional custom working directory from params
   * @param taskCwd - Task's working directory (fallback)
   * @returns Absolute path to the working directory
   */
  private resolveWorkingDir(customCwd: string | undefined, taskCwd: string): string {
    if (!customCwd) {
      return taskCwd
    }

    if (path.isAbsolute(customCwd)) {
      return customCwd
    }

    // Resolve relative path against task cwd
    return path.resolve(taskCwd, customCwd)
  }

  /**
   * Resolve the timeout value, clamping to allowed range.
   *
   * @param timeoutSeconds - Timeout in seconds from params (optional)
   * @returns Timeout in milliseconds
   */
  private resolveTimeout(timeoutSeconds: number | undefined): number {
    if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) {
      return DEFAULT_TIMEOUT_MS
    }

    // Convert seconds to milliseconds
    let timeoutMs = timeoutSeconds * 1000

    // Clamp to max
    if (timeoutMs > MAX_TIMEOUT_MS) {
      timeoutMs = MAX_TIMEOUT_MS
    }

    // Minimum 1 second
    if (timeoutMs < 1000) {
      timeoutMs = 1000
    }

    return timeoutMs
  }

  /**
   * Execute a command via child_process.spawn.
   *
   * @param command - The command to execute
   * @param cwd - Working directory for execution
   * @param timeoutMs - Timeout in milliseconds
   * @returns Command execution result
   */
  private executeCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = ""
      let stderr = ""
      let timedOut = false
      const child: ChildProcess | undefined = spawn(command, [], {
        cwd,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      })

      // Set up timeout
      const timeoutId = setTimeout(() => {
        timedOut = true
        // Kill the process group safely across platforms
        if (child && child.pid && !child.killed) {
          if (process.platform !== 'win32') {
            try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          } else {
            child.kill('SIGTERM');
          }

          // Force kill after 5 seconds if still alive
          setTimeout(() => {
            if (child && child.pid && !child.killed) {
              if (process.platform !== 'win32') {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
              } else {
                child.kill('SIGKILL');
              }
            }
          }, 5000)
        }
      }, timeoutMs)

      // Capture stdout
      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString()
        })
      }

      // Capture stderr
      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString()
        })
      }

      // Handle process close
      child.on("close", (code, signal) => {
        clearTimeout(timeoutId)

        // Trim output to reasonable size (100KB max)
        const MAX_OUTPUT_SIZE = 100_000
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout =
            stdout.slice(0, MAX_OUTPUT_SIZE / 2) +
            "\n\n... [output truncated] ...\n\n" +
            stdout.slice(-MAX_OUTPUT_SIZE / 2)
        }
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr =
            stderr.slice(0, MAX_OUTPUT_SIZE / 2) +
            "\n\n... [output truncated] ...\n\n" +
            stderr.slice(-MAX_OUTPUT_SIZE / 2)
        }

        resolve({
          stdout,
          stderr,
          exitCode: code,
          signal: signal ?? null,
          timedOut,
        })
      })

      // Handle spawn errors
      child.on("error", (error) => {
        clearTimeout(timeoutId)
        resolve({
          stdout,
          stderr: stderr + "\n" + error.message,
          exitCode: null,
          signal: null,
          timedOut: false,
        })
      })
    })
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of command execution. */
interface CommandResult {
  /** Standard output from the command */
  stdout: string
  /** Standard error from the command */
  stderr: string
  /** Exit code (null if process was killed by signal) */
  exitCode: number | null
  /** Signal that killed the process (null if exited normally) */
  signal: string | null
  /** Whether the command timed out */
  timedOut: boolean
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/**
 * Singleton instance of ExecuteCommandTool.
 * Import this to register with the tool system.
 */
export const executeCommandTool = new ExecuteCommandTool()

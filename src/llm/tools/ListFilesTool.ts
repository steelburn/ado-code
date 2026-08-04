/**
 * ListFilesTool - Lists files and directories in a given path.
 *
 * Adapted from Roo-Code's ListFilesTool, simplified for our project.
 * Supports:
 * - Relative path resolution (relative to task.cwd)
 * - Optional recursive listing via fs.readdir({ recursive: true })
 * - One file per line output
 * - Error handling for missing directories and permission issues
 */
import path from "path"
import * as fs from "fs/promises"

import { BaseTool, type TaskLike, type ToolCallbacks } from "./BaseTool"

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListFilesParams {
  /** Directory path to list. Resolved relative to task.cwd. Defaults to cwd. */
  path?: string
  /** Whether to list files recursively (default: false, top-level only). */
  recursive?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default maximum number of files to return to prevent overwhelming output. */
const MAX_FILE_COUNT = 500

// ─── Tool Implementation ──────────────────────────────────────────────────────

/**
 * ListFilesTool - Lists files and directories in a given path.
 *
 * Adapted from Roo-Code's ListFilesTool, simplified to focus on:
 * - Basic directory listing with path resolution
 * - Optional recursive listing
 * - Clean one-file-per-line output
 * - Error handling for common failure modes
 */
export class ListFilesTool extends BaseTool {
  readonly name = "list_files" as const

  async execute(
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const { pushToolResult, toolCallId } = callbacks

    try {
      const typedParams = params as unknown as ListFilesParams

      // Resolve the directory path (default to task cwd)
      const relDirPath = typedParams.path || "."
      const dirPath = path.resolve(task.cwd, relDirPath)

      // Workspace boundary validation
      const resolvedCwd = path.resolve(task.cwd)
      const resolvedDir = path.resolve(dirPath)
      if (!resolvedDir.startsWith(resolvedCwd + path.sep) && resolvedDir !== resolvedCwd) {
        pushToolResult(toolCallId, `Error: Path '${relDirPath}' resolves outside the workspace.`)
        return
      }

      const recursive = typedParams.recursive === true

      // Verify the directory exists and is accessible
      let stats: Awaited<ReturnType<typeof fs.stat>>
      try {
        stats = await fs.stat(dirPath)
      } catch {
        const errorMsg = `Directory not found: ${relDirPath}`
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      if (!stats.isDirectory()) {
        const errorMsg = `Path is not a directory: ${relDirPath}`
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      // List files using fs.readdir with optional recursive flag
      let entries: string[]
      try {
        entries = await fs.readdir(dirPath, { recursive })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes("EACCES") || msg.includes("permission denied")) {
          pushToolResult(
            toolCallId,
            `Error: Permission denied reading directory: ${relDirPath}`,
          )
        } else {
          pushToolResult(
            toolCallId,
            `Error listing files in '${relDirPath}': ${msg}`,
          )
        }
        return
      }

      // Check if we hit the file count limit
      const didHitLimit = entries.length > MAX_FILE_COUNT
      if (didHitLimit) {
        entries = entries.slice(0, MAX_FILE_COUNT)
      }

      // Sort entries: directories first, then alphabetical
      entries.sort((a, b) => {
        // Simple sort — works well for flat lists; recursive lists stay in fs order
        return a.localeCompare(b)
      })

      // Build result
      let result = ""

      if (entries.length === 0) {
        result = `Directory '${relDirPath}' is empty.`
      } else {
        // One file per line, with relative paths
        result = entries.join("\n")

        if (didHitLimit) {
          result += `\n\n(Showing first ${MAX_FILE_COUNT} results. Use a more specific path or pattern to narrow results.)`
        }
      }

      pushToolResult(toolCallId, result)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`Error in list_files: ${errorMsg}`)
      pushToolResult(toolCallId, `Error listing files: ${errorMsg}`)
    } finally {
      this.resetPartialState()
    }
  }

  /**
   * Handle partial (streaming) tool messages.
   * Shows the directory path as it's being typed.
   */
  override async handlePartial(
    task: TaskLike,
    block: { id: string; name: string; params: Record<string, unknown>; partial: boolean },
  ): Promise<void> {
    const dirPath = block.params?.path as string | undefined

    if (this.hasPathStabilized(dirPath) && dirPath) {
      // Path has stabilized — could show a status message here
    }
  }
}

/** Singleton instance of ListFilesTool. Import this to register with the tool system. */
export const listFilesTool = new ListFilesTool()

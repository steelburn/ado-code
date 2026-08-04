/**
 * EditFileTool - Search-and-replace file editing.
 *
 * Reads a file, finds `old_string`, replaces it with `new_string`,
 * and writes the file back. Handles relative paths, file-not-found,
 * string-not-found, and multiple-match scenarios.
 */
import path from "path"
import * as fs from "fs/promises"

import { BaseTool, type TaskLike, type ToolCallbacks } from "./BaseTool"

// ─── Types ──────────────────────────────────────────────────────────────────

interface EditFileParams {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Count non-overlapping occurrences of `substr` in `str`.
 */
function countOccurrences(str: string, substr: string): number {
  if (substr === "") return 0
  let count = 0
  let pos = str.indexOf(substr)
  while (pos !== -1) {
    count++
    pos = str.indexOf(substr, pos + substr.length)
  }
  return count
}

/**
 * Safely replace the first occurrence of a literal string.
 * Handles `$` in replacement to avoid ECMAScript substitution quirks.
 */
function safeLiteralReplace(str: string, oldStr: string, newStr: string): string {
  if (oldStr === "" || !str.includes(oldStr)) return str
  // Escape $ to prevent $$/$&/$' substitution in replace()
  const escaped = newStr.replaceAll("$", "$$$$")
  return str.replace(oldStr, escaped)
}

// ─── Tool Implementation ────────────────────────────────────────────────────

/**
 * EditFileTool - Search-and-replace editing for workspace files.
 *
 * Adapted from Roo-Code's EditFileTool, simplified to:
 * - Exact string matching (no whitespace-tolerant or token-based fallbacks)
 * - No diff view or approval workflow (direct file write)
 * - Clear error messages for common failure modes
 */
export class EditFileTool extends BaseTool {
  readonly name = "edit_file" as const

  async execute(
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const { pushToolResult, toolCallId, handleError } = callbacks

    try {
      const typedParams = params as unknown as EditFileParams

      // ── Validate required parameters ─────────────────────────────────
      if (!typedParams.path) {
        pushToolResult(toolCallId, "Error: Missing required parameter: path")
        return
      }

      const old_string = typeof typedParams.old_string === "string" ? typedParams.old_string : ""
      const new_string = typeof typedParams.new_string === "string" ? typedParams.new_string : ""

      // ── Resolve file path ────────────────────────────────────────────
      const filePath = typedParams.path
      const fullPath = path.resolve(task.cwd, filePath)

      // Workspace boundary validation
      const resolvedCwd = path.resolve(task.cwd)
      const resolvedFull = path.resolve(fullPath)
      if (!resolvedFull.startsWith(resolvedCwd + path.sep) && resolvedFull !== resolvedCwd) {
        pushToolResult(toolCallId, `Error: Path '${filePath}' resolves outside the workspace.`)
        return
      }

      // ── Read file ────────────────────────────────────────────────────
      let currentContent: string
      try {
        currentContent = await fs.readFile(fullPath, "utf-8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          pushToolResult(
            toolCallId,
            `Error: File not found: ${filePath}\n\n` +
              "Recovery suggestions:\n" +
              "1. Verify the file path is correct\n" +
              "2. Use list_files to find the correct path\n" +
              "3. If you intend to create a new file, use write_to_file instead",
          )
          return
        }
        throw error
      }

      // ── Empty old_string: file creation guard ────────────────────────
      if (old_string === "") {
        pushToolResult(
          toolCallId,
          `Error: Cannot edit with empty old_string.\n\n` +
            `File already exists at: ${filePath}\n\n` +
            "Recovery suggestions:\n" +
            "1. To modify this file, provide a non-empty old_string matching the current content\n" +
            "2. Use read_file to see the current contents\n" +
            "3. To overwrite the entire file, use write_to_file instead",
        )
        return
      }

      // ── Count matches ────────────────────────────────────────────────
      const matchCount = countOccurrences(currentContent, old_string)

      if (matchCount === 0) {
        pushToolResult(
          toolCallId,
          `Error: Could not find the string to replace in: ${filePath}\n\n` +
            `Searched for (${old_string.length} chars):\n` +
            `---\n${old_string}\n---\n\n` +
            "Recovery suggestions:\n" +
            "1. Use read_file to confirm the file's current contents\n" +
            "2. Ensure old_string matches exactly, including whitespace and indentation\n" +
            "3. Provide more surrounding context to make the match unique\n" +
            "4. If the file has changed since you last read it, re-read and retry",
        )
        return
      }

      if (matchCount > 1) {
        if (!typedParams.replace_all) {
          pushToolResult(
            toolCallId,
            `Error: Found ${matchCount} occurrences of the search string in: ${filePath}\n\n` +
              "edit_file requires exactly one match. Please provide more surrounding context " +
              "in old_string to make the match unique, or set replace_all to true.\n\n" +
              "Recovery suggestions:\n" +
              "1. Include more lines before/after the target text\n" +
              "2. Use read_file to see the surrounding context\n" +
              "3. Ensure old_string uniquely identifies the intended location\n" +
              "4. Set replace_all to true to replace all occurrences",
          )
          return
        }
      }

      // ── Perform replacement ──────────────────────────────────────────
      let newContent: string
      if (typedParams.replace_all && matchCount > 1) {
        // Escape $ to prevent $$/$&/$' substitution in replace()
        const escaped = new_string.replaceAll("$", "$$$$")
        newContent = currentContent.replaceAll(old_string, escaped)
      } else {
        newContent = safeLiteralReplace(currentContent, old_string, new_string)
      }

      // Guard: if content didn't actually change, report it
      if (newContent === currentContent) {
        pushToolResult(
          toolCallId,
          `No changes needed for '${filePath}': old_string and new_string are identical.`,
        )
        return
      }

      // ── Write file ───────────────────────────────────────────────────
      await fs.writeFile(fullPath, newContent, "utf-8")

      // Build a concise success message
      const relativePath = path.relative(task.cwd, fullPath)
      pushToolResult(
        toolCallId,
        `Successfully edited ${relativePath}`,
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`Error in edit_file: ${errorMsg}`)
      await handleError("edit_file", error instanceof Error ? error : new Error(errorMsg))
      pushToolResult(toolCallId, `Error editing file: ${errorMsg}`)
    } finally {
      this.resetPartialState()
    }
  }

  /**
   * Handle partial (streaming) tool messages.
   * Shows the file path as it's being typed.
   */
  override async handlePartial(
    task: TaskLike,
    block: { id: string; name: string; params: Record<string, unknown>; partial: boolean },
  ): Promise<void> {
    const filePath = block.params?.path as string | undefined
    if (this.hasPathStabilized(filePath) && filePath) {
      // Path has stabilized — could emit a status message here if needed
    }
  }
}

/**
 * Singleton instance of EditFileTool.
 * Import this to register with the tool system.
 */
export const editFileTool = new EditFileTool()

/**
 * ReadFileTool - Simplified file reading adapted from Roo-Code.
 *
 * Reads files from the workspace with support for:
 * - Relative path resolution (relative to task.cwd)
 * - Line offset/limit for slicing large files
 * - Line number formatting in output
 * - Binary file detection (returns error for binary files)
 */
import path from "path"
import * as fs from "fs/promises"

import { BaseTool, type TaskLike, type ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "./types"

// ─── Types ────────────────────────────────────────────────────────────────────

type ReadFileParams = NativeToolArgs["read_file"]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default maximum lines to return when no limit is specified. */
const DEFAULT_LINE_LIMIT = 2000

/**
 * Check if a buffer appears to contain binary data.
 * Scans the first 512 bytes for null bytes or a high ratio of non-printable characters.
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  // Check first 512 bytes (or entire buffer if smaller)
  const sample = buffer.subarray(0, Math.min(buffer.length, 512))

  // Null byte is the strongest signal of binary content
  if (sample.includes(0)) {
    return true
  }

  // Count non-printable characters (excluding common whitespace)
  let nonPrintable = 0
  for (const byte of sample) {
    // Printable ASCII range + common whitespace (tab, newline, carriage return)
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      nonPrintable++
    }
  }

  // If more than 10% of the sample is non-printable, consider it binary
  return nonPrintable / sample.length > 0.1
}

/**
 * Add line numbers to file content.
 * Format: "LINE_NUM | CONTENT"
 */
function addLineNumbers(content: string, startLine: number = 1): string {
  if (!content) return ""

  const lines = content.split("\n")
  const maxLineNum = startLine + lines.length - 1
  const gutterWidth = String(maxLineNum).length

  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(gutterWidth, " ")
      return `${lineNum} | ${line}`
    })
    .join("\n")
}

/**
 * Extract a slice of lines from content.
 * Returns the sliced content and metadata about the operation.
 */
function sliceContent(
  content: string,
  offset: number,
  limit: number,
): { content: string; totalLines: number; wasTruncated: boolean } {
  const allLines = content.split("\n")
  const totalLines = allLines.length

  // Convert 1-indexed offset to 0-indexed
  const startIndex = Math.max(0, offset - 1)
  const endIndex = Math.min(totalLines, startIndex + limit)

  const slicedLines = allLines.slice(startIndex, endIndex)
  const wasTruncated = endIndex < totalLines

  return {
    content: slicedLines.join("\n"),
    totalLines,
    wasTruncated,
  }
}

// ─── Tool Implementation ──────────────────────────────────────────────────────

/**
 * ReadFileTool - Reads files from the workspace.
 *
 * Adapted from Roo-Code's ReadFileTool, simplified to focus on:
 * - Basic file reading with path resolution
 * - Line offset/limit for slicing
 * - Line number formatting
 * - Binary file detection
 */
export class ReadFileTool extends BaseTool {
  readonly name = "read_file" as const

  async execute(
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const { pushToolResult, toolCallId } = callbacks

    try {
      // Cast params to the expected type
      const typedParams = params as unknown as ReadFileParams

      // Validate path parameter
      if (!typedParams.path) {
        const errorMsg = `Tool call 'read_file' is missing required parameter: path`
        console.error(errorMsg)
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      // Resolve the file path relative to cwd
      const filePath = typedParams.path
      const fullPath = path.resolve(task.cwd, filePath)

      // Workspace boundary validation
      const resolvedCwd = path.resolve(task.cwd)
      const resolvedFull = path.resolve(fullPath)
      if (!resolvedFull.startsWith(resolvedCwd + path.sep) && resolvedFull !== resolvedCwd) {
        pushToolResult(toolCallId, `Error: Path '${filePath}' resolves outside the workspace.`)
        return
      }

      // Validate offset if provided
      if (typedParams.offset !== undefined && typedParams.offset < 1) {
        pushToolResult(
          toolCallId,
          `Error: offset must be a 1-indexed line number (got ${typedParams.offset}). Line numbers start at 1.`,
        )
        return
      }

      // Check if path exists and is a file
      let stats: Awaited<ReturnType<typeof fs.stat>>
      try {
        stats = await fs.stat(fullPath)
      } catch {
        const errorMsg = `File not found: ${filePath}`
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      if (stats.isDirectory()) {
        const errorMsg = `Cannot read '${filePath}' because it is a directory. Use list_files tool instead.`
        pushToolResult(toolCallId, `Error: ${errorMsg}`)
        return
      }

      // Read file content as buffer first (for binary detection)
      const buffer = await fs.readFile(fullPath)

      // Check for binary content
      if (isBinaryBuffer(buffer)) {
        const ext = path.extname(filePath).toLowerCase() || "unknown"
        pushToolResult(
          toolCallId,
          `Error: Cannot read binary file (${ext}). Binary file format is not supported.`,
        )
        return
      }

      // Convert buffer to string (lossy UTF-8 for non-UTF8 bytes)
      const content = buffer.toString("utf-8")

      // Check if file is empty
      if (content.length === 0) {
        pushToolResult(toolCallId, "Note: File is empty")
        return
      }

      // Apply offset/limit slicing
      const offset = typedParams.offset ?? 1
      const limit = typedParams.limit ?? DEFAULT_LINE_LIMIT

      const { content: slicedContent, totalLines, wasTruncated } = sliceContent(
        content,
        offset,
        limit,
      )

      // Add line numbers
      const numberedContent = addLineNumbers(slicedContent, offset)

      // Build result with truncation warning if needed
      let result = ""
      if (wasTruncated) {
        const endLine = offset + limit - 1
        const nextOffset = endLine + 1
        result =
          `IMPORTANT: File content truncated.\n` +
          `Status: Showing lines ${offset}-${endLine} of ${totalLines} total lines.\n` +
          `To read more: Use the read_file tool with offset=${nextOffset} and limit=${limit}.\n\n`
      }

      result += numberedContent

      pushToolResult(toolCallId, result)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`Error in read_file: ${errorMsg}`)
      pushToolResult(toolCallId, `Error reading file: ${errorMsg}`)
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
      // Path has stabilized - could show a status message here
      // For now, we just wait for the full execution
    }
  }
}

/**
 * Singleton instance of ReadFileTool.
 * Import this to register with the tool system.
 */
export const readFileTool = new ReadFileTool()

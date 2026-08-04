/**
 * BaseTool - Abstract base class for all tool implementations.
 *
 * Adapted from Roo-Code's BaseTool pattern, simplified for our project.
 * All tools extend this class and implement execute().
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal task context passed to tools at execution time.
 * This will be replaced by a full Task class later.
 */
export interface TaskLike {
  /** Current working directory */
  cwd: string;
  /** Reference to the LLM API / client (any for now until API surface is defined) */
  api: unknown;
  /** Emit a status message to the UI */
  say(msg: string): Promise<void>;
}

/**
 * A tool-use block from an assistant message.
 * Represents a single tool invocation requested by the LLM.
 */
export interface ToolBlock {
  /** Unique ID for this tool call (used to correlate results) */
  id: string;
  /** Tool name, must match a registered tool */
  name: string;
  /** Parsed arguments from the LLM */
  params: Record<string, unknown>;
  /** Whether this is a partial/streaming block (not yet complete) */
  partial: boolean;
}

/**
 * Callbacks provided to tools during execution.
 */
export interface ToolCallbacks {
  /** Request user approval for a mutating operation */
  taskApproval(name: string, params: Record<string, unknown>): Promise<boolean>;
  /** Report an error that occurred during tool execution */
  handleError(context: string, error: Error): Promise<void>;
  /** Push the tool's result back into the conversation */
  pushToolResult(toolCallId: string, result: string): void;
  /** The ID of the current tool call (for correlating results) */
  toolCallId: string;
}

// ---------------------------------------------------------------------------
// BaseTool
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all tool implementations.
 *
 * Provides:
 * - Abstract `name` property (tool name string)
 * - Abstract `execute(params, task, callbacks)` method
 * - `handle(task, block, callbacks)` — main entry point that routes partial
 *   vs final messages and handles parameter parsing
 * - `handlePartial(task, block)` — override point for streaming UI updates
 * - `hasPathStabilized(path)` — tracks partial path during streaming
 * - `resetPartialState()` — resets streaming state
 */
export abstract class BaseTool {
  /**
   * The tool's name. Must be unique among registered tools.
   */
  abstract readonly name: string;

  /**
   * Track the last seen path during streaming to detect stabilization.
   * Prevents displaying truncated paths from partial JSON parsing.
   */
  protected lastSeenPartialPath: string | undefined = undefined;

  /**
   * Execute the tool with the given parameters.
   *
   * @param params - Parsed arguments from the LLM tool call
   * @param task - Task context (cwd, API access, UI callbacks)
   * @param callbacks - Execution callbacks (approval, errors, results)
   */
  abstract execute(
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void>;

  /**
   * Handle partial (streaming) tool messages.
   *
   * Default implementation does nothing. Tools that support streaming
   * UI updates should override this.
   *
   * @param task - Task context
   * @param block - Partial ToolBlock
   */
  async handlePartial(task: TaskLike, block: ToolBlock): Promise<void> {
    // Default: no-op — tools can override for streaming UI updates
  }

  /**
   * Check if a path parameter has stabilized during streaming.
   *
   * During streaming, partial JSON may return truncated string values
   * when chunk boundaries fall mid-value. This tracks the path between
   * consecutive handlePartial() calls and returns true only when the
   * path has stopped changing.
   *
   * @param path - The current path value from the partial block
   * @returns true if path has stabilized (same value seen twice) and non-empty
   */
  protected hasPathStabilized(path: string | undefined): boolean {
    const stabilized =
      this.lastSeenPartialPath !== undefined && this.lastSeenPartialPath === path;
    this.lastSeenPartialPath = path;
    return stabilized && !!path;
  }

  /**
   * Reset partial state tracking.
   *
   * Should be called at the end of execute() (both success and error paths)
   * to ensure clean state for the next tool invocation.
   */
  resetPartialState(): void {
    this.lastSeenPartialPath = undefined;
  }

  /**
   * Main entry point for tool execution.
   *
   * Handles the complete flow:
   * 1. If `block.partial`, delegate to handlePartial and return early
   * 2. Validate that params are present
   * 3. Call execute() with the parsed params
   *
   * @param task - Task context
   * @param block - ToolBlock from assistant message
   * @param callbacks - Execution callbacks
   */
  async handle(
    task: TaskLike,
    block: ToolBlock,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    // Handle partial (streaming) messages
    if (block.partial) {
      try {
        await this.handlePartial(task, block);
      } catch (error) {
        console.error(`Error in handlePartial for ${this.name}:`, error);
        await callbacks.handleError(
          `handling partial ${this.name}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return;
    }

    // Validate params
    if (!block.params || typeof block.params !== 'object') {
      const errorMsg = `Tool call ${this.name} is missing parameters.`;
      console.error(errorMsg);
      await callbacks.handleError(`parsing ${this.name} args`, new Error(errorMsg));
      return;
    }

    // Execute
    await this.execute(block.params, task, callbacks);
  }
}

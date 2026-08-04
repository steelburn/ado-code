/**
 * ToolRegistry — manages tool instances and dispatches tool calls.
 *
 * Provides:
 * - Singleton access via ToolRegistry.getInstance()
 * - Registration and lookup of BaseTool implementations
 * - OpenAI-compatible tool definitions for the LLM API
 * - Async execution dispatch with mode-based filtering
 * - Integration bridge between BaseTool.handle() and the agentic loop's
 *   simple execute(name, args) → string contract
 *
 * Adapted from Roo-Code's tool-registry pattern, simplified for our project.
 */

import { BaseTool, type TaskLike, type ToolCallbacks, type ToolBlock } from './BaseTool'
import { getNativeTools } from './definitions'
import type { ToolDefinition } from './definitions/types'
import type { LlmTool } from '../types'
import { TOOL_GROUP_MAP } from './types'
import { type ModeConfig, TOOL_GROUPS } from '../modes'

// ─── Mode types ──────────────────────────────────────────────────────────────

/** Tool-use modes — controls which tools are allowed. */
export type ToolMode = 'inline' | 'plan' | 'act'

// ─── ToolRegistry ────────────────────────────────────────────────────────────

/**
 * Central registry for all tool instances.
 *
 * Usage:
 * ```ts
 * const registry = ToolRegistry.getInstance()
 * registry.register(readFileTool)
 * registry.register(editFileTool)
 * // ...
 * const tools = registry.getToolDefinitions() // LlmTool[] for the API
 * const result = await registry.execute('read_file', { path: 'src/foo.ts' }, task, callbacks)
 * ```
 */
export class ToolRegistry {
  private static instance: ToolRegistry | undefined

  /** Registered tool instances, keyed by tool name. */
  private tools = new Map<string, BaseTool>()

  /** Private — use getInstance(). */
  private constructor() {}

  // ── Singleton ────────────────────────────────────────────────────────────

  /**
   * Get or create the singleton ToolRegistry.
   * Optionally auto-register all built-in tools on first access.
   */
  static getInstance(): ToolRegistry
  static getInstance(autoRegister: true): Promise<ToolRegistry>
  static getInstance(autoRegister = false): ToolRegistry | Promise<ToolRegistry> {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry()
    }
    if (autoRegister) {
      return ToolRegistry.instance.registerBuiltInTools().then(() => ToolRegistry.instance!)
    }
    return ToolRegistry.instance
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a tool instance. Throws if a tool with the same name
   * is already registered (prevents silent collisions).
   */
  register(tool: BaseTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  /**
   * Unregister a tool by name. Returns true if it was found and removed.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  /**
   * Get a tool instance by name.
   * Returns undefined if no tool with that name is registered.
   */
  get(name: string): BaseTool | undefined {
    return this.tools.get(name)
  }

  /**
   * Get all registered tool instances.
   */
  getAll(): BaseTool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Get all registered tool names.
   */
  getNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  // ── Tool definitions for LLM API ────────────────────────────────────────

  /**
   * Return OpenAI-compatible tool definitions (LlmTool[]) for the LLM API.
   *
   * Strategy:
   * 1. If we have registered BaseTool instances AND native definitions,
   *    merge them — use the native definitions for schema but only include
   *    tools that are actually registered.
   * 2. If we only have definitions (no registered tools), return all definitions.
   * 3. Fallback: return empty array.
   */
  getToolDefinitions(): LlmTool[] {
    const nativeDefs = getNativeTools()

    if (this.tools.size === 0) {
      // No registered tools — return all native definitions
      return nativeDefs.map(def => this.definitionToLlmTool(def))
    }

    // Only include definitions for tools that are actually registered
    const registeredNames = new Set(this.tools.keys())
    const result: LlmTool[] = []

    for (const def of nativeDefs) {
      if (registeredNames.has(def.function.name)) {
        result.push(this.definitionToLlmTool(def))
      }
    }

    return result
  }

  /**
   * Get tool definitions as raw ToolDefinition[] (OpenAI function-calling format).
   * Useful when you need the exact schema, not the LlmTool adaptation.
   */
  getNativeToolDefinitions(): ToolDefinition[] {
    const nativeDefs = getNativeTools()

    if (this.tools.size === 0) {
      return nativeDefs
    }

    const registeredNames = new Set(this.tools.keys())
    return nativeDefs.filter(def => registeredNames.has(def.function.name))
  }

  // ── Mode filtering ───────────────────────────────────────────────────────

  /**
   * Get tools (instances) filtered by mode.
   *
   * - 'plan': read-only tools only
   * - 'act': all tools (auto-approved)
   * - 'inline': all tools (approval handled elsewhere)
   */
  getToolsForMode(mode: ToolMode): BaseTool[]
  getToolsForMode(mode: ModeConfig): BaseTool[]
  getToolsForMode(mode: ToolMode | ModeConfig): BaseTool[] {
    if (typeof mode === 'string') {
      // Legacy ToolMode path
      if (mode === 'plan') {
        return this.getAll().filter(tool => this.isReadOnly(tool.name))
      }
      return this.getAll()
    }
    // ModeConfig path — filter by toolGroups
    const allowedNames = new Set<string>()
    for (const group of mode.toolGroups) {
      for (const toolName of TOOL_GROUPS[group]) {
        allowedNames.add(toolName)
      }
    }
    return this.getAll().filter(tool => allowedNames.has(tool.name))
  }

  /**
   * Get tool definitions (LlmTool[]) filtered by mode.
   * Used when building the tools array for the LLM API call.
   */
  getToolDefinitionsForMode(mode: ToolMode): LlmTool[]
  getToolDefinitionsForMode(mode: ModeConfig): LlmTool[]
  getToolDefinitionsForMode(mode: ToolMode | ModeConfig): LlmTool[] {
    if (typeof mode === 'string') {
      // Legacy ToolMode path
      if (mode === 'plan') {
        const readOnlyNames = new Set<string>(
          TOOL_GROUP_MAP.read as readonly string[]
        )
        return this.getToolDefinitions().filter(t => readOnlyNames.has(t.name))
      }
      return this.getToolDefinitions()
    }
    // ModeConfig path — filter by toolGroups
    const allowedNames = new Set<string>()
    for (const group of mode.toolGroups) {
      for (const toolName of TOOL_GROUPS[group]) {
        allowedNames.add(toolName)
      }
    }
    return this.getToolDefinitions().filter(t => allowedNames.has(t.name))
  }

  // ── Execution dispatch ───────────────────────────────────────────────────

  /**
   * Execute a tool by name.
   *
   * This bridges the BaseTool.handle() pattern with the agentic loop's
   * simple execute(name, args) → string contract.
   *
   * @param name - Tool name (must be registered)
   * @param params - Tool parameters from the LLM
   * @param task - Task context (cwd, API, UI callbacks)
   * @param callbacks - Execution callbacks
   * @returns Promise that resolves when execution completes
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const tool = this.tools.get(name)
    if (!tool) {
      const errorMsg = `Unknown tool: '${name}'. Available tools: ${this.getNames().join(', ')}`
      console.error(errorMsg)
      callbacks.pushToolResult(callbacks.toolCallId, JSON.stringify({ error: errorMsg }))
      return
    }

    // Build a ToolBlock for the BaseTool.handle() interface
    const block: ToolBlock = {
      id: callbacks.toolCallId,
      name,
      params,
      partial: false,
    }

    await tool.handle(task, block, callbacks)
  }

  /**
   * Execute a tool in partial/streaming mode.
   * Used when the LLM is streaming and we get partial tool calls.
   */
  async executePartial(
    name: string,
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const tool = this.tools.get(name)
    if (!tool) {
      return // Silently ignore partial calls for unknown tools
    }

    const block: ToolBlock = {
      id: callbacks.toolCallId,
      name,
      params,
      partial: true,
    }

    await tool.handle(task, block, callbacks)
  }

  // ── Built-in tool registration ───────────────────────────────────────────

  /**
   * Register all built-in tool implementations.
   *
   * This imports and registers:
   * - ReadFileTool
   * - SearchFilesTool
   * - EditFileTool
   * - ExecuteCommandTool
   * - ListFilesTool
   *
   * Future tools (WriteFileTool, ApplyDiffTool, etc.) should be added here
   * as they are implemented.
   */
  async registerBuiltInTools(): Promise<void> {
    // Lazy dynamic imports to avoid circular dependencies and reduce startup cost
    const { readFileTool } = await import('./ReadFileTool')
    const { searchFilesTool } = await import('./SearchFilesTool')
    const { editFileTool } = await import('./EditFileTool')
    const { executeCommandTool } = await import('./ExecuteCommandTool')
    const { listFilesTool } = await import('./ListFilesTool')

    const builtInTools: BaseTool[] = [
      readFileTool,
      searchFilesTool,
      editFileTool,
      executeCommandTool,
      listFilesTool,
    ]

    for (const tool of builtInTools) {
      // Don't throw on duplicate — tools may already be registered
      if (!this.tools.has(tool.name)) {
        this.tools.set(tool.name, tool)
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Convert a ToolDefinition (OpenAI format) to LlmTool (our format).
   */
  private definitionToLlmTool(def: ToolDefinition): LlmTool {
    return {
      name: def.function.name,
      description: def.function.description,
      parameters: def.function.parameters as LlmTool['parameters'],
    }
  }

  /**
   * Check if a tool is read-only (safe for plan mode).
   * Read-only tools are defined in the TOOL_GROUP_MAP 'read' group.
   */
  private isReadOnly(name: string): boolean {
    const readOnlyTools = new Set(TOOL_GROUP_MAP.read)
    return readOnlyTools.has(name as any)
  }

  /**
   * Reset the singleton (for testing).
   */
  static reset(): void {
    ToolRegistry.instance = undefined
  }
}

// ─── Convenience export ───────────────────────────────────────────────────────

/**
 * Quick access to the singleton instance.
 * Use this instead of ToolRegistry.getInstance() for brevity.
 */
export const toolRegistry = ToolRegistry.getInstance()

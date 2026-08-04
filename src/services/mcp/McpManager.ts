import * as vscode from 'vscode';
import { McpClient } from './McpClient';
import type { McpServerConfig } from './types';
import type { LlmTool } from '../../llm/types';

/**
 * Manages multiple MCP server connections and dispatches tool calls
 * to the appropriate server. Tool names use the format:
 *   mcp__<serverName>__<toolName>
 */
export class McpManager {
  private clients = new Map<string, McpClient>();

  constructor(private context: vscode.ExtensionContext) {}

  /** Load server configs from VS Code settings and connect to all enabled servers. */
  async connectAll(): Promise<void> {
    const configs = vscode.workspace.getConfiguration('adoCode').get<McpServerConfig[]>('mcp.servers', []);
    for (const config of configs) {
      if (!config.name || !config.command) continue;
      const client = new McpClient(config);
      try {
        await client.connect();
        this.clients.set(config.name, client);
      } catch (err) {
        console.error(`[McpManager] Failed to connect to ${config.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }

  /** Get all tools from all connected MCP servers, with mcp__<server>__<tool> prefix. */
  async getAllTools(): Promise<LlmTool[]> {
    const tools: LlmTool[] = [];
    for (const client of this.clients.values()) {
      if (client.isConnected) {
        tools.push(...await client.toLlmTools());
      }
    }
    return tools;
  }

  /** Call a tool on the appropriate MCP server. Tool name format: mcp__<server>__<tool> */
  async callTool(prefixedName: string, args: Record<string, any>): Promise<string> {
    const parts = prefixedName.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') {
      return JSON.stringify({ error: `invalid MCP tool name: ${prefixedName}` });
    }
    const serverName = parts[1];
    const toolName = parts.slice(2).join('__');
    const client = this.clients.get(serverName);
    if (!client || !client.isConnected) {
      return JSON.stringify({ error: `MCP server '${serverName}' not connected` });
    }
    const result = await client.callTool(toolName, args);
    // Extract text content from result
    const textParts = result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text);
    return textParts.join('\n') || JSON.stringify(result);
  }

  /** Check if a tool name belongs to an MCP server. */
  isMcpTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  /** Get list of connected server names. */
  getConnectedServers(): string[] {
    return Array.from(this.clients.entries())
      .filter(([_, c]) => c.isConnected)
      .map(([name]) => name);
  }
}

# Playbook: Adding an MCP Server

How to add a Model Context Protocol (MCP) server to ADO Code.

## Overview

MCP servers provide additional tools to the LLM via the standard MCP
protocol. ADO Code manages multiple MCP server connections through
`McpManager`, which discovers tools and routes calls using the naming
convention: `mcp__<serverName>__<toolName>`.

## Option A: Via VS Code Settings (Recommended)

The simplest way — add the server to `settings.json`:

```json
{
  "adoCode.mcp.servers": [
    {
      "name": "my-server",
      "command": "node",
      "args": ["path/to/my-mcp-server.js"],
      "env": {
        "API_KEY": "..."
      },
      "timeout": 30000
    }
  ]
}
```

### Config schema

```typescript
// src/services/mcp/types.ts
export interface McpServerConfig {
  name: string        // unique server name (used in tool prefix)
  command: string     // binary to run (e.g. "node", "npx", "python")
  args?: string[]     // command-line arguments
  env?: Record<string, string>  // environment variables
  timeout?: number    // connection timeout in ms (default: 30000)
}
```

### How it works

1. `McpManager.connectAll()` reads `adoCode.mcp.servers` from settings
2. For each config, it spawns the server process via `McpClient`
3. The client performs the MCP handshake (`initialize` → `tools/list`)
4. Tools are prefixed as `mcp__<server>__<tool>` and added to the LLM
5. Tool calls are routed back to the correct server

### Verify connection

1. Open the ADO Code panel
2. Run the "List MCP Servers" command (or check the status indicator)
3. Your server should appear as connected
4. Tools will be available to the LLM automatically

## Option B: Programmatically via McpManager

For tighter integration or dynamic server management:

```typescript
import { McpManager } from './services/mcp/McpManager'

// In your initialization code:
const mcpManager = new McpManager(context)

// Add a server programmatically:
await mcpManager.connectServer({
  name: 'my-server',
  command: 'node',
  args: ['server.js'],
})

// Get all available tools:
const tools = await mcpManager.getAllTools()
// Returns: [{ name: 'mcp__my-server__toolName', description: '...', ... }]

// Call a tool:
const result = await mcpManager.callTool('mcp__my-server__toolName', {
  arg1: 'value',
})

// Check server status:
const servers = mcpManager.getConnectedServers()
// Returns: ['my-server']
```

## Option C: Creating Your Own MCP Server

### Minimal MCP server (Node.js/TypeScript)

```typescript
// my-mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'

const server = new Server(
  { name: 'my-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

// List available tools
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'my_tool',
      description: 'Does something useful',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query' },
        },
        required: ['query'],
      },
    },
  ],
}))

// Handle tool calls
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'my_tool') {
    return {
      content: [{ type: 'text', text: `Result for: ${args.query}` }],
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  }
})

// Start the server
const transport = new StdioServerTransport()
await server.connect(transport)
```

### Package.json

```json
{
  "name": "my-mcp-server",
  "version": "1.0.0",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "bin": {
    "my-mcp-server": "./dist/server.js"
  }
}
```

### Register in ADO Code

```json
{
  "adoCode.mcp.servers": [
    {
      "name": "my-custom",
      "command": "npx",
      "args": ["my-mcp-server"]
    }
  ]
}
```

## How MCP Tools Appear to the LLM

The LLM sees MCP tools with the `mcp__<server>__<tool>` naming convention:

```json
{
  "name": "mcp__my-server__my_tool",
  "description": "Does something useful",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "The query" }
    },
    "required": ["query"]
  }
}
```

## MCP Tool Routing

When the LLM calls an MCP tool, the ToolExecutor routes it:

```typescript
// In src/llm/tools.ts:
default:
  if (name.startsWith('mcp__')) {
    return await services.mcp.callTool(name, args)
  }
  return JSON.stringify({ error: `unknown tool: ${name}` })
```

The `McpManager.callTool()` parses the prefixed name and dispatches
to the correct server.

## Pitfalls

- **Name collisions**: Server names must be unique. Two servers with
  the same name will overwrite each other.
- **Timeout**: Default connection timeout is 30s. Slow-starting servers
  may need a higher `timeout` value.
- **Binary availability**: The server binary must be in PATH or use
  an absolute path. `npx` is handy for npm packages.
- **Tool name prefix**: Always use `mcp__<server>__<tool>` format.
  The `McpManager.isMcpTool()` check looks for the `mcp__` prefix.
- **Error handling**: MCP tool errors are returned as JSON text, not
  exceptions — this keeps the agentic loop alive.

## File Checklist

| File | Action |
|------|--------|
| `settings.json` | Add `adoCode.mcp.servers` entry |
| (External) Your MCP server | Create/deploy |
| `src/services/mcp/McpManager.ts` | Read (for understanding) |
| `src/services/mcp/McpClient.ts` | Read (for understanding) |

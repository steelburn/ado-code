/**
 * Standalone mock MCP server for testing McpClient.
 * Reads JSON-RPC from stdin, writes responses to stdout.
 */

import * as readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    const response = handleRequest(request);
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch {
    // ignore unparseable lines
  }
});

function handleRequest(req: any): any {
  const base = { jsonrpc: '2.0', id: req.id };

  switch (req.method) {
    case 'initialize':
      return {
        ...base,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
        },
      };

    case 'notifications/initialized':
      // Notifications don't get a response per JSON-RPC spec
      return null;

    case 'tools/list':
      return {
        ...base,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echoes the input back',
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: 'The message to echo' },
                },
                required: ['message'],
              },
            },
            {
              name: 'add',
              description: 'Adds two numbers',
              inputSchema: {
                type: 'object',
                properties: {
                  a: { type: 'number', description: 'First number' },
                  b: { type: 'number', description: 'Second number' },
                },
                required: ['a', 'b'],
              },
            },
          ],
        },
      };

    case 'tools/call': {
      const toolName = req.params?.name;
      const args = req.params?.arguments ?? {};
      if (toolName === 'echo') {
        return {
          ...base,
          result: {
            content: [{ type: 'text', text: args.message ?? '' }],
            isError: false,
          },
        };
      }
      if (toolName === 'add') {
        const sum = (args.a ?? 0) + (args.b ?? 0);
        return {
          ...base,
          result: {
            content: [{ type: 'text', text: String(sum) }],
            isError: false,
          },
        };
      }
      return {
        ...base,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    }

    default:
      return {
        ...base,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

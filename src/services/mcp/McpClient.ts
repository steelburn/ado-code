import { ChildProcess, spawn } from 'child_process';
import type { McpServerConfig, McpToolInfo, McpToolCallResult, JsonRpcResponse } from './types';
import type { LlmTool } from '../../llm/types';

export class McpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private connected = false;

  constructor(private config: McpServerConfig) {}

  get isConnected(): boolean { return this.connected; }
  get serverName(): string { return this.config.name; }

  async connect(): Promise<void> {
    const args = this.config.args ?? [];

    this.process = spawn(this.config.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    });

    this.process.stdout?.on('data', (data: Buffer) => this.onData(data));

    this.process.on('error', (err) => {
      this.rejectAll(err);
    });

    this.process.on('exit', () => {
      this.connected = false;
      this.rejectAll(new Error('MCP server process exited'));
    });

    // Send initialize request
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ado-code', version: '0.2.0' },
    });

    // Send notifications/initialized
    await this.send('notifications/initialized', {});

    this.connected = true;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.send('tools/list');
    return (result as any).tools ?? [];
  }

  async callTool(name: string, args: Record<string, any>): Promise<McpToolCallResult> {
    const result = await this.send('tools/call', { name, arguments: args });
    return result as McpToolCallResult;
  }

  async toLlmTools(): Promise<LlmTool[]> {
    const tools = await this.listTools();
    return tools.map((t) => ({
      name: `mcp__${this.config.name}__${t.name}`,
      description: t.description,
      parameters: {
        type: 'object' as const,
        properties: t.inputSchema.properties ?? {},
        required: t.inputSchema.required ?? [],
      },
    }));
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.rejectAll(new Error('MCP client disconnected'));
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
  }

  // Allow injecting a writable stream for testing
  _setStdin(stream: NodeJS.WritableStream): void {
    if (this.process) {
      this.process.stdin = stream as any;
    }
  }

  private send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        return reject(new Error('MCP client not connected'));
      }

      const id = ++this.requestId;
      const timeout = this.config.timeout ?? 30000;

      const request = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined && method.startsWith('notifications/') ? {} : { params }),
      };

      // For notifications (methods starting with 'notifications/'), don't wait for a response
      if (method.startsWith('notifications/')) {
        const data = JSON.stringify(request) + '\n';
        this.process.stdin.write(data);
        return resolve(undefined);
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeout}ms: ${method}`));
      }, timeout);

      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      const data = JSON.stringify(request) + '\n';
      this.process.stdin.write(data);
    });
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response: JsonRpcResponse = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Ignore unparseable lines
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(err);
    }
  }
}

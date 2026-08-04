import * as assert from 'assert';
import * as path from 'path';
import { McpClient } from '../../../services/mcp/McpClient';
import type { McpServerConfig } from '../../../services/mcp/types';

const MOCK_SERVER_PATH = path.resolve(__dirname, './mockMcpServer.js');

function makeConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    name: 'mock',
    command: 'node',
    args: [MOCK_SERVER_PATH],
    timeout: 5000,
    ...overrides,
  };
}

suite('McpClient', () => {
  test('connect() completes without error', async () => {
    const client = new McpClient(makeConfig());
    await client.connect();
    assert.ok(client.isConnected);
    assert.strictEqual(client.serverName, 'mock');
    await client.disconnect();
  });

  test('listTools() returns tool definitions', async () => {
    const client = new McpClient(makeConfig());
    await client.connect();
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools));
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(tools[0].name, 'echo');
    assert.strictEqual(tools[0].description, 'Echoes the input back');
    assert.ok(tools[0].inputSchema.properties);
    assert.deepStrictEqual(tools[0].inputSchema.required, ['message']);
    assert.strictEqual(tools[1].name, 'add');
    await client.disconnect();
  });

  test('callTool() returns results', async () => {
    const client = new McpClient(makeConfig());
    await client.connect();

    // Test echo tool
    const echoResult = await client.callTool('echo', { message: 'hello world' });
    assert.strictEqual(echoResult.content.length, 1);
    assert.strictEqual(echoResult.content[0].type, 'text');
    assert.strictEqual((echoResult.content[0] as any).text, 'hello world');
    assert.strictEqual(echoResult.isError, false);

    // Test add tool
    const addResult = await client.callTool('add', { a: 3, b: 7 });
    assert.strictEqual(addResult.content.length, 1);
    assert.strictEqual(addResult.content[0].type, 'text');
    assert.strictEqual((addResult.content[0] as any).text, '10');

    await client.disconnect();
  });

  test('toLlmTools() converts to LlmTool format with mcp__ prefix', async () => {
    const client = new McpClient(makeConfig());
    await client.connect();
    const llmTools = await client.toLlmTools();
    assert.ok(Array.isArray(llmTools));
    assert.strictEqual(llmTools.length, 2);

    assert.strictEqual(llmTools[0].name, 'mcp__mock__echo');
    assert.strictEqual(llmTools[0].description, 'Echoes the input back');
    assert.strictEqual(llmTools[0].parameters.type, 'object');
    assert.deepStrictEqual(llmTools[0].parameters.required, ['message']);
    assert.ok(llmTools[0].parameters.properties);

    assert.strictEqual(llmTools[1].name, 'mcp__mock__add');
    assert.strictEqual(llmTools[1].description, 'Adds two numbers');
    assert.deepStrictEqual(llmTools[1].parameters.required, ['a', 'b']);

    await client.disconnect();
  });

  test('disconnect() cleans up', async () => {
    const client = new McpClient(makeConfig());
    await client.connect();
    assert.ok(client.isConnected);
    await client.disconnect();
    assert.ok(!client.isConnected);
  });

  test('timeout rejects after configured ms', async () => {
    // Use a command that reads stdin but never writes to stdout
    const client = new McpClient(makeConfig({
      name: 'timeout-test',
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      timeout: 500,
    }));

    try {
      await client.connect();
      // connect() should have timed out since cat never responds
      assert.fail('Expected timeout error');
    } catch (err: any) {
      assert.ok(err.message.includes('timed out'), `Expected timeout error, got: ${err.message}`);
    } finally {
      await client.disconnect();
    }
  });
});

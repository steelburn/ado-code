import * as assert from 'assert';
import { OpenAiProvider } from '../../../llm/providers/openai';
import { AnthropicProvider } from '../../../llm/providers/anthropic';
import { LlmClient } from '../../../llm/client';
import { LlmConfig, LlmMessage, LlmTool } from '../../../llm/types';
import { runAgenticChat } from '../../../llm/agentic';

function jsonResponse(body: any) {
  return {
    ok: true,
    json: async () => body,
  };
}

const config: LlmConfig = {
  provider: 'openai',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

const tools: LlmTool[] = [
  { name: 'echo', description: 'echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
];

function stubExecutor() {
  return {
    tools,
    mode: 'act' as 'inline' | 'plan' | 'act',
    setMode(_m: 'inline' | 'plan' | 'act') {},
    beginTurn() {},
    async execute(name: string, args: Record<string, any>): Promise<string> {
      if (name === 'echo') return `echoed: ${args.value}`;
      throw new Error(`unknown tool ${name}`);
    },
  };
}

suite('OpenAiProvider chatWithTools', () => {
  test('round-trips tool_calls → tool message with tool_call_id', async () => {
    let capturedBody: any;
    const fetchStub = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"hi"}' } }] } }],
      });
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new OpenAiProvider();
    const client = new LlmClient(config);
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'echo hi' },
    ];
    const result = await client.chatWithTools(messages, tools);

    // Request carried the tools array
    assert.ok(capturedBody.tools);
    // First request has no tool messages yet
    assert.strictEqual(capturedBody.messages.filter((m: any) => m.role === 'tool').length, 0);
    // Response parsed into ToolCall
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, 'echo');
    assert.deepStrictEqual(result.toolCalls[0].arguments, { value: 'hi' });
  });

  test('second request carries assistant tool_calls + one tool message per call', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"hi"}' } }] } }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(client, stubExecutor(), [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'echo hi' },
    ]);

    assert.strictEqual(result.text, 'done');
    assert.strictEqual(result.iterations, 2);
    assert.strictEqual(result.toolCalls.length, 1);

    // Second request: assistant message carries tool_calls; exactly one tool message with matching id
    const second = bodies[1];
    const assistantMsg = second.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistantMsg, 'assistant tool_calls present');
    const toolMsgs = second.messages.filter((m: any) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 1);
    assert.strictEqual(toolMsgs[0].tool_call_id, assistantMsg.tool_calls[0].id);
  });

  test('loop terminates when maxIterations exceeded', async () => {
    const fetchStub = async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } }] } }],
    });
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    await assert.rejects(
      runAgenticChat(client, stubExecutor(), [{ role: 'user', content: 'go' }], undefined, 3),
      /exceeded 3 iterations/
    );
  });
});

suite('AnthropicProvider chatWithTools', () => {
  const anthropicConfig: LlmConfig = { ...config, provider: 'anthropic', apiUrl: 'https://api.anthropic.com' };

  test('tool_use block triggers executor; tool_result merged into one user message', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: { value: 'hi' } }],
        });
      }
      return jsonResponse({ content: [{ type: 'text', text: 'all good' }] });
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(anthropicConfig);
    const result = await runAgenticChat(client, stubExecutor(), [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'echo hi' },
    ]);

    assert.strictEqual(result.text, 'all good');
    assert.strictEqual(result.toolCalls.length, 1);

    // Second request: the tool_result block sits in a user message whose
    // tool_use_id matches the first request's tool_use block id.
    const second = bodies[1];
    const userMsg = second.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content));
    assert.ok(userMsg, 'tool_result user message present');
    const resultBlock = userMsg.content.find((b: any) => b.type === 'tool_result');
    assert.ok(resultBlock);
    assert.strictEqual(resultBlock.tool_use_id, 'toolu_1');
    assert.ok(resultBlock.content.includes('echoed: hi'));
  });

  test('system stays in top-level field; first message is user', async () => {
    let captured: any;
    const fetchStub = async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }] });
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(anthropicConfig);
    await runAgenticChat(client, stubExecutor(), [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    assert.strictEqual(captured.system, 'sys');
    assert.strictEqual(captured.messages[0].role, 'user');
  });

  test('runAgenticChat reports progress for thinking text and tool execution', async () => {
    let callCount = 0;
    const fetchStub = async (_url: any, init: any) => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: 'thinking...',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"hi"}' } }],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const updates: string[] = [];
    await runAgenticChat(client, stubExecutor(), [{ role: 'user', content: 'go' }], undefined, 8, (u) => {
      if (u.tool) updates.push(`tool:${u.tool.name}`);
      else if (u.text) updates.push(`text:${u.text}`);
    });

    assert.ok(updates.includes('text:thinking...'), 'thinking text reported');
    assert.ok(updates.includes('tool:echo'), 'tool execution reported');
  });
});

suite('agentic loop token compaction', () => {
  test('older tool results are stubbed while the most recent stays full', async () => {
    const bodies: any[] = [];
    let callCount = 0;
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      callCount += 1;
      if (callCount <= 4) {
        // Keep calling a tool for the first 4 requests, then stop.
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${callCount}`, type: 'function', function: { name: 'echo', arguments: '{"value":"hi"}' } }] } }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    await runAgenticChat(client, stubExecutor(), [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'echo a few times' },
    ]);

    // Request index 2 is the 3rd request — at that point iteration 0's result
    // should have been stubbed but iteration 1's still full.
    const third = bodies[2];
    const toolMsgs = third.messages.filter((m: any) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 2, 'two tool results present (messages kept, not removed)');
    assert.ok(
      toolMsgs.some((m: any) => String(m.content).includes('truncated')),
      'older tool result is stubbed'
    );
    assert.ok(
      toolMsgs.some((m: any) => String(m.content).includes('echoed: hi')),
      'most recent tool result still full'
    );
  });
});

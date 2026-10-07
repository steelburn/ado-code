import * as assert from 'assert';
import { LlmClient } from '../../../llm/client';
import { LlmConfig, LlmMessage, LlmTool } from '../../../llm/types';
import { runAgenticChat } from '../../../llm/agentic';
import { interruptedToolResult, isToolInterruptResult } from '../../../shared/toolInterrupt';

const config: LlmConfig = {
  provider: 'openai',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

const tools: LlmTool[] = [
  { name: 'echo', description: 'echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
];

function jsonResponse(body: any) {
  return { ok: true, json: async () => body };
}

function toolCallResponse(name: string, args: any, id = 'call_1') {
  return jsonResponse({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  });
}

function finalResponse(text: string) {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content: text } }] });
}

function stubExecutor(execute: (name: string, args: Record<string, any>, signal?: AbortSignal) => Promise<string>) {
  return {
    tools,
    mode: 'act' as 'inline' | 'plan' | 'act' | 'yolo',
    setMode(_m: 'inline' | 'plan' | 'act' | 'yolo') {},
    beginTurn() {},
    canAutoExecute(_name: string, _args: Record<string, any>): boolean { return true; },
    execute,
  };
}

const messages: LlmMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'echo hi' },
];

suite('runAgenticChat — interrupt-on-message tool signal', () => {
  test('passes getToolSignal() to executor.execute as the per-tool signal', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return calls === 1 ? toolCallResponse('echo', { value: 'hi' }) : finalResponse('done');
    };
    const executor = stubExecutor(async (_name, args, signal) => {
      seen = signal;
      return `echoed: ${args.value}`;
    });
    const result = await runAgenticChat(new LlmClient(config), executor as any, messages, undefined, 5, undefined, {
      getToolSignal: () => controller.signal,
    });
    assert.strictEqual(seen, controller.signal);
    assert.strictEqual(result.text, 'done');
  });

  test('a tool interrupted by the signal resolves normally and the turn continues', async () => {
    const controller = new AbortController();
    const bodies: any[] = [];
    let calls = 0;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      calls++;
      return calls === 1 ? toolCallResponse('echo', { value: 'hi' }) : finalResponse('recovered');
    };
    const executor = stubExecutor(async (_name, _args, signal) => {
      // Simulate a new user message arriving while the tool is in flight.
      controller.abort();
      assert.strictEqual(signal?.aborted, true);
      return interruptedToolResult();
    });
    const result = await runAgenticChat(new LlmClient(config), executor as any, messages, undefined, 5, undefined, {
      getToolSignal: () => controller.signal,
    });
    assert.strictEqual(result.text, 'recovered');
    const toolMsg = bodies[1].messages.find((m: any) => m.role === 'tool');
    assert.ok(toolMsg, 'the interrupted tool result was recorded');
    assert.strictEqual(isToolInterruptResult(toolMsg.content), true);
  });

  test('without getToolSignal the executor receives no signal', async () => {
    let seen: AbortSignal | undefined | 'unset' = 'unset';
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return calls === 1 ? toolCallResponse('echo', { value: 'hi' }) : finalResponse('done');
    };
    const executor = stubExecutor(async (_name, _args, signal) => {
      seen = signal;
      return 'ok';
    });
    await runAgenticChat(new LlmClient(config), executor as any, messages, undefined, 5);
    assert.strictEqual(seen, undefined);
  });

  test('a steer message is injected on the next iteration while the tool signal is independent', async () => {
    const controller = new AbortController();
    const bodies: any[] = [];
    let calls = 0;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      calls++;
      return calls === 1 ? toolCallResponse('echo', { value: 'hi' }) : finalResponse('done');
    };
    const executor = stubExecutor(async () => 'echoed');
    await runAgenticChat(new LlmClient(config), executor as any, messages, undefined, 5, undefined, {
      drainSteering: () => (calls === 1 ? ['actually stop'] : []),
      getToolSignal: () => controller.signal,
    });
    assert.ok(
      bodies[1].messages.some((m: any) => m.role === 'user' && m.content === 'actually stop'),
      'the steer message reaches the model on the next iteration'
    );
  });
});

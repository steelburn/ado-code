import * as assert from 'assert';
import { LlmClient } from '../../../llm/client';
import { LlmConfig, LlmMessage, LlmTool } from '../../../llm/types';
import { runAgenticChat, compactOldToolResults, COMPACT_RETAIN_THRESHOLD, ToolLoopDetector } from '../../../llm/agentic';

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
    mode: 'act' as 'inline' | 'plan' | 'act' | 'yolo',
    setMode(_m: 'inline' | 'plan' | 'act' | 'yolo') {},
    beginTurn() {},
    canAutoExecute(_name: string, _args: Record<string, any>): boolean { return true; },
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

  test('hitting the iteration budget concludes gracefully instead of throwing', async () => {
    const fetchStub = async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } }] } }],
    });
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(client, stubExecutor(), [{ role: 'user', content: 'go' }], undefined, 3);

    // No throw: the turn ends with a concluding chat message.
    assert.strictEqual(result.reachedIterationLimit, true);
    // The budget counts model round-trips — 3 budgeted round-trips ran.
    assert.strictEqual(result.iterations, 3);
    // Every budgeted round-trip executed its tool; the forced wrap-up ran NONE.
    assert.strictEqual(result.toolCalls.length, 3);
    // The conclusion tells the user the iteration limit was reached (the stub
    // answers the wrap-up with yet another tool call, so the deterministic
    // fallback fires — and it still lands as a real chat conclusion).
    assert.ok(result.text.includes('maximum of 3 iterations'), `unexpected conclusion: ${result.text}`);
  });


  test('the wrap-up may record goal / to-do state before it concludes', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      // Budgeted iterations: keep asking for the work tool.
      if (bodies.length <= 2) {
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${bodies.length}`, type: 'function', function: { name: 'echo', arguments: `{"value":"${bodies.length}"}` } }] } }],
        });
      }
      // First wrap-up round-trip: bookkeeping only — refresh the to-do list.
      if (bodies.length === 3) {
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'todo_1', type: 'function', function: { name: 'update_todo_list', arguments: '{"todos":[{"content":"finish the job","status":"completed"}]}' } }] } }],
        });
      }
      // Second wrap-up round-trip: the concluding reply.
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Hit the iteration limit; the to-do list is up to date.' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const executed: string[] = [];
    const bookkeepingTools: LlmTool[] = [
      ...tools,
      { name: 'set_goal', description: 'set the goal', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } },
      { name: 'update_todo_list', description: 'set the to-do list', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } } } },
    ];
    const executor = {
      tools: bookkeepingTools,
      beginTurn() {},
      mode: 'act' as 'inline' | 'plan' | 'act' | 'yolo',
      setMode(_m: 'inline' | 'plan' | 'act' | 'yolo') {},
      canAutoExecute(_name: string, _args: Record<string, any>): boolean { return true; },
      async execute(name: string, args: Record<string, any>): Promise<string> {
        executed.push(name);
        if (name === 'echo') return `echoed: ${args.value}`;
        return '{"ok":true}';
      },
    };

    const client = new LlmClient(config);
    const result = await runAgenticChat(client, executor, [{ role: 'user', content: 'go' }], undefined, 2);

    assert.strictEqual(result.reachedIterationLimit, true);
    // The bookkeeping call RAN inside the wrap-up — it records state, no work.
    assert.deepStrictEqual(executed, ['echo', 'echo', 'update_todo_list']);
    assert.strictEqual(result.toolCalls.length, 3);
    // The wrap-up instruction offers the bookkeeping escape hatch …
    const wrapUpTurn = bodies[2].messages[bodies[2].messages.length - 1];
    assert.strictEqual(wrapUpTurn.role, 'user');
    assert.ok(wrapUpTurn.content.includes('update_todo_list'), 'the wrap-up may call the to-do tool');
    // …and the model sees the result of the call it made before replying.
    const toolMsgs = bodies[3].messages.filter((m: any) => m.role === 'tool');
    assert.ok(toolMsgs.some((m: any) => m.tool_call_id === 'todo_1'), 'bookkeeping result fed back');
    assert.ok(result.text.includes('to-do list is up to date'), `unexpected conclusion: ${result.text}`);
  });
  test('a batch of N parallel tool calls in one model round-trip is ONE iteration', async () => {
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (!body.messages.some((m: any) => m.role === 'tool')) {
        // First round-trip: the model issues FIVE independent tool calls.
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [1, 2, 3, 4, 5].map((n) => ({
                id: `call_${n}`,
                type: 'function',
                function: { name: 'echo', arguments: JSON.stringify({ value: String(n) }) },
              })),
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(client, stubExecutor(), [{ role: 'user', content: 'go' }]);

    assert.strictEqual(result.toolCalls.length, 5, 'five tool calls executed');
    assert.strictEqual(result.iterations, 2, '5 tools in one round-trip cost ONE iteration + the final round-trip');
    assert.strictEqual(result.text, 'done');
  });

  test('forced wrap-up lets the model conclude in the chat (no tools executed after the cap)', async () => {
    const bodies: any[] = [];
    let executed = 0;
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length <= 2) {
        // Budgeted round-trips keep requesting a tool…
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${bodies.length}`, type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } }] } }],
        });
      }
      // …the forced wrap-up round-trip gets a plain-text conclusion.
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: "I've reached the iteration limit for this turn. Completed: first pass; Remaining: verify tests.", tool_calls: [] } }],
      });
    };
    (globalThis as any).fetch = fetchStub;

    const exec = stubExecutor();
    exec.execute = async (_name: string, args: Record<string, any>) => { executed += 1; return `echoed: ${args.value}`; };

    const client = new LlmClient(config);
    const result = await runAgenticChat(client, exec, [{ role: 'user', content: 'go' }], undefined, 2);

    assert.strictEqual(result.reachedIterationLimit, true);
    assert.strictEqual(result.iterations, 2);
    assert.strictEqual(executed, 2, 'only the two budgeted tools executed — the wrap-up ran none');
    assert.ok(result.text.includes('reached the iteration limit'), `expected model conclusion, got: ${result.text}`);
    // The wrap-up request carries the stop-and-conclude instruction.
    assert.ok(JSON.stringify(bodies[2].messages).includes('iteration limit reached'));
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
    // The system prompt travels as a content block carrying a cache
    // breakpoint, so the identical prefix is not re-billed every iteration.
    assert.strictEqual(captured.system[0].text, 'sys');
    assert.strictEqual(captured.system[0].cache_control.type, 'ephemeral');
    assert.strictEqual(captured.messages[0].role, 'user');
  });

  test('runAgenticChat reports progress for thinking text and tool execution', async () => {
    let callCount = 0;
    const fetchStub = async (_url: any, _init: any) => {
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
    // `final` is what separates pre-tool reasoning from the terminal answer:
    // the host renders falsy updates as thinking and relies on the final one
    // arriving with the whole answer exactly once. Lock the contract down.
    const finals: boolean[] = [];
    await runAgenticChat(client, stubExecutor(), [{ role: 'user', content: 'go' }], undefined, 8, (u) => {
      if (u.tool) updates.push(`tool:${u.tool.name}`);
      else if (u.text) {
        updates.push(`text:${u.text}`);
        finals.push(!!u.final);
      }
    });

    assert.ok(updates.includes('text:thinking...'), 'thinking text reported');
    assert.ok(updates.includes('tool:echo'), 'tool execution reported');
    assert.deepStrictEqual(
      finals,
      [false, true],
      'pre-tool text is non-final and the terminal answer is final — the host posts only the latter as the reply'
    );
  });
});

suite('agentic loop parallel tool execution (pi parity)', () => {
  test('independent tool calls execute concurrently; results stay in call order', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        // One response, TWO independent tool calls (OpenAI parallel_tool_calls).
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"value":"a"}' } },
                { id: 'call_b', type: 'function', function: { name: 'echo', arguments: '{"value":"b"}' } },
              ],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const exec = stubExecutor();
    exec.canAutoExecute = () => true;
    exec.execute = async (_name: string, args: Record<string, any>) => {
      started.push(String(args.value));
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      return `echoed: ${args.value}`;
    };

    const client = new LlmClient(config);
    await runAgenticChat(client, exec, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
    ]);

    // Both calls were in flight at the same time → genuinely concurrent.
    assert.ok(maxActive >= 2, `expected concurrent execution, maxActive=${maxActive}`);

    // The next request carries the tool results in the ORIGINAL call order,
    // so tool_call_id references stay valid and conversation is deterministic.
    const second = bodies[1];
    const toolMsgs = second.messages.filter((m: any) => m.role === 'tool');
    assert.deepStrictEqual(toolMsgs.map((m: any) => m.tool_call_id), ['call_a', 'call_b']);
    assert.ok(String(toolMsgs[0].content).includes('echoed: a'));
    assert.ok(String(toolMsgs[1].content).includes('echoed: b'));
  });

  test('a batch where EVERY call needs consent runs sequentially', async () => {
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (!body.messages.some((m: any) => m.role === 'tool')) {
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } },
                { id: 'call_2', type: 'function', function: { name: 'echo', arguments: '{"value":"y"}' } },
              ],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    let active = 0;
    let maxActive = 0;
    const exec = stubExecutor();
    exec.canAutoExecute = () => false; // e.g. inline mode + mutating tools
    exec.execute = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return 'ok';
    };

    const client = new LlmClient(config);
    await runAgenticChat(client, exec, [{ role: 'user', content: 'go' }]);

    assert.strictEqual(maxActive, 1, 'consent-requiring batch must run sequentially');
  });

  test('mixed batch: consent calls stay one-at-a-time while auto calls run in parallel', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (!body.messages.some((m: any) => m.role === 'tool')) {
        // One response, FOUR calls: two auto-executable reads, two consent-gated.
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"value":"a"}' } },
                { id: 'call_x', type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } },
                { id: 'call_b', type: 'function', function: { name: 'echo', arguments: '{"value":"b"}' } },
                { id: 'call_y', type: 'function', function: { name: 'echo', arguments: '{"value":"y"}' } },
              ],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    let active = 0;
    let maxActive = 0;
    let consentActive = 0;
    let maxConsentActive = 0;
    const exec = stubExecutor();
    // a/b auto-execute (e.g. read-only); x/y need a consent card.
    exec.canAutoExecute = (_name: string, args: Record<string, any>) => args.value === 'a' || args.value === 'b';
    exec.execute = async (_name: string, args: Record<string, any>) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (args.value === 'x' || args.value === 'y') {
        consentActive += 1;
        maxConsentActive = Math.max(maxConsentActive, consentActive);
      }
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      if (args.value === 'x' || args.value === 'y') consentActive -= 1;
      return `echoed: ${args.value}`;
    };

    const client = new LlmClient(config);
    await runAgenticChat(client, exec, [{ role: 'user', content: 'go' }]);

    // The auto calls ran concurrently WITH the consent calls…
    assert.ok(maxActive >= 2, `expected auto calls to overlap consent calls, maxActive=${maxActive}`);
    // …while consent calls never overlapped each other (one card at a time).
    assert.strictEqual(maxConsentActive, 1, 'consent-requiring calls must stay sequential');

    // Results fed back in the ORIGINAL call order (tool_call_id references stay valid).
    const second = bodies[1];
    const toolMsgs = second.messages.filter((m: any) => m.role === 'tool');
    assert.deepStrictEqual(toolMsgs.map((m: any) => m.tool_call_id), ['call_a', 'call_x', 'call_b', 'call_y']);
  });

  test('response hitting the output token limit fails all tool calls (no execution)', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        // finish_reason 'length' — the model ran out of output tokens; the
        // tool-call arguments (intentionally truncated JSON) are unreliable.
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"x"' } }],
            },
            finish_reason: 'length',
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'retried ok' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    let executed = 0;
    const exec = stubExecutor();
    exec.execute = async () => { executed += 1; return 'SHOULD NOT RUN'; };

    const client = new LlmClient(config);
    const result = await runAgenticChat(client, exec, [{ role: 'user', content: 'go' }]);

    assert.strictEqual(executed, 0, 'no tool may execute on a truncated response');
    assert.strictEqual(result.text, 'retried ok');

    // The tool result fed back carries a "NOT executed" error so the model
    // knows to re-issue the call with complete arguments.
    const second = bodies[1];
    const toolMsgs = second.messages.filter((m: any) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 1);
    assert.ok(String(toolMsgs[0].content).includes('NOT executed'));
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

  test('compactOldToolResults retains full content for short outputs (<= threshold)', () => {
    assert.strictEqual(COMPACT_RETAIN_THRESHOLD, 800);
    const shortContent = 'line 1\nline 2\nline 3';
    const msgs: LlmMessage[] = [
      { role: 'user', content: 'read' },
      { role: 'tool', content: shortContent, toolCallId: 'c1' },
      { role: 'assistant', content: 'next' },
    ];
    const stubbed = compactOldToolResults(msgs, 2);
    assert.strictEqual(stubbed, 1);
    assert.ok(String(msgs[1].content).startsWith('[tool result truncated'));
    assert.ok(String(msgs[1].content).includes(shortContent));
  });

  test('compactOldToolResults preserves head and tail previews for long outputs', () => {
    const head = 'START_OF_FILE_'.padEnd(500, 'X');
    const tail = 'END_OF_FILE_'.padStart(150, 'Y');
    const longContent = head + 'MIDDLE_OMITTED_'.repeat(100) + tail;
    const msgs: LlmMessage[] = [
      { role: 'user', content: 'read' },
      { role: 'tool', content: longContent, toolCallId: 'c1' },
      { role: 'assistant', content: 'next' },
    ];
    const stubbed = compactOldToolResults(msgs, 2);
    assert.strictEqual(stubbed, 1);
    const content = String(msgs[1].content);
    assert.ok(content.startsWith('[tool result truncated'));
    assert.ok(content.includes('START_OF_FILE_'));
    assert.ok(content.includes('END_OF_FILE_'));
    assert.ok(content.includes('characters omitted'));
  });
});

suite('agentic loop duplicate & loop detection', () => {
  test('ToolLoopDetector detects exact identical calls: warns at 3rd, blocks at 4th+', () => {
    const detector = new ToolLoopDetector();
    const args = { path: 'src/index.ts', startLine: 1, endLine: 20 };

    assert.strictEqual(detector.checkCall('read_file', args, 1).action, 'allow');
    assert.strictEqual(detector.checkCall('read_file', args, 2).action, 'allow');

    const third = detector.checkCall('read_file', args, 3);
    assert.strictEqual(third.action, 'warn');
    assert.ok(third.warning?.includes('loop warning'));

    const fourth = detector.checkCall('read_file', args, 4);
    assert.strictEqual(fourth.action, 'block');
    assert.ok(fourth.message?.includes('loop detected — call blocked'));
  });

  test('ToolLoopDetector detects repeated overlapping read_file calls', () => {
    const detector = new ToolLoopDetector();
    assert.strictEqual(detector.checkCall('read_file', { path: 'a.md', startLine: 10, endLine: 30 }, 1).action, 'allow');
    assert.strictEqual(detector.checkCall('read_file', { path: 'a.md', startLine: 15, endLine: 35 }, 2).action, 'allow');
    const third = detector.checkCall('read_file', { path: 'a.md', startLine: 12, endLine: 28 }, 3);
    assert.strictEqual(third.action, 'warn');
    const fourth = detector.checkCall('read_file', { path: 'a.md', startLine: 11, endLine: 29 }, 4);
    assert.strictEqual(fourth.action, 'block');
    assert.ok(fourth.message?.includes('repeated read blocked'));
  });

  test('ToolLoopDetector circuit breaker trips after consecutive all-blocked iterations', () => {
    const detector = new ToolLoopDetector();
    assert.strictEqual(detector.recordIterationResult(false), false);
    assert.strictEqual(detector.recordIterationResult(true), false); // 1st blocked iteration
    assert.strictEqual(detector.recordIterationResult(true), true);  // 2nd blocked iteration -> trip
  });

  test('ToolLoopDetector tracks exploration and triggers synthesis nudge after 5 consecutive read iterations', () => {
    const detector = new ToolLoopDetector();
    for (let i = 1; i <= 4; i++) {
      assert.strictEqual(detector.recordReadIteration(true), undefined, `iteration ${i} should not nudge`);
    }
    const nudge5 = detector.recordReadIteration(true);
    assert.ok(nudge5?.includes('exploration notice'), 'iteration 5 should trigger nudge');
    assert.ok(nudge5?.includes('5 consecutive read/search steps'));

    const nudge6 = detector.recordReadIteration(true);
    assert.ok(nudge6?.includes('6 consecutive read/search steps'));

    // Reset on action
    assert.strictEqual(detector.recordReadIteration(false), undefined);
    assert.strictEqual(detector.recordReadIteration(true), undefined);
  });

  test('runAgenticChat breaks degenerate loop and concludes without hitting max iterations', async () => {
    const bodies: any[] = [];
    let round = 0;
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      round += 1;
      const lastMsg = body.messages[body.messages.length - 1];
      if (lastMsg && lastMsg.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.includes('loop detected')) {
        // Concluding wrap-up reply
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'Stopped loop and summarized: done.' } }],
        });
      }
      // Keep requesting the same tool call repeatedly
      return jsonResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: `call_${round}`,
              type: 'function',
              function: { name: 'echo', arguments: '{"value":"looping"}' },
            }],
          },
        }],
      });
    };
    (globalThis as any).fetch = fetchStub;

    const exec = stubExecutor();
    exec.canAutoExecute = () => true;
    exec.execute = async (_name: string, args: Record<string, any>) => `echo: ${args.value}`;

    const client = new LlmClient(config);
    // Request with maxIterations = 20
    const result = await runAgenticChat(client, exec, [
      { role: 'user', content: 'test loop' },
    ], undefined, 20);

    assert.strictEqual(result.reachedIterationLimit, true);
    assert.strictEqual(result.loopDetected, true);
    // Verified that it stopped early due to circuit breaker instead of reaching 20 iterations
    assert.ok(result.iterations < 10, `expected iterations < 10, got ${result.iterations}`);
    assert.ok(result.text.includes('Stopped loop'), `expected final summary, got: ${result.text}`);
  });
});

suite('runAgenticChat steering (mid-run user input)', () => {
  test('drainSteering injects the user text into the NEXT iteration, not the current one', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"hi"}' } }] } }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'steered done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    let drains = 0;
    const progress: string[] = [];
    const client = new LlmClient(config);
    const result = await runAgenticChat(
      client,
      stubExecutor(),
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'echo hi' },
      ],
      undefined,
      undefined,
      (u) => { if (u.steering) progress.push(u.steering); },
      {
        // No steer before the first round-trip; steer after the first tool batch.
        drainSteering: () => (++drains === 2 ? ['also verify X'] : []),
      }
    );

    // The turn completed normally — the steer did NOT abort it.
    assert.strictEqual(result.text, 'steered done');
    assert.strictEqual(result.iterations, 2);

    // Absent from the first request...
    assert.ok(!bodies[0].messages.some((m: any) => m.content === 'also verify X'), 'steer absent from iteration 1');
    // ...and present as a `user` turn in the NEXT request.
    const injected = bodies[1].messages.find((m: any) => m.role === 'user' && m.content === 'also verify X');
    assert.ok(injected, 'steer injected into iteration 2 as a user message');

    // The loop surfaced the steering so the host can badge the bubble.
    assert.deepStrictEqual(progress, ['also verify X']);
  });

  test('no drainSteering callback leaves the loop behavior unchanged', async () => {
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
    // Nothing injected: the second request has no stray user message.
    assert.strictEqual(bodies[1].messages.filter((m: any) => m.role === 'user').length, 1);
  });

  test('steering injected before the first round-trip is honored immediately', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(
      client,
      stubExecutor(),
      [{ role: 'user', content: 'start' }],
      undefined,
      undefined,
      undefined,
      { drainSteering: () => ['do it differently'] }
    );

    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(result.iterations, 1);
    const injected = bodies[0].messages.find((m: any) => m.role === 'user' && m.content === 'do it differently');
    assert.ok(injected, 'steer present in the very first request');
  });
});


suite('runAgenticChat — internal bookkeeping tools are exempt from the iteration budget', () => {
  const internalTools: LlmTool[] = [
    { name: 'set_goal', description: 'record the session goal', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } },
    { name: 'update_todo_list', description: 'update the to-do list', parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'echo', description: 'echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
  ];

  function trackingExecutor(): { ran: string[]; exec: any } {
    const ran: string[] = [];
    return {
      ran,
      exec: {
        tools: internalTools,
        mode: 'act' as 'inline' | 'plan' | 'act' | 'yolo',
        setMode(_m: 'inline' | 'plan' | 'act' | 'yolo') {},
        beginTurn() {},
        canAutoExecute(_name: string, _args: Record<string, any>): boolean { return true; },
        async execute(name: string, args: Record<string, any>): Promise<string> {
          ran.push(name);
          if (name === 'echo') return `echoed: ${args.value}`;
          return `${name} ok`;
        },
      },
    };
  }

  const toolCall = (id: string, name: string, args: object) => (
    `{"id":"${id}","type":"function","function":{"name":"${name}","arguments":${JSON.stringify(JSON.stringify(args))}}}`
  );

  test('set_goal + update_todo_list round-trips do NOT consume the iteration budget', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [JSON.parse(toolCall('c1', 'set_goal', { goal: 'ship it' }))] } }] });
      }
      if (bodies.length === 2) {
        return jsonResponse({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [JSON.parse(toolCall('c2', 'update_todo_list', {}))] } }] });
      }
      if (bodies.length === 3) {
        return jsonResponse({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [JSON.parse(toolCall('c3', 'echo', { value: 'work' }))] } }] });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const t = trackingExecutor();
    // Budget of 2: the two internal round-trips must be free, leaving room for
    // the single real (echo) round-trip to run before the model concludes.
    const result = await runAgenticChat(new LlmClient(config), t.exec, [{ role: 'user', content: 'go' }], undefined, 2);

    assert.strictEqual(result.reachedIterationLimit, undefined, 'internal-only round-trips must not exhaust the budget');
    assert.strictEqual(result.text, 'done');
    assert.deepStrictEqual(t.ran, ['set_goal', 'update_todo_list', 'echo'], 'all three tools ran');
    assert.strictEqual(result.iterations, 4, 'iterations reports total round-trips, internal included');
  });

  test('an iteration mixing an internal tool with a real tool still counts as ONE billable iteration', async () => {
    const bodies: any[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [JSON.parse(toolCall('c1', 'set_goal', { goal: 'g' })), JSON.parse(toolCall('c2', 'echo', { value: 'x' }))] } }] });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const t = trackingExecutor();
    const result = await runAgenticChat(new LlmClient(config), t.exec, [{ role: 'user', content: 'go' }], undefined, 1);

    assert.ok(t.ran.includes('echo'), 'the real tool in a mixed batch still runs');
    assert.strictEqual(result.reachedIterationLimit, true, 'the mixed batch consumed the single-iteration budget');
  });

  test('a runaway internal-only loop is force-concluded by MAX_INTERNAL_ITERATIONS', async () => {
    let n = 0;
    const fetchStub = async () => {
      n++;
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [JSON.parse(toolCall('c' + n, 'set_goal', { goal: 'g' + n }))] } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const t = trackingExecutor();
    const result = await runAgenticChat(new LlmClient(config), t.exec, [{ role: 'user', content: 'go' }], undefined, 2);
    assert.strictEqual(result.reachedIterationLimit, true, 'runaway internal loop is force-concluded');
  });
});

suite('agentic reflection (roadmap #2)', () => {
  test('a halt that names a different next step resumes instead of wrapping up', async () => {
    const bodies: any[] = [];
    let repeats = 0;
    let recovered = false;
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const all = body.messages as Array<{ role: string; content: string }>;
      const last = all[all.length - 1];

      // The reflection round-trip: name the mistake and pick a DIFFERENT step.
      if (last.role === 'user' && last.content.includes('[reflection checkpoint]')) {
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: 'I kept repeating the same echo.\nVERDICT: continue\nGAP: nothing was verified\nNEXT: echo a different value',
            },
          }],
        });
      }

      // The accepted continuation must be acted on, not re-reflected.
      if (last.role === 'user' && last.content.includes('[reflection accepted]')) {
        recovered = true;
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_fresh',
                type: 'function',
                function: { name: 'echo', arguments: '{"value":"different"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        });
      }

      // After the new step ran, the turn is finished.
      if (recovered) {
        return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'recovered and done' } }] });
      }

      // Otherwise keep issuing the SAME call until the loop detector blocks it
      // and the circuit breaker trips.
      repeats++;
      if (repeats <= 8) {
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: `call_${repeats}`,
                type: 'function',
                function: { name: 'echo', arguments: '{"value":"looping"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'unreached' } }] });
    };
    (globalThis as any).fetch = fetchStub;

    const exec = stubExecutor();
    exec.canAutoExecute = () => true;
    exec.execute = async (_name: string, args: Record<string, any>) => `echo: ${args.value}`;

    const result = await runAgenticChat(new LlmClient(config), exec, [
      { role: 'user', content: 'test reflection' },
    ], undefined, 20);

    assert.strictEqual(result.text, 'recovered and done',
      `expected the reflected turn to finish its work, got: ${result.text}`);
    assert.strictEqual(result.signals?.reflectionTurns, 1, 'expected exactly one reflection turn');
    assert.ok(result.iterations < 20, `reflection should recover well inside the budget, got ${result.iterations}`);

    // The checkpoint carried real facts about the turn, not an empty prompt.
    const checkpoint = bodies.find((b) =>
      String(b.messages[b.messages.length - 1]?.content).includes('[reflection checkpoint]'));
    assert.ok(checkpoint, 'expected a reflection round-trip');
    const checkpointText = String(checkpoint.messages[checkpoint.messages.length - 1].content);
    assert.ok(checkpointText.includes('Calls blocked as exact repeats:'),
      `digest should report the blocked repeats, got: ${checkpointText}`);
    assert.ok(checkpointText.includes('echo x'), 'digest should name the repeated tool');
    assert.ok(checkpointText.includes('VERDICT: continue|conclude'));

    // The accepted verdict became the instruction that resumed the loop.
    const resumed = bodies.find((b) =>
      String(b.messages[b.messages.length - 1]?.content).includes('[reflection accepted]'));
    assert.ok(resumed, 'expected the loop to resume with the accepted reflection');
    const resumedText = String(resumed.messages[resumed.messages.length - 1].content);
    assert.ok(resumedText.includes('echo a different value'));
  });
});

suite('agentic review gate (roadmap #3)', () => {
  const reviewTools: LlmTool[] = [
    {
      name: 'edit_file',
      description: 'edit a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ];

  function editingExecutor(executed: string[]) {
    return {
      tools: reviewTools,
      mode: 'act' as const,
      setMode(_m: 'inline' | 'plan' | 'act' | 'yolo') {},
      beginTurn() {},
      canAutoExecute(_name: string, _args: Record<string, any>): boolean {
        return true;
      },
      async execute(name: string, args: Record<string, any>): Promise<string> {
        executed.push(`${name}:${args.path}`);
        return `edited ${args.path}`;
      },
    } as any;
  }

  function reply(payload: any) {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as any;
  }

  function says(text: string) {
    return reply({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
  }

  function calls(name: string, args: Record<string, any>, id: string) {
    return reply({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  }

  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;';

  test('a revise that names its fix resumes the turn instead of finishing', async () => {
    const bodies: any[] = [];
    const progress: any[] = [];
    const executed: string[] = [];
    let reviewed = false;

    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const msgs = body.messages as Array<{ role: string; content: string }>;
      const last = msgs[msgs.length - 1];
      const content = typeof last.content === 'string' ? last.content : '';
      if (content.includes('REVIEW TURN')) {
        return says('VERDICT: revise\nISSUE: the caller of a.ts was never updated\nNEXT: update src/b.ts');
      }
      if (content.includes('failed an automated review')) {
        reviewed = true;
        return calls('edit_file', { path: 'src/b.ts' }, 'c3');
      }
      if (reviewed) {
        return says('fixed the caller too');
      }
      if (msgs.some((m) => m.role === 'tool')) {
        return says('done, changed a.ts');
      }
      return calls('edit_file', { path: 'src/a.ts' }, 'c1');
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const exec = editingExecutor(executed);
    const result = await runAgenticChat(
      client,
      exec,
      [{ role: 'user', content: 'make a 2' }],
      undefined,
      10,
      (u) => progress.push(u),
      { reviewDiff: async () => DIFF },
    );

    // The turn ends on the FIXED reply, not on the reply the review rejected.
    assert.strictEqual(result.text, 'fixed the caller too');
    assert.deepStrictEqual(executed, ['edit_file:src/a.ts', 'edit_file:src/b.ts']);
    assert.strictEqual(result.signals!.reviewTurns, 1);
    assert.strictEqual(result.signals!.reviewRevisions, 1);

    // Exactly one review: the resumed finish is not reviewed again.
    const reviewRequests = bodies.filter((b) =>
      (b.messages as Array<{ content: string }>).some((m) => typeof m.content === 'string' && m.content.includes('REVIEW TURN')),
    );
    assert.strictEqual(reviewRequests.length, 1, 'the gate is once-per-turn');
    // The review saw the real diff and the mutated path.
    const reviewText = String(
      (reviewRequests[0].messages as Array<{ content: string }>).find((m) => String(m.content).includes('REVIEW TURN'))!.content,
    );
    assert.ok(reviewText.includes('const a = 2'), 'the review must see the diff, not a summary');
    assert.ok(reviewText.includes('src/a.ts'), 'the review must know which files changed');
    // The review round-trip is tool-free, so the provider omits the field.
    assert.strictEqual(reviewRequests[0].tools, undefined, 'a review must not send tools: []');

    // The rejected completion never reached the user as final.
    const finals = progress.filter((p) => p.final && typeof p.text === 'string');
    assert.ok(!finals.some((p) => p.text.includes('done, changed a.ts')), 'the pre-review reply must not be emitted as final');
    assert.ok(finals.length > 0 && finals[finals.length - 1].text === 'fixed the caller too');
  });

  test('a ship accepts the finish and changes nothing', async () => {
    const bodies: any[] = [];
    const executed: string[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const msgs = body.messages as Array<{ role: string; content: string }>;
      const last = msgs[msgs.length - 1];
      if (typeof last.content === 'string' && last.content.includes('REVIEW TURN')) {
        return says('VERDICT: ship\nISSUE: none\nNEXT: none');
      }
      if (msgs.some((m) => m.role === 'tool')) {
        return says('done, changed a.ts');
      }
      return calls('edit_file', { path: 'src/a.ts' }, 'c1');
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(
      client,
      editingExecutor(executed),
      [{ role: 'user', content: 'make a 2' }],
      undefined,
      10,
      undefined,
      { reviewDiff: async () => DIFF },
    );

    assert.strictEqual(result.text, 'done, changed a.ts');
    assert.deepStrictEqual(executed, ['edit_file:src/a.ts'], 'a ship must not resume the loop');
    assert.strictEqual(result.signals!.reviewTurns, 1);
    assert.strictEqual(result.signals!.reviewRevisions, 0);
    assert.ok(!bodies.some((b) => (b.messages as Array<{ content: string }>).some((m) => String(m.content).includes('failed an automated review'))));
  });

  test('a revise with no next step is ignored', async () => {
    const executed: string[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const msgs = body.messages as Array<{ role: string; content: string }>;
      const last = msgs[msgs.length - 1];
      if (typeof last.content === 'string' && last.content.includes('REVIEW TURN')) {
        return says('VERDICT: revise\nISSUE: something feels off\nNEXT: none');
      }
      if (msgs.some((m) => m.role === 'tool')) {
        return says('done, changed a.ts');
      }
      return calls('edit_file', { path: 'src/a.ts' }, 'c1');
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(
      client,
      editingExecutor(executed),
      [{ role: 'user', content: 'make a 2' }],
      undefined,
      10,
      undefined,
      { reviewDiff: async () => DIFF },
    );

    assert.strictEqual(result.text, 'done, changed a.ts');
    assert.strictEqual(result.signals!.reviewRevisions, 0, 'a plan-less revise is not actionable');
  });

  test('a turn that changed nothing is never reviewed', async () => {
    let diffs = 0;
    const fetchStub = async () => says('nothing to do here');
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(
      client,
      editingExecutor([]),
      [{ role: 'user', content: 'what does this file do?' }],
      undefined,
      10,
      undefined,
      {
        reviewDiff: async () => {
          diffs++;
          return DIFF;
        },
      },
    );

    assert.strictEqual(diffs, 0, 'a read-only turn must not pay for a review');
    assert.strictEqual(result.signals!.reviewTurns, 0);
  });

  test('a broken diff provider cannot fail the turn', async () => {
    const executed: string[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const msgs = body.messages as Array<{ role: string; content: string }>;
      if (msgs.some((m) => m.role === 'tool')) {
        return says('done, changed a.ts');
      }
      return calls('edit_file', { path: 'src/a.ts' }, 'c1');
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(
      client,
      editingExecutor(executed),
      [{ role: 'user', content: 'make a 2' }],
      undefined,
      10,
      undefined,
      {
        reviewDiff: async () => {
          throw new Error('git exploded');
        },
      },
    );

    assert.strictEqual(result.text, 'done, changed a.ts', 'the gate must never break a turn');
    assert.strictEqual(result.signals!.reviewTurns, 0);
  });

  test('an empty diff is not reviewed', async () => {
    const executed: string[] = [];
    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const msgs = body.messages as Array<{ role: string; content: string }>;
      if (msgs.some((m) => m.role === 'tool')) {
        return says('done, changed a.ts');
      }
      return calls('edit_file', { path: 'src/a.ts' }, 'c1');
    };
    (globalThis as any).fetch = fetchStub;

    const client = new LlmClient(config);
    const result = await runAgenticChat(
      client,
      editingExecutor(executed),
      [{ role: 'user', content: 'make a 2' }],
      undefined,
      10,
      undefined,
      { reviewDiff: async () => '' },
    );

    assert.strictEqual(result.text, 'done, changed a.ts');
    assert.strictEqual(result.signals!.reviewTurns, 0, 'nothing to look at means no round-trip');
  });
});

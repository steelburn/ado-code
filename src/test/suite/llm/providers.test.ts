import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAiProvider, listModelsOpenAi } from '../../../llm/providers/openai';
import { AnthropicProvider } from '../../../llm/providers/anthropic';
import { LlmConfig, LlmMessage, LlmTool, LlmToolParameter } from '../../../llm/types';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach(c => controller.enqueue(encoder.encode(c)));
      controller.close();
    },
  });
}

const config: LlmConfig = {
  provider: 'openai',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

suite('OpenAiProvider', () => {
  test('parses SSE chunks and [DONE]', async () => {
    const fetchStub = async () => ({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });
    (globalThis as any).fetch = fetchStub;

    const provider = new OpenAiProvider();
    const chunks = [];
    for await (const c of provider.streamChat([], config)) {
      chunks.push(c);
    }
    assert.deepStrictEqual(chunks, [
      { content: 'Hel', done: false },
      { content: 'lo', done: false },
      { content: '', done: true },
    ]);
  });

  test('tolerates CRLF and data: without space (Azure style)', async () => {
    const fetchStub = async () => ({
      ok: true,
      body: sseStream([
        'data:{"choices":[{"delta":{"content":"x"}}]}\r\n\r\n',
        'data:[DONE]\r\n\r\n',
      ]),
    });
    (globalThis as any).fetch = fetchStub;

    const provider = new OpenAiProvider();
    const chunks = [];
    for await (const c of provider.streamChat([], config)) {
      chunks.push(c);
    }
    assert.strictEqual(chunks[0].content, 'x');
    assert.strictEqual(chunks[chunks.length - 1].done, true);
  });

  test('listModels parses ids + OpenRouter/Ollama capability hints', async () => {
    const fetchStub = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'openai/gpt-5', architecture: { input_modalities: ['text', 'image'] } },
          { id: 'openai/gpt-4o', architecture: { input_modalities: ['text'] } },
          { id: 'custom/plain', object: 'model' }, // OpenAI/vLLM style — no hints
          { name: 'ollama/qwen2.5-vl', capabilities: ['vision', 'tools'] }, // Ollama style
          { id: '' }, // empty id → dropped
        ],
      }),
    });
    (globalThis as any).fetch = fetchStub;

    const models = await listModelsOpenAi(config);
    assert.deepStrictEqual(models, [
      { id: 'openai/gpt-5', vision: true },
      { id: 'openai/gpt-4o', vision: false },
      { id: 'custom/plain' },
      { id: 'ollama/qwen2.5-vl', vision: true, tools: true },
    ]);
  });
});

suite('AnthropicProvider', () => {
  const anthropicConfig: LlmConfig = { ...config, provider: 'anthropic', apiUrl: 'https://api.anthropic.com' };
  const messages: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ];

  test('posts to /v1/messages with normalized URL and required headers', async () => {
    let captured: any;
    const fetchStub = async (url: any, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        body: sseStream([
          'data: {"type":"content_block_delta","delta":{"text":"Hey"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      };
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new AnthropicProvider();
    const chunks = [];
    for await (const c of provider.streamChat(messages, anthropicConfig)) {
      chunks.push(c);
    }
    assert.strictEqual(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(captured.init.headers['x-api-key'], 'test-key');
    assert.ok(captured.init.headers['anthropic-version']);
    assert.strictEqual(JSON.parse(captured.init.body).system, 'sys');
    assert.strictEqual(chunks[chunks.length - 1].done, true);
  });

  test('merges consecutive same-role messages', async () => {
    let captured: any;
    const fetchStub = async (_url: any, init: any) => {
      captured = init;
      return { ok: true, body: sseStream(['data: {"type":"message_stop"}\n\n']) };
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new AnthropicProvider();
    const sameRole: LlmMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    await provider.streamChat(sameRole, anthropicConfig).next();
    const body = JSON.parse(captured.body);
    assert.strictEqual(body.messages.length, 1);
    assert.strictEqual(body.messages[0].content, 'a\n\nb');
  });
});

suite('provider native token counting', () => {
  test('Anthropic uses /v1/messages/count_tokens (system + messages)', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    const fetchStub = async (url: any, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ input_tokens: 1234 }) };
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new AnthropicProvider();
    const messages: LlmMessage[] = [
      { role: 'system', content: 'you are a helper' },
      { role: 'user', content: 'hello' },
    ];
    const tokens = await provider.countTokens!(messages, { ...config, provider: 'anthropic', apiUrl: 'https://api.anthropic.com' });
    assert.strictEqual(tokens, 1234);
    assert.ok(capturedUrl.endsWith('/v1/messages/count_tokens'), `URL is count_tokens: ${capturedUrl}`);
    assert.strictEqual(capturedBody.system, 'you are a helper');
    assert.ok(Array.isArray(capturedBody.messages));
    assert.strictEqual(capturedBody.messages[0].role, 'user');
  });

  test('Anthropic count_tokens failure degrades to undefined', async () => {
    const fetchStub = async () => ({ ok: false });
    (globalThis as any).fetch = fetchStub;
    const provider = new AnthropicProvider();
    const tokens = await provider.countTokens!([{ role: 'user', content: 'hi' }], { ...config, provider: 'anthropic', apiUrl: 'https://api.anthropic.com' });
    assert.strictEqual(tokens, undefined);
  });

  test('Anthropic count_tokens translates tool calls and results without emitting role: tool', async () => {
    let capturedBody: any = null;
    const fetchStub = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ input_tokens: 1500 }) };
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new AnthropicProvider();
    const messages: LlmMessage[] = [
      { role: 'user', content: 'read a file' },
      { role: 'assistant', content: 'reading', toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
      { role: 'tool', content: 'file contents', toolCallId: 'tc1' },
    ];
    const tokens = await provider.countTokens!(messages, { ...config, provider: 'anthropic', apiUrl: 'https://api.anthropic.com' }, [
      { name: 'read_file', description: 'read', parameters: { type: 'object' } }
    ]);
    assert.strictEqual(tokens, 1500);
    // Anthropic API requires roles to be user or assistant only — never 'tool'
    assert.ok(capturedBody.messages.every((m: any) => m.role === 'user' || m.role === 'assistant'), 'no role: tool emitted');
    // Assistant message contains tool_use block
    const asstMsg = capturedBody.messages.find((m: any) => m.role === 'assistant');
    assert.ok(asstMsg.content.some((b: any) => b.type === 'tool_use' && b.id === 'tc1'), 'tool_use block present');
    // Tool result is packed as tool_result block in user turn
    const userResultMsg = capturedBody.messages[capturedBody.messages.length - 1];
    assert.strictEqual(userResultMsg.role, 'user');
    assert.ok(userResultMsg.content.some((b: any) => b.type === 'tool_result' && b.tool_use_id === 'tc1'), 'tool_result block present');
    // Tools schema is passed
    assert.ok(Array.isArray(capturedBody.tools) && capturedBody.tools.length === 1);
  });

  test('OpenAI reads usage.prompt_tokens from a minimal completion', async () => {
    let capturedBody: any = null;
    const fetchStub = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ usage: { prompt_tokens: 987 } }) };
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new OpenAiProvider();
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
      { role: 'tool', content: '{ "ok": true }', toolCallId: 'c1' },
    ];
    const tokens = await provider.countTokens!(messages, config);
    assert.strictEqual(tokens, 987);
    assert.ok(Array.isArray(capturedBody.messages));
    // Tool messages/assistant tool_calls are passed in native shape so the
    // provider's tokenizer counts them too.
    assert.ok(capturedBody.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'c1'));
  });

  test('OpenAI count degrades to undefined on missing usage', async () => {
    const fetchStub = async () => ({ ok: true, json: async () => ({ choices: [] }) });
    (globalThis as any).fetch = fetchStub;
    const provider = new OpenAiProvider();
    const tokens = await provider.countTokens!([{ role: 'user', content: 'hi' }], config);
    assert.strictEqual(tokens, undefined);
  });

  test('OpenAI count degrades to undefined for reasoning models without issuing HTTP requests', async () => {
    let called = false;
    (globalThis as any).fetch = async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    };
    const provider = new OpenAiProvider();
    const tokens = await provider.countTokens!([{ role: 'user', content: 'hi' }], { ...config, model: 'o1-mini' });
    assert.strictEqual(tokens, undefined);
    assert.strictEqual(called, false, 'no HTTP request should be dispatched for reasoning model');
  });
});

suite('LlmProvider tool payload contract', () => {
  const toolConfig = {
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
  } as unknown as LlmConfig;

  let captured: { body?: string } | undefined;

  function captureFetch(payload: unknown) {
    captured = {};
    (globalThis as any).fetch = async (_url: string, init: any) => {
      captured!.body = init.body;
      return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
    };
  }

  function sentTools(): any[] {
    return JSON.parse(captured!.body!).tools;
  }

  test('chatWithTools sends function payloads with name, description and parameters', async () => {
    captureFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const tools: LlmTool[] = [
      {
        name: 'get_work_items',
        description: 'Fetch work items',
        parameters: {
          type: 'object',
          properties: { id: { type: 'number', description: 'Work item id' } },
          required: ['id'],
        },
      },
    ];

    await new OpenAiProvider().chatWithTools([{ role: 'user', content: 'hi' }], toolConfig, tools);

    assert.deepStrictEqual(sentTools(), [
      {
        type: 'function',
        function: {
          name: 'get_work_items',
          description: 'Fetch work items',
          parameters: {
            type: 'object',
            properties: { id: { type: 'number', description: 'Work item id' } },
            required: ['id'],
          },
        },
      },
    ]);
  });

  test('passes tool schemas through verbatim - no OpenAI strict-mode rewriting', async () => {
    captureFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const parameters = {
      type: 'object',
      properties: {
        filter: { type: ['string', 'null'] },
        nested: { type: 'object', properties: { deep: { type: 'string' } } },
        list: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } } } },
      },
      required: [],
    } as unknown as LlmToolParameter;

    await new OpenAiProvider().chatWithTools([{ role: 'user', content: 'hi' }], toolConfig, [
      { name: 'search', description: 'Search', parameters },
    ]);

    const fn = sentTools()[0].function;
    assert.deepStrictEqual(fn.parameters, parameters);
    assert.strictEqual(fn.strict, undefined, 'strict must not be injected');
  });

  test('does not mutate the caller tool definitions', async () => {
    captureFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const tools = [
      {
        name: 'search',
        description: 'Search',
        parameters: { type: 'object', properties: { filter: { type: ['string', 'null'] } } },
      },
    ] as unknown as LlmTool[];
    const snapshot = JSON.parse(JSON.stringify(tools));

    await new OpenAiProvider().chatWithTools([{ role: 'user', content: 'hi' }], toolConfig, tools);

    assert.deepStrictEqual(tools, snapshot);
  });
});

suite('Source hygiene - no derived Roo-Code helpers in src/', () => {
  const DERIVED_MARKERS = ['convertToolsForOpenAI', 'convertToolSchemaForOpenAI'];

  function findSrcDir(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'src', 'llm', 'types.ts'))) {
        return path.join(dir, 'src');
      }
      dir = path.dirname(dir);
    }
    throw new Error('could not locate src/ from ' + __dirname);
  }

  function productionSources(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'test') {
            continue;
          }
          walk(full);
        } else {
          files.push(full);
        }
      }
    };
    walk(root);
    return files;
  }

  test('no derived strict-mode schema helpers exist anywhere in src/', () => {
    const srcDir = findSrcDir();
    const offenders: string[] = [];
    for (const file of productionSources(srcDir)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const marker of DERIVED_MARKERS) {
        if (text.includes(marker)) {
          offenders.push(path.relative(srcDir, file).split(path.sep).join('/') + ': ' + marker);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], 'derived helpers found - check upstream licence obligations');
  });

  test('no Roo-Code / Cline attribution remains in src/', () => {
    const srcDir = findSrcDir();
    // Matches the upstream project names only - "declined"/"declines" and
    // "root"/"room" cannot match because of the word boundaries.
    const ATTRIBUTION = /\bRoo\b|\bCline\b/i;
    const offenders: string[] = [];
    for (const file of productionSources(srcDir)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (ATTRIBUTION.test(line)) {
          offenders.push(
            path.relative(srcDir, file).split(path.sep).join('/') + ':' + (index + 1) + ' ' + line.trim(),
          );
        }
      });
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'Roo-Code/Cline attribution found in src/ - describe the pattern, not a named source',
    );
  });

  test('the unused BaseProvider module is gone', () => {
    const srcDir = findSrcDir();
    assert.strictEqual(
      fs.existsSync(path.join(srcDir, 'llm', 'providers', 'BaseProvider.ts')),
      false,
      'BaseProvider.ts is unused and carried the derived helpers',
    );
  });
});

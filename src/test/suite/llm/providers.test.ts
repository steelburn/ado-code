import * as assert from 'assert';
import { OpenAiProvider, listModelsOpenAi } from '../../../llm/providers/openai';
import { AnthropicProvider, listModelsAnthropic } from '../../../llm/providers/anthropic';
import { LlmConfig, LlmMessage } from '../../../llm/types';

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

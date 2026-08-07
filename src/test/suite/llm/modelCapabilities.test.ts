import * as assert from 'assert';
import { getModelCapabilities, capabilitiesFromGateway } from '../../../llm/modelCapabilities';

suite('modelCapabilities', () => {
  suite('vision', () => {
    test('flags multimodal families as vision-capable', () => {
      for (const model of [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4.1',
        'gpt-4.1-mini',
        'gpt-4.5',
        'gpt-5',
        'gpt-5-mini',
        'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022',
        'gemini-1.5-pro',
        'gemini-2.0-flash',
        'qwen2.5-vl-7b',
        'Qwen/Qwen2.5-VL-72B-Instruct',
        'pixtral-large-latest',
        'llama-3.2-11b-vision-instruct',
        'llama-4-maverick',
        'gemma-3-27b-it',
        'deepseek-vl2',
        'o1',
        'o3-mini',
        'o4-mini',
        'o5',
      ]) {
        assert.strictEqual(getModelCapabilities(model).vision, true, `vision expected for ${model}`);
      }
    });

    test('treats text-only models as non-vision', () => {
      for (const model of [
        'gpt-4',
        'gpt-3.5-turbo',
        'deepseek-chat',
        'deepseek-reasoner',
        'llama-3.1-8b-instruct',
        'llama-3.3-70b-instruct',
        'mistral-large-latest',
        'command-r-plus',
        'gemma-2-27b-it',
      ]) {
        assert.strictEqual(getModelCapabilities(model).vision, false, `no vision expected for ${model}`);
      }
    });
  });

  suite('tools', () => {
    test('chat models default to tool calling', () => {
      for (const model of [
        'gpt-4o',
        'gpt-3.5-turbo',
        'claude-sonnet-4',
        'gemini-1.5-pro',
        'deepseek-chat',
        'llama-3.1-8b-instruct', // 'instruct' must NOT disable tools
        'qwen2.5-vl-7b',
      ]) {
        assert.strictEqual(getModelCapabilities(model).tools, true, `tools expected for ${model}`);
      }
    });

    test('non-chat endpoints report no tool calling', () => {
      for (const model of [
        'dall-e-3',
        'dall-e-2',
        'whisper-1',
        'tts-1',
        'gpt-3.5-turbo-instruct',
        'text-embedding-3-large',
        'text-embedding-ada-002',
      ]) {
        assert.strictEqual(getModelCapabilities(model).tools, false, `no tools expected for ${model}`);
      }
    });
  });

  test('unknown/empty model ids get safe defaults', () => {
    assert.deepStrictEqual(getModelCapabilities(''), { vision: false, tools: true });
    assert.deepStrictEqual(getModelCapabilities('  '), { vision: false, tools: true });
    assert.deepStrictEqual(getModelCapabilities('my-custom-model-42'), { vision: false, tools: true });
  });

  suite('live gateway hints (OpenRouter/Ollama)', () => {
    test('OpenRouter input_modalities: image ⇒ vision, live wins over heuristic', () => {
      // A model the heuristic knows nothing about — live data must decide.
      const caps = getModelCapabilities('my-vendor/model-x', {
        vision: true,
      });
      assert.strictEqual(caps.vision, true, 'live vision hint honored');
      assert.strictEqual(caps.tools, true, 'tools fall back to heuristic default');
    });

    test('OpenRouter text-only modality overrides a heuristic vision match', () => {
      // Live says NO image for a model whose name smells like vision —
      // the gateway is authoritative.
      const caps = getModelCapabilities('claude-4', { vision: false });
      assert.strictEqual(caps.vision, false, 'live vision:false overrides the claude heuristic');
    });

    test('Ollama capabilities: vision + tools both live', () => {
      const caps = getModelCapabilities('qwen2.5-vl-7b', { vision: true, tools: true });
      assert.strictEqual(caps.vision, true);
      assert.strictEqual(caps.tools, true);
    });

    test('capabilitiesFromGateway parses OpenRouter architecture shape', () => {
      assert.deepStrictEqual(
        capabilitiesFromGateway({ id: 'x', architecture: { input_modalities: ['text', 'image'] } }),
        { vision: true }
      );
      assert.deepStrictEqual(
        capabilitiesFromGateway({ id: 'x', architecture: { input_modalities: ['text'] } }),
        { vision: false }
      );
    });

    test('capabilitiesFromGateway parses Ollama capabilities array', () => {
      assert.deepStrictEqual(
        capabilitiesFromGateway({ name: 'llama3.2-vision', capabilities: ['vision', 'tools', 'completion'] }),
        { vision: true, tools: true }
      );
      assert.deepStrictEqual(
        capabilitiesFromGateway({ name: 'plain-llm', capabilities: ['completion'] }),
        {}
      );
    });

    test('capabilitiesFromGateway returns {} for OpenAI/vLLM plain entries', () => {
      assert.deepStrictEqual(capabilitiesFromGateway({ id: 'gpt-4o' }), {});
      assert.deepStrictEqual(capabilitiesFromGateway({ id: 'gpt-4o', object: 'model', created: 1 }), {});
      assert.deepStrictEqual(capabilitiesFromGateway(null), {});
      assert.deepStrictEqual(capabilitiesFromGateway('gpt-4o'), {});
    });
  });

  suite('user overrides (CapabilityOverride)', () => {
    const overrides = [
      { model: 'deepseek-v4', vision: true },
      { model: 'Ornith-1.0', vision: true, tools: true },
    ];

    test('override marks a heuristic-unknown model as vision-capable', () => {
      const caps = getModelCapabilities('deepseek-v4', undefined, overrides);
      assert.strictEqual(caps.vision, true, 'override wins over heuristic false');
      assert.strictEqual(caps.tools, true, 'tools untouched by partial override');
    });

    test('override wins over live gateway hints', () => {
      // Live says no vision; the user says vision — the user is authoritative.
      const caps = getModelCapabilities('deepseek-v4', { vision: false }, overrides);
      assert.strictEqual(caps.vision, true);
    });

    test('override sets both fields', () => {
      const caps = getModelCapabilities('Ornith-1.0', undefined, overrides);
      assert.deepStrictEqual(caps, { vision: true, tools: true });
    });

    test('override matching is case-insensitive and trimmed', () => {
      const caps = getModelCapabilities('  DeepSeek-V4 ', undefined, overrides);
      assert.strictEqual(caps.vision, true);
    });

    test('override for an unrelated model does not leak', () => {
      const caps = getModelCapabilities('gpt-4o', undefined, overrides);
      assert.strictEqual(caps.vision, true, 'gpt-4o still detected by heuristic');
      const other = getModelCapabilities('unknown-model-9', undefined, overrides);
      assert.strictEqual(other.vision, false, 'unrelated unknown model unaffected');
    });

    test('empty overrides array changes nothing', () => {
      assert.deepStrictEqual(getModelCapabilities('deepseek-v4', undefined, []), { vision: false, tools: true });
    });
  });

  test('dall-e has neither vision input nor tools', () => {
    const caps = getModelCapabilities('dall-e-3');
    assert.strictEqual(caps.vision, false);
    assert.strictEqual(caps.tools, false);
  });
});

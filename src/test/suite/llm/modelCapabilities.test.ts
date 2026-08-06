import * as assert from 'assert';
import { getModelCapabilities } from '../../../llm/modelCapabilities';

suite('modelCapabilities', () => {
  suite('vision', () => {
    test('flags multimodal families as vision-capable', () => {
      for (const model of [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4.1',
        'gpt-4.1-mini',
        'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022',
        'gemini-1.5-pro',
        'gemini-2.0-flash',
        'qwen2.5-vl-7b',
        'Qwen/Qwen2.5-VL-72B-Instruct',
        'pixtral-large-latest',
        'llama-3.2-11b-vision-instruct',
        'o1',
        'o4-mini',
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

  test('dall-e has neither vision input nor tools', () => {
    const caps = getModelCapabilities('dall-e-3');
    assert.strictEqual(caps.vision, false);
    assert.strictEqual(caps.tools, false);
  });
});

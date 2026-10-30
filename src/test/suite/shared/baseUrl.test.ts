import * as assert from 'assert';
import { joinBaseUrl, normalizeBaseUrl, withoutApiVersion } from '../../../llm/providers/baseUrl';

// Guardrail for the base-URL join: a trailing slash in `adoCode.llmApiUrl`
// ("https://api.openai.com/v1/") used to produce
// "https://api.openai.com/v1//chat/completions", which gateways answer with a
// 404 — the fix must leave the scheme's "//" alone and must not double the
// separator for any spelling of the same base URL.

/** The part after the scheme's "//" must never contain a doubled slash. */
function pathPart(url: string): string {
  const schemeEnd = url.indexOf('//');
  return schemeEnd === -1 ? url : url.slice(schemeEnd + 2);
}

suite('llm/providers/baseUrl — normalisation', () => {
  test('strips a single trailing slash', () => {
    assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  });

  test('strips every trailing slash', () => {
    assert.strictEqual(normalizeBaseUrl('https://gateway.local/openai/v1///'), 'https://gateway.local/openai/v1');
  });

  test('trims surrounding whitespace', () => {
    assert.strictEqual(normalizeBaseUrl('  https://api.openai.com/v1/  '), 'https://api.openai.com/v1');
  });

  test('leaves a clean base URL untouched', () => {
    assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
    assert.strictEqual(normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  });

  test('keeps interior slashes and path case', () => {
    assert.strictEqual(normalizeBaseUrl('https://host/Azure/OpenAI/v1'), 'https://host/Azure/OpenAI/v1');
  });

  test('never eats the scheme separator', () => {
    assert.strictEqual(normalizeBaseUrl('https://'), 'https://');
    assert.strictEqual(normalizeBaseUrl('http:///'), 'http://');
  });
});

suite('llm/providers/baseUrl — joinBaseUrl', () => {
  test('joins without doubling the separator (the reported bug)', () => {
    assert.strictEqual(
      joinBaseUrl('https://api.openai.com/v1/', '/chat/completions'),
      'https://api.openai.com/v1/chat/completions'
    );
  });

  test('every spelling of the same base yields the same endpoint', () => {
    const expected = 'https://gateway.local/openai/v1/chat/completions';
    for (const base of [
      'https://gateway.local/openai/v1',
      'https://gateway.local/openai/v1/',
      'https://gateway.local/openai/v1//',
      '  https://gateway.local/openai/v1/  ',
    ]) {
      assert.strictEqual(joinBaseUrl(base, '/chat/completions'), expected, base);
    }
  });

  test('tolerates a path without a leading slash', () => {
    assert.strictEqual(joinBaseUrl('https://host/v1/', 'models'), 'https://host/v1/models');
    assert.strictEqual(joinBaseUrl('https://host/v1/', '/models'), 'https://host/v1/models');
    assert.strictEqual(joinBaseUrl('https://host/v1/', '//models'), 'https://host/v1/models');
  });

  test('never emits a doubled slash after the scheme', () => {
    for (const base of ['https://host/v1/', 'https://host/v1', 'https://host/v1//', 'https://']) {
      assert.ok(!pathPart(joinBaseUrl(base, '/chat/completions')).includes('//'), base);
    }
  });
});

// Anthropic appends its own `/v1/...` paths, and the setting is documented both
// as the bare host and with the version segment — stripping it must therefore
// survive every spelling, including a gateway prefix that itself ends in /v1.
suite('llm/providers/baseUrl — withoutApiVersion', () => {
  test('strips a trailing /v1 so the versioned path can be re-appended', () => {
    assert.strictEqual(withoutApiVersion('https://api.anthropic.com/v1'), 'https://api.anthropic.com');
  });

  test('accepts the Anthropic base URL with or without the version segment', () => {
    for (const base of [
      'https://api.anthropic.com',
      'https://api.anthropic.com/',
      'https://api.anthropic.com/v1',
      'https://api.anthropic.com/v1/',
      'https://api.anthropic.com/v1//',
      '  https://api.anthropic.com/v1/  ',
    ]) {
      assert.strictEqual(joinBaseUrl(withoutApiVersion(base), '/v1/messages'), 'https://api.anthropic.com/v1/messages', base);
    }
  });

  test('round-trips a gateway prefix that ends in /v1', () => {
    assert.strictEqual(
      joinBaseUrl(withoutApiVersion('https://gw.local/anthropic/v1/'), '/v1/messages'),
      'https://gw.local/anthropic/v1/messages'
    );
  });

  test('only strips the version segment, and only when it is last', () => {
    assert.strictEqual(withoutApiVersion('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
    assert.strictEqual(withoutApiVersion('https://gw.local/anthropic/v2'), 'https://gw.local/anthropic/v2');
    assert.strictEqual(withoutApiVersion('https://gw.local/v1/anthropic'), 'https://gw.local/v1/anthropic');
    assert.strictEqual(withoutApiVersion('https://gw.local/api/v2', 'v2'), 'https://gw.local/api');
  });
});

import * as assert from 'assert';
import { DEFAULT_HEADERS_TIMEOUT_MS, isRetryableStatus, llmFetch } from '../../../llm/providers/net';

// Guardrail for the hardened fetch wrapper: transient network failures and
// retryable statuses must be retried with backoff, permanent ones must not, and
// a request that never answers must abort with a described timeout instead of
// hanging the turn forever.

const noSleep = async (): Promise<void> => undefined;

function withCode(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${code} message`), { code, ...extra });
}

function fetchFailed(cause: unknown): Error {
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

/** Install a fetch stub, returning the recorded calls and a restore fn. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const previous = (globalThis as { fetch?: unknown }).fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return {
    calls,
    restore: () => {
      (globalThis as { fetch?: unknown }).fetch = previous;
    },
  };
}

const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

suite('llm/providers/net — llmFetch', () => {
  test('has a generous default headers timeout', () => {
    assert.ok(DEFAULT_HEADERS_TIMEOUT_MS >= 60_000);
  });

  test('retries a transient socket drop, then succeeds', async () => {
    let attempt = 0;
    const stub = stubFetch(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw fetchFailed(withCode('ECONNRESET', { hostname: 'api.example.com' }));
      }
      return ok();
    });
    const retries: string[] = [];
    try {
      const response = await llmFetch('https://api.example.com/v1/chat/completions', {
        label: 'OpenAI',
        method: 'POST',
        body: '{}',
        sleep: noSleep,
        onRetry: info => retries.push(info.reason),
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(stub.calls.length, 2);
      assert.strictEqual(retries.length, 1);
      assert.match(retries[0], /closed mid-request/);
    } finally {
      stub.restore();
    }
  });

  test('gives up after the retry budget with a described error', async () => {
    const stub = stubFetch(async () => {
      throw fetchFailed(withCode('ECONNRESET', { hostname: 'api.example.com' }));
    });
    try {
      await assert.rejects(
        () =>
          llmFetch('https://api.example.com/v1/messages', {
            label: 'Anthropic',
            method: 'POST',
            body: '{}',
            retries: 2,
            sleep: noSleep,
          }),
        (err: Error) => {
          assert.match(err.message, /^Anthropic request failed: the connection to api\.example\.com/);
          assert.doesNotMatch(err.message, /^fetch failed$/);
          return true;
        }
      );
      assert.strictEqual(stub.calls.length, 3, '1 attempt + 2 retries');
    } finally {
      stub.restore();
    }
  });

  test('does not retry a permanent failure (DNS misconfiguration)', async () => {
    const stub = stubFetch(async () => {
      throw fetchFailed(withCode('ENOTFOUND', { hostname: 'nope.invalid' }));
    });
    try {
      await assert.rejects(
        () =>
          llmFetch('https://nope.invalid/v1/models', { label: 'OpenAI', retries: 3, sleep: noSleep }),
        /DNS lookup failed/
      );
      assert.strictEqual(stub.calls.length, 1, 'retrying a wrong base URL is pointless');
    } finally {
      stub.restore();
    }
  });

  test('retries a 503 and consumes the first body', async () => {
    let attempt = 0;
    const stub = stubFetch(async () => {
      attempt += 1;
      return attempt === 1 ? new Response('overloaded', { status: 503 }) : ok();
    });
    const retries: string[] = [];
    try {
      const response = await llmFetch('https://api.example.com/v1/chat/completions', {
        label: 'OpenAI',
        method: 'POST',
        body: '{}',
        sleep: noSleep,
        onRetry: info => retries.push(info.reason),
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(stub.calls.length, 2);
      assert.deepStrictEqual(retries, ['HTTP 503']);
    } finally {
      stub.restore();
    }
  });

  test('a request that never answers aborts with a described timeout', async () => {
    const stub = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        })
    );
    try {
      await assert.rejects(
        () =>
          llmFetch('https://api.example.com/v1/chat/completions', {
            label: 'OpenAI',
            method: 'POST',
            body: '{}',
            timeoutMs: 5,
            retries: 0,
            sleep: noSleep,
          }),
        (err: Error) => {
          assert.match(err.message, /no response from api\.example\.com within 5ms/);
          assert.match(err.message, /raise the request timeout/);
          return true;
        }
      );
    } finally {
      stub.restore();
    }
  });

  test('a non-replayable body is never retried', async () => {
    const stub = stubFetch(async () => {
      throw fetchFailed(withCode('ECONNRESET'));
    });
    try {
      await assert.rejects(() =>
        llmFetch('https://api.example.com/v1/chat/completions', {
          label: 'OpenAI',
          method: 'POST',
          body: new ReadableStream(),
          sleep: noSleep,
        })
      );
      assert.strictEqual(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });

  test('a caller abort is passed through untouched and not retried', async () => {
    const controller = new AbortController();
    const stub = stubFetch(async (_url, init) => {
      controller.abort();
      // Bare `fetch` rejects with AbortError when the caller's signal fires.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        });
        if (init.signal?.aborted) {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        }
      });
    });
    controller.abort();
    try {
      await assert.rejects(
        () =>
          llmFetch('https://api.example.com/v1/chat/completions', {
            label: 'OpenAI',
            method: 'POST',
            body: '{}',
            signal: controller.signal,
            sleep: noSleep,
          }),
        (err: Error) => {
          // The Stop button must not be reported as a described network failure.
          assert.strictEqual(err.name, 'AbortError');
          assert.strictEqual(err.message, 'This operation was aborted');
          return true;
        }
      );
      assert.strictEqual(stub.calls.length, 1, 'no retry after a deliberate abort');
      assert.strictEqual(stub.calls[0].init.signal?.aborted, true, 'the caller signal still reaches fetch');
    } finally {
      stub.restore();
    }
  });

  test('retryable status set matches the overload/timeout signals only', () => {
    assert.strictEqual(isRetryableStatus(429), true);
    assert.strictEqual(isRetryableStatus(503), true);
    assert.strictEqual(isRetryableStatus(400), false);
    assert.strictEqual(isRetryableStatus(401), false);
    assert.strictEqual(isRetryableStatus(404), false);
  });
});

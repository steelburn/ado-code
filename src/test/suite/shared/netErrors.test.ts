import * as assert from 'assert';
import { collectCauseChain, describeFetchFailure, isTransientNetworkError, toFetchError } from '../../../shared/netErrors';

// Regression guard for the "fetch failed" reports: undici hides the real reason
// on `error.cause`, so every consumer that printed `error.message` showed users
// a bare "fetch failed" — identical for a wrong base URL, DNS/VPN loss, a dead
// socket and a TLS-inspecting proxy. These tests pin the description (and the
// "worth retrying?" verdict) each of those cases now produces.

/** Undici's real shape: opaque wrapper + the detail hidden on `cause`. */
function fetchFailed(cause: unknown, message = 'fetch failed'): Error {
  const err = new TypeError(message);
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

function withCode(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${code} message`), { code, ...extra });
}

suite('shared/netErrors — describing a network failure', () => {
  test('walks the cause chain', () => {
    const err = fetchFailed(withCode('ENOTFOUND', { hostname: 'api.example.com', syscall: 'getaddrinfo' }));
    const chain = collectCauseChain(err);

    assert.strictEqual(chain.length, 2, 'wrapper + cause');
    assert.strictEqual(chain[0].message, 'fetch failed');
    assert.strictEqual(chain[1].code, 'ENOTFOUND');
    assert.strictEqual(chain[1].hostname, 'api.example.com');
  });

  test('DNS failure names the host and is not worth retrying', () => {
    const failure = describeFetchFailure(
      fetchFailed(withCode('ENOTFOUND', { hostname: 'api.example.com' })),
      { label: 'OpenAI', url: 'https://api.example.com/v1/chat/completions' }
    );

    assert.match(failure.message, /^OpenAI request failed: DNS lookup failed for api\.example\.com/);
    assert.match(failure.message, /ENOTFOUND/);
    assert.match(failure.message, /base URL is wrong/i);
    assert.strictEqual(failure.code, 'ENOTFOUND');
    assert.strictEqual(failure.transient, false);
    assert.strictEqual(failure.timedOut, false);
  });

  test('a dropped socket is transient (retry is safe)', () => {
    const failure = describeFetchFailure(
      fetchFailed(withCode('ECONNRESET', { hostname: 'gateway.local', port: 8080 })),
      { label: 'Anthropic', url: 'https://gateway.local:8080/v1/messages' }
    );

    assert.match(failure.message, /closed mid-request/);
    assert.match(failure.message, /gateway\.local:8080/);
    assert.strictEqual(failure.transient, true);
    assert.strictEqual(isTransientNetworkError(fetchFailed(withCode('ECONNRESET'))), true);
  });

  test('our own headers timeout is reported as a timeout, not a crash', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const failure = describeFetchFailure(fetchFailed(abort), {
      label: 'OpenAI',
      url: 'https://api.example.com/v1/chat/completions',
      timedOut: true,
      timeoutMs: 120_000,
    });

    assert.match(failure.message, /no response from api\.example\.com within 120s/);
    assert.strictEqual(failure.timedOut, true);
    assert.strictEqual(failure.transient, true);
  });

  test('TLS-inspecting proxy gets the certificate hint and is not retried', () => {
    const failure = describeFetchFailure(fetchFailed(withCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE')), {
      label: 'OpenAI',
      url: 'https://api.example.com/v1/models',
    });

    assert.match(failure.message, /TLS certificate verification failed/);
    assert.match(failure.message, /NODE_EXTRA_CA_CERTS/);
    assert.strictEqual(failure.transient, false);
  });

  test('AggregateError (happy eyeballs) is unwrapped to the real code', () => {
    const aggregate = Object.assign(new AggregateError([withCode('ECONNREFUSED', { hostname: 'api.example.com' })], 'all failed'), {
      name: 'AggregateError',
    });
    const failure = describeFetchFailure(fetchFailed(aggregate), { label: 'OpenAI' });

    assert.strictEqual(failure.code, 'ECONNREFUSED');
    assert.match(failure.message, /was refused/);
  });

  test('a bare "fetch failed" with no cause still says something actionable', () => {
    const failure = describeFetchFailure(fetchFailed(undefined), {
      label: 'OpenAI',
      url: 'https://api.example.com/v1/models',
    });

    assert.doesNotMatch(failure.message, /^OpenAI request failed: fetch failed\.$/);
    assert.match(failure.message, /could not be completed/);
    assert.match(failure.message, /api\.example\.com/);
  });

  test('non-network errors keep their own message', () => {
    const failure = describeFetchFailure(new Error('OpenAI API error: 400 bad request'), { label: 'OpenAI' });

    assert.match(failure.message, /OpenAI API error: 400 bad request/);
  });

  test('toFetchError carries the cause, code and transient flag', () => {
    const cause = fetchFailed(withCode('ETIMEDOUT', { hostname: 'api.example.com' }));
    const error = toFetchError(cause, { label: 'OpenAI', url: 'https://api.example.com/v1/models' }) as Error & {
      cause?: unknown;
      code?: string;
      transient?: boolean;
    };

    assert.strictEqual(error.cause, cause);
    assert.strictEqual(error.code, 'ETIMEDOUT');
    assert.strictEqual(error.transient, true);
    assert.match(error.message, /timed out/);
  });
});

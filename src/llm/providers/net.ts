/**
 * The one `fetch` wrapper every LLM request goes through.
 *
 * It exists because the providers used to call bare `fetch`:
 *  - a network failure surfaced as literal "fetch failed" (undici keeps the
 *    real reason on `error.cause`) with no retry, so a two-second Wi-Fi blip or
 *    a 503 from a gateway killed the whole turn;
 *  - nothing bounded the wait, so a blackholed request (VPN drop, DNS sinkhole)
 *    hung the chat with no feedback at all.
 *
 * `llmFetch` therefore: bounds the *headers* phase with an abortable timeout
 * (a stream may legitimately run long after its headers, so the timer is
 * cleared once they arrive), retries transient network errors and retryable
 * statuses with backoff, and rethrows a described error from `netErrors`.
 */
import { describeFetchFailure, isTransientNetworkError, toFetchError } from '../../shared/netErrors';

/**
 * How long to wait for response *headers*. Generous because reasoning models
 * can think for a long time before emitting the first byte of a stream.
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 120_000;

/** Statuses worth retrying: overload/timeout signals, not client mistakes. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const MAX_BACKOFF_MS = 8_000;

export interface LlmFetchInit extends RequestInit {
  /** Human label used in error messages and retry notices, e.g. "OpenAI". */
  label: string;
  /** Headers timeout in ms (default {@link DEFAULT_HEADERS_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Retry budget for transient failures (default 2 → up to 3 attempts). */
  retries?: number;
  /** Called before each retry so the UI can show "retrying (1/2)…". */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** Injectable timer, used by tests to run without real delays. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** `Retry-After` as ms, when present and sane. */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
  }
  return undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
}

/** Release the socket of a response we are about to discard. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed / no body — nothing to release.
  }
}

/**
 * `fetch` with a headers timeout. Resolves as soon as headers arrive; the
 * timeout is cleared at that point so a long stream is not aborted. A failure
 * keeps its original `cause` chain and gets a `timedOut` marker attached.
 */
async function fetchWithHeadersTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Do not keep the extension host alive just for this timer.
  if (typeof timer === 'object' && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  // The caller owns a signal of its own (chat Stop, a superseded turn). It must
  // keep working — our controller only *adds* the timeout — so chain it in
  // instead of replacing it. It stays attached after the headers arrive so an
  // abort mid-stream still tears the body down, exactly as bare `fetch` did.
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) {
      controller.abort();
    } else {
      outer.addEventListener('abort', onOuterAbort, { once: true });
    }
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    (failure as Error & { timedOut?: boolean }).timedOut = timedOut;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch` for LLM traffic: headers timeout, transient retry, actionable errors.
 * Throws `Error` (never the raw undici `TypeError`).
 */
export async function llmFetch(url: string, init: LlmFetchInit): Promise<Response> {
  const { label, timeoutMs = DEFAULT_HEADERS_TIMEOUT_MS, retries = 2, onRetry, sleep = defaultSleep, ...requestInit } =
    init;
  const maxAttempts = Math.max(1, Math.floor(retries) + 1);
  // A stream/FormData body cannot be replayed, so retrying is only safe for the
  // string bodies the providers actually send.
  const replayable = requestInit.body === undefined || requestInit.body === null || typeof requestInit.body === 'string';

  let lastFailure: { err: unknown; timedOut: boolean } | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithHeadersTimeout(url, requestInit, timeoutMs);
      if (RETRYABLE_STATUS.has(response.status) && replayable && attempt < maxAttempts) {
        const delayMs = retryAfterMs(response) ?? backoffMs(attempt);
        await discard(response);
        onRetry?.({ attempt, delayMs, reason: `HTTP ${response.status}` });
        await sleep(delayMs);
        continue;
      }
      return response;
    } catch (thrown) {
      // fetchWithHeadersTimeout marks our own aborts on the rethrown error.
      const err = thrown;
      const timedOut = !!(thrown as { timedOut?: boolean } | null)?.timedOut;
      // A caller abort (chat Stop, superseded turn) is not a failure: pass it
      // through untouched and without retrying, so nothing gets rewritten into
      // a bogus "network error".
      if (requestInit.signal?.aborted) {
        throw err;
      }
      lastFailure = { err, timedOut };
      const transient = timedOut || isTransientNetworkError(err);
      if (!transient || !replayable || attempt >= maxAttempts) {
        throw toFetchError(err, { label, url, timedOut, timeoutMs });
      }
      const delayMs = backoffMs(attempt);
      onRetry?.({
        attempt,
        delayMs,
        reason: describeFetchFailure(err, { label, url, timedOut }).message,
      });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw toFetchError(lastFailure?.err, { label, url, timedOut: lastFailure?.timedOut, timeoutMs });
}

/** A retryable HTTP status worth surfacing to the user as "will retry". */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

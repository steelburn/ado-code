/**
 * Resilience artifacts (ZEN handbook §4.2, clause CON-06).
 *
 * The handbook makes four things mandatory for every synchronous call: a 2-3s
 * timeout, bounded exponential backoff **with jitter**, a circuit breaker per
 * dependency, and an `Idempotency-Key` guard on non-idempotent writes. Until now
 * `ARCHITECTURE.md` stated those rules and no code backed them, so every
 * scaffolded service re-invented - or skipped - them.
 *
 * This module is the single source of the `packages/shared/src/resilience.ts`
 * body that carries the implementation. The numbers are exported here so the
 * generated code, the documentation and the tests cannot disagree.
 */

export interface ResilienceFile {
  /** Path relative to the repository root. */
  path: string;
  content: string;
}

/** Directory the generated shared package keeps its modules in. */
export const RESILIENCE_DIR = 'packages/shared/src';

export const RESILIENCE_PATH = `${RESILIENCE_DIR}/resilience.ts`;

/**
 * The handbook's numbers, in one place. `timeoutMs` sits in the mandated 2-3s
 * window; `attempts` counts the first call. Changing a value here changes the
 * generated module, the docs table and the tests together.
 */
export const RESILIENCE_DEFAULTS = {
  timeoutMs: 2500,
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  failureThreshold: 5,
  halfOpenAfterMs: 10_000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  maxIdempotencyKeyLength: 128,
} as const;

/** The header a caller sets to make a non-idempotent write safe to retry. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Each handbook obligation mapped to the symbol that satisfies it. The
 * scaffolding surfaces this as the `ARCHITECTURE.md` rule table, so a rule that
 * has no symbol behind it is visible as a gap rather than a promise.
 */
export interface ResilienceRule {
  /** The obligation, as stated in the handbook. */
  rule: string;
  /** Exported symbol that implements it. */
  symbol: string;
  /** One-line usage note shown next to the symbol. */
  note: string;
}

export const RESILIENCE_RULES: ResilienceRule[] = [
  {
    rule: 'Every outbound call has a 2-3s timeout.',
    symbol: 'withTimeout',
    note: `defaults to RESILIENCE_DEFAULTS.timeoutMs (${RESILIENCE_DEFAULTS.timeoutMs}ms) and aborts the signal it hands you`,
  },
  {
    rule: 'Retries are bounded and back off exponentially with jitter.',
    symbol: 'retry',
    note: `RESILIENCE_DEFAULTS.attempts attempts, full jitter over min(${RESILIENCE_DEFAULTS.maxDelayMs}ms, ${RESILIENCE_DEFAULTS.baseDelayMs}ms * 2^attempt)`,
  },
  {
    rule: 'A failing dependency is cut off instead of queued against.',
    symbol: 'CircuitBreaker',
    note: `opens after ${RESILIENCE_DEFAULTS.failureThreshold} consecutive failures, half-open probe after ${RESILIENCE_DEFAULTS.halfOpenAfterMs}ms`,
  },
  {
    rule: 'Non-idempotent writes are keyed with Idempotency-Key.',
    symbol: 'IdempotencyGuard',
    note: 'one effect per key, concurrent duplicates share the in-flight call, a changed payload with the same key is a 409',
  },
];

const defaultsBlock = [
  'export const RESILIENCE_DEFAULTS = {',
  `  /** The handbook window for synchronous calls: 2-3s. */`,
  `  timeoutMs: ${RESILIENCE_DEFAULTS.timeoutMs},`,
  `  /** Total attempts - the first call counts. */`,
  `  attempts: ${RESILIENCE_DEFAULTS.attempts},`,
  `  baseDelayMs: ${RESILIENCE_DEFAULTS.baseDelayMs},`,
  `  maxDelayMs: ${RESILIENCE_DEFAULTS.maxDelayMs},`,
  `  /** Consecutive failures that trip a breaker. */`,
  `  failureThreshold: ${RESILIENCE_DEFAULTS.failureThreshold},`,
  `  /** How long a tripped breaker stays open before a half-open probe. */`,
  `  halfOpenAfterMs: ${RESILIENCE_DEFAULTS.halfOpenAfterMs},`,
  `  /** How long a replayed reply is kept. */`,
  `  idempotencyTtlMs: ${RESILIENCE_DEFAULTS.idempotencyTtlMs},`,
  '} as const;',
].join('\n');

/**
 * The generated module. Written with string concatenation rather than nested
 * template literals on purpose: the body is emitted verbatim, so nothing in it
 * may be interpreted by this file's own interpolation.
 */
const RESILIENCE_SOURCE = `/**
 * Resilience primitives (ZEN handbook §4.2, clause CON-06).
 *
 * EVERY outbound call - HTTP, broker publish, database - goes through these
 * rather than an inline Promise.race or a bare await:
 *
 *   withTimeout()      a bounded wait, 2-3s by default
 *   retry()            bounded exponential backoff with full jitter
 *   CircuitBreaker     per-dependency fail-fast after repeated failures
 *   IdempotencyGuard   one effect per Idempotency-Key, duplicates replayed
 *
 * Import them from the shared package barrel. Do not hand-roll a timeout.
 */

${defaultsBlock}

/** Header a caller sets to make a non-idempotent write safe to retry. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Upper bound on the key we will accept; longer keys are ignored. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = ${RESILIENCE_DEFAULTS.maxIdempotencyKeyLength};

/** The call did not finish inside its deadline. */
export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';

  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(label + ' timed out after ' + timeoutMs + 'ms');
    this.name = 'TimeoutError';
  }
}

/** The breaker is open, so the call was refused without touching the dependency. */
export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';

  constructor(readonly dependency: string) {
    super('circuit open for ' + dependency);
    this.name = 'CircuitOpenError';
  }
}

/** The same key arrived with a different payload - a client bug, not a retry. */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly key: string) {
    super('idempotency key ' + key + ' was already used with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * Await an operation with a hard deadline. The operation receives an
 * AbortSignal so a fetch/inflight request is actually cancelled rather than
 * merely abandoned.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = RESILIENCE_DEFAULTS.timeoutMs,
  label: string = 'operation'
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Reject before aborting: abort() runs the operation's listeners
      // synchronously, and a listener that rejects would otherwise win the
      // race and hide the timeout behind whatever the operation threw.
      reject(new TimeoutError(label, timeoutMs));
      controller.abort();
    }, timeoutMs);
    unref(timer);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    // Ordering above makes this rare, but the caller must be able to rely on
    // TimeoutError: it is what retry() and the logs branch on.
    if (timedOut && !(error instanceof TimeoutError)) throw new TimeoutError(label, timeoutMs);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RetryOptions {
  /** Total attempts, first call included. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests: full jitter draws one uniform value per retry. */
  random?: () => number;
  /** Injectable for tests: replace the timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Return false to stop retrying (validation errors, 4xx, ...). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Full jitter: a uniform delay in [0, min(maxDelayMs, baseDelayMs * 2^attempt)).
 * Full - rather than equal - jitter is what stops synchronised clients from
 * retrying in lockstep and re-creating the spike that made them retry.
 */
export function backoffDelay(
  attempt: number,
  options: RetryOptions = {},
  random: () => number = options.random ?? Math.random
): number {
  const base = options.baseDelayMs ?? RESILIENCE_DEFAULTS.baseDelayMs;
  const max = options.maxDelayMs ?? RESILIENCE_DEFAULTS.maxDelayMs;
  const ceiling = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  return Math.round(ceiling * random());
}

/** Retry unless the error says retrying cannot help. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;
  if (error instanceof IdempotencyConflictError) return false;
  const candidate = error as { status?: unknown; retryable?: unknown } | null;
  if (candidate && candidate.retryable === false) return false;
  if (candidate && typeof candidate.status === 'number') {
    if (candidate.status >= 400 && candidate.status < 500) return false;
  }
  return true;
}

/**
 * Retry with bounded exponential backoff. Give it the same Idempotency-Key on
 * every attempt and a retried write cannot duplicate the effect.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? RESILIENCE_DEFAULTS.attempts);
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? isRetryable;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error, attempt)) throw error;
      await sleep(backoffDelay(attempt, options, options.random ?? Math.random));
    }
  }
  throw lastError;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  halfOpenAfterMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * One breaker per dependency (never per call site). While open it fails fast
 * with CircuitOpenError, so a sick dependency sheds load instead of collecting
 * a queue of doomed requests. After halfOpenAfterMs it admits a single probe:
 * success closes it, failure re-opens it immediately.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private current: CircuitState = 'closed';
  private probeInFlight = false;

  constructor(
    readonly dependency: string,
    private readonly options: CircuitBreakerOptions = {}
  ) {}

  get state(): CircuitState {
    if (this.current === 'open') {
      const now = (this.options.now ?? Date.now)();
      if (now - this.openedAt >= (this.options.halfOpenAfterMs ?? RESILIENCE_DEFAULTS.halfOpenAfterMs)) {
        this.current = 'half-open';
      }
    }
    return this.current;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * Record a success. Also the entry point for callers that stream a response
   * and therefore cannot wrap the whole exchange in execute().
   */
  recordSuccess(): void {
    this.failures = 0;
    this.current = 'closed';
  }

  /**
   * Record a failure and trip the breaker at the threshold. A failure during a
   * half-open probe re-opens immediately: one bad probe is evidence enough.
   */
  recordFailure(): void {
    this.failures += 1;
    const tripped =
      this.current === 'half-open' ||
      this.failures >= (this.options.failureThreshold ?? RESILIENCE_DEFAULTS.failureThreshold);
    if (tripped) {
      this.current = 'open';
      this.openedAt = (this.options.now ?? Date.now)();
    }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open') throw new CircuitOpenError(this.dependency);
    if (state === 'half-open') {
      if (this.probeInFlight) throw new CircuitOpenError(this.dependency);
      this.probeInFlight = true;
    }
    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      this.probeInFlight = false;
    }
  }
}

export interface IdempotentReply<T> {
  status: number;
  body: T;
}

export interface IdempotentOutcome<T> extends IdempotentReply<T> {
  /** True when the reply was served from the store instead of re-executed. */
  replayed: boolean;
}

export interface IdempotencyOptions {
  ttlMs?: number;
  now?: () => number;
}

interface StoredEntry {
  fingerprint: string;
  storedAt: number;
  pending?: Promise<IdempotentReply<unknown>>;
  reply?: IdempotentReply<unknown>;
}

/**
 * Exactly-once effects for keyed writes. Concurrent duplicates share the
 * in-flight call; a completed duplicate replays the stored reply; a key reused
 * with a different payload is a conflict rather than a replay. Entries expire
 * after idempotencyTtlMs, and a failed call releases its key so the client may
 * retry it.
 */
export class IdempotencyGuard {
  private readonly store = new Map<string, StoredEntry>();

  constructor(private readonly options: IdempotencyOptions = {}) {}

  get size(): number {
    this.prune();
    return this.store.size;
  }

  async once<T>(
    key: string,
    fingerprint: string,
    operation: () => Promise<IdempotentReply<T>>
  ): Promise<IdempotentOutcome<T>> {
    const existing = this.lookup(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError(key);
      if (existing.pending) {
        const settled = await existing.pending;
        return { status: settled.status, body: settled.body as T, replayed: true };
      }
      if (existing.reply) {
        return { status: existing.reply.status, body: existing.reply.body as T, replayed: true };
      }
    }
    const pending = operation();
    const entry: StoredEntry = { fingerprint, storedAt: this.now(), pending };
    this.store.set(key, entry);
    try {
      const reply = await pending;
      entry.pending = undefined;
      entry.reply = reply;
      entry.storedAt = this.now();
      return { status: reply.status, body: reply.body, replayed: false };
    } catch (error) {
      this.store.delete(key);
      throw error;
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private lookup(key: string): StoredEntry | undefined {
    this.prune();
    return this.store.get(key);
  }

  private prune(): void {
    const ttl = this.options.ttlMs ?? RESILIENCE_DEFAULTS.idempotencyTtlMs;
    const now = this.now();
    for (const [key, entry] of this.store) {
      if (entry.pending) continue;
      if (now - entry.storedAt >= ttl) this.store.delete(key);
    }
  }
}

/** Read the key from inbound headers, case-insensitively. */
export function idempotencyKeyOf(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== IDEMPOTENCY_HEADER) continue;
    const value = headers[name];
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return undefined;
    const key = raw.trim();
    if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return undefined;
    return key;
  }
  return undefined;
}

/**
 * Stable fingerprint of a request, so "same key, different body" can be told
 * apart from a genuine retry. Key order is normalised; object bodies hash the
 * same regardless of property order.
 */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return fnv1a(method.toUpperCase() + ' ' + path + ' ' + stableStringify(body));
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortValue(value)) ?? 'null';
  } catch {
    return String(value);
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}

/** FNV-1a, 32-bit, hex - a fingerprint, not a security primitive. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function unref(timer: ReturnType<typeof setTimeout> | undefined): void {
  const candidate = timer as { unref?: () => void } | undefined;
  if (candidate && typeof candidate.unref === 'function') candidate.unref();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    unref(timer);
  });
}
`;

/**
 * The file the monorepo writer emits for CON-06. One module, so a rule can name
 * one path: `packages/shared/src/resilience.ts`.
 */
export function planResilienceFiles(): ResilienceFile[] {
  return [{ path: RESILIENCE_PATH, content: RESILIENCE_SOURCE }];
}

/** Barrel lines the shared package index needs for the module above. */
export function sharedResilienceBarrelLines(): string[] {
  return ["export * from './resilience';"];
}

/** The generated module's text, for tests and documentation. */
export function resilienceSource(): string {
  return RESILIENCE_SOURCE;
}

/**
 * The `ARCHITECTURE.md` rule rows. Each handbook obligation becomes a row whose
 * right-hand column is a symbol that exists in the shared package.
 */
export function resilienceArchitectureRows(): string[] {
  return RESILIENCE_RULES.map(
    (entry) => `| ${entry.rule} | \`${entry.symbol}\` - ${entry.note} |`
  );
}

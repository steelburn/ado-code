import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  IDEMPOTENCY_HEADER,
  RESILIENCE_DEFAULTS,
  RESILIENCE_PATH,
  RESILIENCE_RULES,
  planResilienceFiles,
  resilienceArchitectureRows,
  resilienceSource,
  sharedResilienceBarrelLines,
} from '../../../shared/resilienceArtifacts';

/**
 * The scaffolded service runs the *generated* module, not this repository's
 * TypeScript. So the clause is tested by transpiling the generated source and
 * exercising it, with an injected clock/sleep/random so nothing depends on wall
 * time.
 */

interface IdempotencyGuardInstance {
  size: number;
  once<T>(
    key: string,
    fingerprint: string,
    operation: () => Promise<{ status: number; body: T }>
  ): Promise<{ status: number; body: T; replayed: boolean }>;
}

interface CircuitBreakerInstance {
  state: string;
  consecutiveFailures: number;
  recordSuccess(): void;
  recordFailure(): void;
  execute<T>(operation: () => Promise<T>): Promise<T>;
}

interface ResilienceModule {
  RESILIENCE_DEFAULTS: Record<string, number>;
  IDEMPOTENCY_HEADER: string;
  MAX_IDEMPOTENCY_KEY_LENGTH: number;
  TimeoutError: new (label: string, timeoutMs: number) => Error & { code: string };
  CircuitOpenError: new (dependency: string) => Error & { code: string };
  IdempotencyConflictError: new (key: string) => Error & { code: string };
  withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
    label?: string
  ): Promise<T>;
  backoffDelay(attempt: number, options?: Record<string, unknown>, random?: () => number): number;
  retry<T>(operation: (attempt: number) => Promise<T>, options?: Record<string, unknown>): Promise<T>;
  isRetryable(error: unknown): boolean;
  CircuitBreaker: new (dependency: string, options?: Record<string, unknown>) => CircuitBreakerInstance;
  IdempotencyGuard: new (options?: Record<string, unknown>) => IdempotencyGuardInstance;
  idempotencyKeyOf(headers: Record<string, string | string[] | undefined>): string | undefined;
  requestFingerprint(method: string, path: string, body: unknown): string;
}

let loaded: ResilienceModule | undefined;

function load(): ResilienceModule {
  if (loaded) return loaded;
  const js = ts.transpileModule(resilienceSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function('exports', 'require', 'module', js);
  factory(module.exports, require, module);
  loaded = module.exports as unknown as ResilienceModule;
  return loaded;
}

function failure(message = 'boom'): () => Promise<never> {
  return () => Promise.reject(new Error(message));
}

suite('resilienceArtifacts', () => {
  suite('generated file', () => {
    test('emits exactly one module at the documented path', () => {
      const files = planResilienceFiles();
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].path, RESILIENCE_PATH);
      assert.strictEqual(RESILIENCE_PATH, 'packages/shared/src/resilience.ts');
      assert.strictEqual(files[0].content, resilienceSource());
    });

    test('has no runtime dependencies and does not log', () => {
      const source = resilienceSource();
      assert.ok(!/^\s*import\s/m.test(source), 'generated module must not import anything');
      assert.ok(!/require\(/.test(source), 'generated module must not require anything at runtime');
      assert.ok(!/console\./.test(source), 'use the shared JSON logger, not console');
    });

    test('barrel exports the module so services can import it from the package', () => {
      const lines = sharedResilienceBarrelLines();
      assert.deepStrictEqual(lines, ["export * from './resilience';"]);
    });

    test('every handbook rule names a symbol the module actually exports', () => {
      const mod = load() as unknown as Record<string, unknown>;
      assert.ok(RESILIENCE_RULES.length >= 4);
      for (const rule of RESILIENCE_RULES) {
        const exported = mod[rule.symbol];
        assert.ok(
          typeof exported === 'function',
          `rule "${rule.rule}" names ${rule.symbol}, which the generated module does not export`
        );
        assert.ok(rule.note.length > 0, `rule "${rule.rule}" has no usage note`);
      }
    });

    test('architecture rows render one table row per rule with the symbol in backticks', () => {
      const rows = resilienceArchitectureRows();
      assert.strictEqual(rows.length, RESILIENCE_RULES.length);
      for (const [index, row] of rows.entries()) {
        assert.ok(row.startsWith('| '), 'row must be a markdown table row');
        assert.ok(row.includes(`\`${RESILIENCE_RULES[index].symbol}\``));
        assert.ok(row.trimEnd().endsWith('|'));
      }
    });

    test('timeout default sits inside the mandated 2-3s window', () => {
      assert.strictEqual(RESILIENCE_DEFAULTS.timeoutMs, load().RESILIENCE_DEFAULTS.timeoutMs);
      assert.ok(RESILIENCE_DEFAULTS.timeoutMs >= 2000);
      assert.ok(RESILIENCE_DEFAULTS.timeoutMs <= 3000);
    });
  });

  suite('withTimeout', () => {
    test('resolves an operation that finishes inside the deadline', async () => {
      const value = await load().withTimeout(async () => 'ok', 200, 'fast');
      assert.strictEqual(value, 'ok');
    });

    test('rejects a slow operation with TimeoutError and aborts its signal', async () => {
      const { withTimeout, TimeoutError } = load();
      let aborted = false;
      const slow = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      await assert.rejects(
        () => withTimeout(slow, 20, 'slow-call'),
        (error: Error) => {
          assert.ok(error instanceof TimeoutError);
          assert.strictEqual((error as Error & { code: string }).code, 'TIMEOUT');
          assert.ok(error.message.includes('slow-call'));
          assert.ok(error.message.includes('20ms'));
          return true;
        }
      );
      assert.ok(aborted, 'the signal handed to the operation must be aborted');
    });

    test('a late rejection from the abandoned operation is not unhandled', async () => {
      const { withTimeout } = load();
      const slow = () => new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('late')), 30));
      await assert.rejects(() => withTimeout(slow, 5));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  });

  suite('backoff jitter', () => {
    test('bounds each attempt between zero and the exponential ceiling', () => {
      const { backoffDelay } = load();
      assert.strictEqual(backoffDelay(0, {}, () => 0), 0);
      assert.strictEqual(backoffDelay(0, {}, () => 1), RESILIENCE_DEFAULTS.baseDelayMs);
      assert.strictEqual(backoffDelay(1, {}, () => 1), RESILIENCE_DEFAULTS.baseDelayMs * 2);
      assert.strictEqual(backoffDelay(2, {}, () => 1), RESILIENCE_DEFAULTS.baseDelayMs * 4);
    });

    test('never exceeds maxDelayMs however many attempts have failed', () => {
      const { backoffDelay } = load();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const delay = backoffDelay(attempt, {}, () => 0.999);
        assert.ok(delay <= RESILIENCE_DEFAULTS.maxDelayMs, `attempt ${attempt} produced ${delay}`);
        assert.ok(delay >= 0);
      }
      assert.strictEqual(backoffDelay(40, {}, () => 1), RESILIENCE_DEFAULTS.maxDelayMs);
    });

    test('jitters within the ceiling rather than returning the ceiling', () => {
      const { backoffDelay } = load();
      const samples = new Set<number>();
      for (let step = 0; step < 20; step += 1) {
        samples.add(backoffDelay(3, {}, () => (step + 0.5) / 20));
      }
      assert.ok(samples.size > 1, 'delays must vary between calls to de-synchronise clients');
      for (const delay of samples) assert.ok(delay < RESILIENCE_DEFAULTS.maxDelayMs);
    });
  });

  suite('retry', () => {
    test('retries up to the configured attempts and returns the first success', async () => {
      const { retry } = load();
      const delays: number[] = [];
      let calls = 0;
      const value = await retry(
        async () => {
          calls += 1;
          if (calls < 3) throw new Error('transient');
          return 'ok';
        },
        { sleep: async (ms: number) => void delays.push(ms), random: () => 0.5 }
      );
      assert.strictEqual(value, 'ok');
      assert.strictEqual(calls, 3);
      assert.strictEqual(delays.length, 2, 'two retries for three attempts');
    });

    test('rethrows after the last attempt instead of looping forever', async () => {
      const { retry } = load();
      let calls = 0;
      await assert.rejects(
        () =>
          retry(
            async () => {
              calls += 1;
              throw new Error('always');
            },
            { attempts: 3, sleep: async () => undefined }
          ),
        /always/
      );
      assert.strictEqual(calls, 3);
    });

    test('does not retry an error the caller marked non-retryable', async () => {
      const { retry } = load();
      let calls = 0;
      await assert.rejects(
        () =>
          retry(
            async () => {
              calls += 1;
              throw Object.assign(new Error('bad request'), { status: 400 });
            },
            { sleep: async () => undefined }
          ),
        /bad request/
      );
      assert.strictEqual(calls, 1, '4xx must fail fast');
    });

    test('never retries a circuit-open refusal', async () => {
      const { retry, isRetryable, CircuitOpenError } = load();
      assert.strictEqual(isRetryable(new CircuitOpenError('orders')), false);
      let calls = 0;
      await assert.rejects(
        () =>
          retry(
            async () => {
              calls += 1;
              throw new CircuitOpenError('orders');
            },
            { sleep: async () => undefined }
          ),
        (error: Error & { code: string }) => error.code === 'CIRCUIT_OPEN'
      );
      assert.strictEqual(calls, 1);
    });
  });

  suite('CircuitBreaker', () => {
    test('opens after the failure threshold and then refuses without calling out', async () => {
      const { CircuitBreaker, CircuitOpenError } = load();
      const breaker = new CircuitBreaker('orders');
      let calls = 0;
      const failing = async () => {
        calls += 1;
        throw new Error('down');
      };
      for (let attempt = 0; attempt < RESILIENCE_DEFAULTS.failureThreshold; attempt += 1) {
        await assert.rejects(() => breaker.execute(failing), /down/);
      }
      assert.strictEqual(breaker.state, 'open');
      await assert.rejects(
        () => breaker.execute(failing),
        (error: Error) => error instanceof CircuitOpenError
      );
      assert.strictEqual(calls, RESILIENCE_DEFAULTS.failureThreshold, 'an open breaker must not call out');
    });

    test('admits one half-open probe after the cool-off, then closes on success', async () => {
      const { CircuitBreaker } = load();
      let now = 0;
      const breaker = new CircuitBreaker('orders', { now: () => now, failureThreshold: 1 });
      await assert.rejects(() => breaker.execute(failure()), /boom/);
      assert.strictEqual(breaker.state, 'open');

      now = RESILIENCE_DEFAULTS.halfOpenAfterMs - 1;
      assert.strictEqual(breaker.state, 'open');

      now = RESILIENCE_DEFAULTS.halfOpenAfterMs;
      assert.strictEqual(breaker.state, 'half-open', 'the probe window must open after the cool-off');

      let release: (value: string) => void = () => undefined;
      const probe = breaker.execute(
        () => new Promise<string>((resolve) => (release = resolve))
      );
      await assert.rejects(() => breaker.execute(async () => 'impostor'), /circuit open/i);
      release('ok');
      assert.strictEqual(await probe, 'ok');
      assert.strictEqual(breaker.state, 'closed');
      assert.strictEqual(breaker.consecutiveFailures, 0);
    });

    test('a failed half-open probe re-opens the breaker immediately', async () => {
      const { CircuitBreaker } = load();
      let now = 0;
      const breaker = new CircuitBreaker('orders', { now: () => now, failureThreshold: 3 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(() => breaker.execute(failure()));
      }
      now = RESILIENCE_DEFAULTS.halfOpenAfterMs;
      assert.strictEqual(breaker.state, 'half-open');
      await assert.rejects(() => breaker.execute(failure()));
      assert.strictEqual(breaker.state, 'open', 'one failed probe must re-open, not count to the threshold');
    });

    test('records streamed outcomes directly, for callers that cannot use execute()', () => {
      const { CircuitBreaker } = load();
      let now = 0;
      const breaker = new CircuitBreaker('payments', { now: () => now, failureThreshold: 2 });
      breaker.recordFailure();
      breaker.recordFailure();
      assert.strictEqual(breaker.state, 'open', 'the gateway reports 5xx and transport errors this way');
      now = RESILIENCE_DEFAULTS.halfOpenAfterMs;
      assert.strictEqual(breaker.state, 'half-open');
      breaker.recordSuccess();
      assert.strictEqual(breaker.state, 'closed');
      assert.strictEqual(breaker.consecutiveFailures, 0);
    });
  });

  suite('IdempotencyGuard', () => {
    test('executes once and replays the stored reply for a duplicate key', async () => {
      const { IdempotencyGuard } = load();
      const guard = new IdempotencyGuard();
      let effects = 0;
      const operation = async () => {
        effects += 1;
        return { status: 201, body: { id: 'ord_1' } };
      };
      const first = await guard.once('key-1', 'fp', operation);
      const second = await guard.once('key-1', 'fp', operation);
      assert.strictEqual(effects, 1, 'the duplicate must not re-run the effect');
      assert.strictEqual(first.replayed, false);
      assert.strictEqual(second.replayed, true);
      assert.deepStrictEqual(second.body, { id: 'ord_1' });
      assert.strictEqual(second.status, 201);
    });

    test('concurrent duplicates share one in-flight call', async () => {
      const { IdempotencyGuard } = load();
      const guard = new IdempotencyGuard();
      let effects = 0;
      let release: (value: { status: number; body: string }) => void = () => undefined;
      const operation = () => {
        effects += 1;
        return new Promise<{ status: number; body: string }>((resolve) => (release = resolve));
      };
      const first = guard.once('key-2', 'fp', operation);
      const second = guard.once('key-2', 'fp', operation);
      release({ status: 200, body: 'created' });
      const [a, b] = await Promise.all([first, second]);
      assert.strictEqual(effects, 1);
      assert.strictEqual(a.body, 'created');
      assert.strictEqual(b.body, 'created');
      assert.strictEqual(b.replayed, true);
    });

    test('same key with a different payload is a conflict, not a replay', async () => {
      const { IdempotencyGuard, IdempotencyConflictError } = load();
      const guard = new IdempotencyGuard();
      const operation = async () => ({ status: 200, body: 'ok' });
      await guard.once('key-3', 'fp-a', operation);
      await assert.rejects(
        () => guard.once('key-3', 'fp-b', operation),
        (error: Error) => error instanceof IdempotencyConflictError
      );
    });

    test('a failed operation releases the key so the client can retry', async () => {
      const { IdempotencyGuard } = load();
      const guard = new IdempotencyGuard();
      await assert.rejects(() => guard.once('key-4', 'fp', failure()), /boom/);
      assert.strictEqual(guard.size, 0);
      const retried = await guard.once('key-4', 'fp', async () => ({ status: 200, body: 'ok' }));
      assert.strictEqual(retried.replayed, false);
    });

    test('stored replies expire after the ttl', async () => {
      const { IdempotencyGuard } = load();
      let now = 0;
      const guard = new IdempotencyGuard({ now: () => now });
      let effects = 0;
      const operation = async () => {
        effects += 1;
        return { status: 200, body: 'ok' };
      };
      await guard.once('key-5', 'fp', operation);
      now = RESILIENCE_DEFAULTS.idempotencyTtlMs - 1;
      await guard.once('key-5', 'fp', operation);
      assert.strictEqual(effects, 1);
      now = RESILIENCE_DEFAULTS.idempotencyTtlMs;
      await guard.once('key-5', 'fp', operation);
      assert.strictEqual(effects, 2, 'an expired entry must not replay');
    });
  });

  suite('header and fingerprint helpers', () => {
    test('reads the key case-insensitively and trims it', () => {
      const { idempotencyKeyOf } = load();
      assert.strictEqual(IDEMPOTENCY_HEADER, 'idempotency-key');
      assert.strictEqual(idempotencyKeyOf({ 'Idempotency-Key': '  abc  ' }), 'abc');
      assert.strictEqual(idempotencyKeyOf({ 'IDEMPOTENCY-KEY': ['abc'] }), 'abc');
      assert.strictEqual(idempotencyKeyOf({}), undefined);
      assert.strictEqual(idempotencyKeyOf({ 'idempotency-key': '   ' }), undefined);
      assert.strictEqual(
        idempotencyKeyOf({ 'idempotency-key': 'x'.repeat(RESILIENCE_DEFAULTS.maxIdempotencyKeyLength + 1) }),
        undefined,
        'an over-long key must be ignored rather than stored'
      );
    });

    test('fingerprints are stable across property order but differ across requests', () => {
      const { requestFingerprint } = load();
      const a = requestFingerprint('POST', '/api/v1/orders', { amount: 10, currency: 'MYR' });
      const b = requestFingerprint('post', '/api/v1/orders', { currency: 'MYR', amount: 10 });
      assert.strictEqual(a, b, 'key order and method case must not change the fingerprint');
      assert.match(a, /^[0-9a-f]{8}$/);
      assert.notStrictEqual(a, requestFingerprint('POST', '/api/v1/orders', { amount: 11, currency: 'MYR' }));
      assert.notStrictEqual(a, requestFingerprint('PUT', '/api/v1/orders', { amount: 10, currency: 'MYR' }));
      assert.notStrictEqual(a, requestFingerprint('POST', '/api/v1/invoices', { amount: 10, currency: 'MYR' }));
    });
  });

  suite('scaffolded output', () => {
    const fixtures = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'src',
      'test',
      'suite',
      'services',
      'fixtures'
    );

    function tree(name: string): Record<string, string> {
      const raw = fs.readFileSync(path.join(fixtures, name), 'utf8');
      return (JSON.parse(raw) as { files: Record<string, string> }).files;
    }

    test('the monorepo writer emits the module byte-for-byte and barrels it', () => {
      const files = tree('monorepo-microservices.tree.json');
      assert.ok(files[RESILIENCE_PATH], 'resilience module missing from the scaffold');
      assert.strictEqual(files[RESILIENCE_PATH], resilienceSource());
      assert.ok(files['packages/shared/src/index.ts'].includes("export * from './resilience';"));
    });

    test('ARCHITECTURE.md carries the rule table with a symbol per obligation', () => {
      const doc = tree('monorepo-microservices.tree.json')['ARCHITECTURE.md'];
      assert.ok(doc.includes('## Resilience rules'));
      assert.ok(doc.includes('| Obligation | Symbol |'));
      assert.ok(doc.includes(RESILIENCE_PATH), 'the table must name the module it lives in');
      for (const rule of RESILIENCE_RULES) {
        assert.ok(doc.includes(`\`${rule.symbol}\``), `${rule.symbol} is not documented as the implementation`);
      }
    });

    test('the gateway uses the kit rather than only shipping it', () => {
      const gateway = tree('monorepo-microservices.tree.json')['services/gateway/src/index.ts'];
      assert.ok(gateway.includes('new CircuitBreaker('), 'one breaker per upstream prefix');
      assert.ok(gateway.includes("breaker.state === 'open'"), 'an open breaker must short-circuit the proxy');
      assert.ok(gateway.includes('breaker.recordFailure()'));
      assert.ok(gateway.includes('breaker.recordSuccess()'));
      assert.ok(gateway.includes('RESILIENCE_DEFAULTS.timeoutMs'), 'a hung upstream must be cut off');
      assert.ok(gateway.includes('idempotencyKeyOf(req.headers)'), 'a POST must carry an idempotency key');
      assert.ok(gateway.includes('503'), 'an open circuit answers 503 instead of hanging');
    });

    test('a run without the shared package does not pretend to enforce the rule', () => {
      const files = tree('monorepo-microservices.options.tree.json');
      assert.strictEqual(files[RESILIENCE_PATH], undefined);
      assert.ok(!files['ARCHITECTURE.md'].includes('## Resilience rules'));
    });
  });
});

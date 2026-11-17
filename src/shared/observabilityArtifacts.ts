/**
 * Observability and lifecycle artifacts for the node monorepo writer.
 *
 * The ZEN handbook makes four things mandatory for every runtime (§4.2, clauses
 * CON-03/CON-04 in `docs/zen-handbook-review.md`): JSON logs on stdout, a
 * correlation id that survives a hop, a Prometheus `/metrics` endpoint, and a
 * liveness/readiness split with a graceful SIGTERM drain. This module is the
 * single source of those shapes: the `packages/shared` bodies generated here are
 * what the service entrypoints import, and `OBSERVABILITY_PATHS` is what the
 * Dockerfile HEALTHCHECK, the k8s probes and the non-node stacks point at, so a
 * probe can never test a path the app does not serve.
 *
 * The generated code is dependency-free Node 20 — the repository forbids runtime
 * dependencies, so the metrics exposition is hand-written rather than
 * `prom-client`, and the logger is a 40-line writer rather than `pino`.
 */

/** Every path a service exposes for platform traffic. */
export const OBSERVABILITY_PATHS = {
  /** Liveness — a failure means "restart me". */
  live: '/healthz/live',
  /** Readiness — a failure means "stop routing to me", draining flips it. */
  ready: '/healthz/ready',
  /** Prometheus text exposition. */
  metrics: '/metrics',
  /** Pre-P3 path, still served for callers that pinned it. */
  legacy: '/health',
} as const;

export interface ObservabilityFile {
  path: string;
  content: string;
}

const HEALTH_TS = `/** Health payload every service exposes on the liveness and readiness paths. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  uptimeSeconds: number;
  checks: Record<string, 'up' | 'down'>;
  reason?: string;
}

/**
 * Liveness and readiness answer different questions. Liveness asks "is this
 * process healthy enough to keep running" -- a failure restarts the container.
 * Readiness asks "should traffic be routed here" -- a failure only takes the pod
 * out of the service endpoints. Draining therefore flips readiness only, so a
 * SIGTERM never triggers a restart loop.
 */
export const HEALTH_LIVE_PATH = '/healthz/live';
export const HEALTH_READY_PATH = '/healthz/ready';
export const HEALTH_LEGACY_PATH = '/health';
/** Pre-split readiness path; kept so probes written before the split keep working. */
export const HEALTH_LEGACY_READY_PATH = '/ready';
export const METRICS_PATH = '/metrics';

let ready = true;
let drainReason: string | undefined;

/** Flipped to false by the shutdown handler; also used by dependency checks. */
export function setReady(next: boolean, reason?: string): void {
  ready = next;
  drainReason = next ? undefined : reason;
}

export function isReady(): boolean {
  return ready;
}

export function healthResponse(service: string, version = '0.1.0'): HealthResponse {
  return {
    status: 'ok',
    service,
    version,
    uptimeSeconds: Math.round(process.uptime()),
    checks: { self: 'up' },
  };
}

/** Readiness payload: identical to liveness until the process starts draining. */
export function readinessResponse(service: string, version = '0.1.0'): HealthResponse {
  const base = healthResponse(service, version);
  if (ready) {
    return base;
  }
  const payload: HealthResponse = {
    ...base,
    status: 'degraded',
    checks: { ...base.checks, draining: 'down' },
  };
  if (drainReason) {
    payload.reason = drainReason;
  }
  return payload;
}
`;

const LOGGER_TS = `import type { IncomingMessage } from 'node:http';

/**
 * Structured JSON logger: one object per line on stdout.
 *
 * stdout because the platform (Docker, Kubernetes, CloudWatch) collects it and a
 * log shipper can parse JSON without a regex. Nothing is buffered and nothing is
 * pretty-printed -- a multi-line record is unparseable by the collector.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Arbitrary structured context; must survive JSON.stringify. */
export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  /** Bind fields once (service, correlationId) and reuse the child. */
  child(bindings: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = String(process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return LEVELS[configured] ?? LEVELS.info;
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.map(serialize);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serialize(entry);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, message: string, bindings: LogFields, fields?: LogFields): void {
  if (LEVELS[level] < threshold()) {
    return;
  }
  const record: LogFields = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...bindings,
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      record[key] = serialize(value);
    }
  }
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    try {
      line = JSON.stringify({ timestamp: record.timestamp, level, message, ...bindings, fields: '[unserializable]' });
    } catch {
      line = JSON.stringify({ timestamp: record.timestamp, level, message, fields: '[unserializable]' });
    }
  }
  process.stdout.write(line + '\\n');
}

export function createLogger(bindings: LogFields = {}): Logger {
  return {
    child(extra: LogFields): Logger {
      return createLogger({ ...bindings, ...extra });
    },
    debug(message: string, fields?: LogFields): void {
      emit('debug', message, bindings, fields);
    },
    info(message: string, fields?: LogFields): void {
      emit('info', message, bindings, fields);
    },
    warn(message: string, fields?: LogFields): void {
      emit('warn', message, bindings, fields);
    },
    error(message: string, fields?: LogFields): void {
      emit('error', message, bindings, fields);
    },
  };
}

/** Log the request line for an inbound HTTP request. */
export function logRequest(logger: Logger, req: IncomingMessage, fields: LogFields = {}): void {
  logger.info('request', {
    method: req.method,
    path: req.url,
    ...fields,
  });
}
`;

const CORRELATION_TS = `import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Correlation id: one id per logical request, carried in a header so it survives
 * every hop. The edge (gateway) mints it when absent and every service reuses
 * what it receives -- minting a fresh id per hop is what makes a distributed
 * trace unjoinable.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Reuse the inbound id, or mint one when the caller did not send it. */
export function correlationIdOf(req: IncomingMessage): string {
  const raw = req.headers[CORRELATION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : randomUUID();
}

/** Echo the id back so a client can quote it in a bug report. */
export function attachCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const id = correlationIdOf(req);
  res.setHeader('X-Correlation-ID', id);
  return id;
}

/**
 * Headers to forward upstream so the next hop logs under the same id.
 *
 * Pass the id \`attachCorrelationId\` already resolved: calling \`correlationIdOf\`
 * again mints a SECOND uuid when the client sent none, which breaks the trace
 * at exactly the hop that is supposed to stitch it together.
 */
export function correlationHeaders(req: IncomingMessage, resolvedId?: string): Record<string, string> {
  return { 'X-Correlation-ID': resolvedId ?? correlationIdOf(req) };
}
`;

const METRICS_TS = `/**
 * Prometheus metrics, hand-written because the platform exposes a text format
 * and the repository takes no runtime dependencies.
 *
 * Exposition format: https://prometheus.io/docs/instrumenting/exposition_formats/
 * Every metric renders one # HELP line, one # TYPE line, then its samples.
 */
export type Labels = Record<string, string>;

function escapeValue(value: string): string {
  return value.replace(/\\\\/g, '\\\\\\\\').replace(/\\n/g, '\\\\n').replace(/"/g, '\\\\"');
}

function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  return '{' + keys.map((key) => key + '="' + escapeValue(labels[key]) + '"').join(',') + '}';
}

function signature(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => key + '=' + labels[key]).join('\\u0001');
}

export class Counter {
  readonly kind = 'counter';
  private readonly samples = new Map<string, { labels: Labels; value: number }>();

  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = signature(labels);
    const existing = this.samples.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.samples.set(key, { labels: { ...labels }, value });
    }
  }

  render(): string {
    const lines = ['# HELP ' + this.name + ' ' + this.help, '# TYPE ' + this.name + ' counter'];
    if (this.samples.size === 0) {
      lines.push(this.name + ' 0');
      return lines.join('\\n');
    }
    for (const sample of this.samples.values()) {
      lines.push(this.name + formatLabels(sample.labels) + ' ' + sample.value);
    }
    return lines.join('\\n');
  }
}

export class Gauge {
  readonly kind = 'gauge';
  private value = 0;

  constructor(readonly name: string, readonly help: string) {}

  set(next: number): void {
    this.value = next;
  }

  render(): string {
    return ['# HELP ' + this.name + ' ' + this.help, '# TYPE ' + this.name + ' gauge', this.name + ' ' + this.value].join('\\n');
  }
}

export class Histogram {
  readonly kind = 'histogram';
  private readonly counts: number[];
  private sum = 0;
  private count = 0;

  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {
    this.counts = buckets.map(() => 0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count += 1;
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]) {
        this.counts[index] += 1;
      }
    }
  }

  render(): string {
    const lines = ['# HELP ' + this.name + ' ' + this.help, '# TYPE ' + this.name + ' histogram'];
    let cumulative = 0;
    for (let index = 0; index < this.buckets.length; index += 1) {
      cumulative = this.counts[index];
      lines.push(this.name + '_bucket' + formatLabels({ le: String(this.buckets[index]) }) + ' ' + cumulative);
    }
    lines.push(this.name + '_bucket' + formatLabels({ le: '+Inf' }) + ' ' + this.count);
    lines.push(this.name + '_sum ' + Number(this.sum.toFixed(6)));
    lines.push(this.name + '_count ' + this.count);
    return lines.join('\\n');
  }
}

const registry: Array<Counter | Gauge | Histogram> = [];

export function register<T extends Counter | Gauge | Histogram>(metric: T): T {
  registry.push(metric);
  return metric;
}

export const httpRequestsTotal = register(
  new Counter('http_requests_total', 'HTTP requests handled, by method, route and status code')
);

export const httpRequestDurationSeconds = register(
  new Histogram('http_request_duration_seconds', 'HTTP request latency in seconds', [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5])
);

export const processStartTimeSeconds = register(
  new Gauge('process_start_time_seconds', 'Start time of the process since unix epoch in seconds')
);

/** Full exposition body, metrics sorted by name so the output is diff-stable. */
export function renderMetrics(): string {
  return registry
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((metric) => metric.render())
    .join('\\n') + '\\n';
}

/** Wrap a handler so every response is counted and timed. */
export function instrumentRoute(
  method: string,
  route: string,
  status: number,
  startedAt: number
): void {
  httpRequestsTotal.inc({ method, route, status: String(status) });
  httpRequestDurationSeconds.observe(Math.max(0, Date.now() - startedAt) / 1000);
}
`;

const LIFECYCLE_TS = `import type { Server } from 'node:http';
import { setReady } from './health';
import type { Logger } from './logger';

/**
 * Graceful shutdown. A SIGTERM from the platform means "stop taking traffic,
 * finish what you are doing, exit 0" -- not "die now". In order:
 *
 * 1. flip readiness so the load balancer stops sending new requests,
 * 2. stop accepting connections and wait for in-flight requests,
 * 3. release the broker connection,
 * 4. force-exit if the drain exceeds its budget, so a stuck client cannot
 *    hold the pod until the grace period kills it mid-request.
 */
export interface GracefulShutdownOptions {
  /** Hard cap on the drain; must stay below the platform's grace period. */
  timeoutMs?: number;
  signal?: NodeJS.Signals;
  /** Release broker/DB handles here. */
  onDrain?: () => Promise<void> | void;
  exit?: (code: number) => void;
}

export function installGracefulShutdown(
  server: Server,
  logger: Logger,
  options: GracefulShutdownOptions = {}
): (signal: string) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10000);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let draining: Promise<void> | undefined;

  const drain = async (signal: string): Promise<void> => {
    if (draining) {
      return draining;
    }
    draining = (async () => {
      logger.info('shutdown.start', { signal, timeoutMs });
      setReady(false, 'draining');

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn('shutdown.timeout', { signal, timeoutMs });
          const forceClose = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
          if (typeof forceClose === 'function') {
            forceClose.call(server);
          }
          resolve();
        }, timeoutMs);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });

      try {
        if (options.onDrain) {
          await options.onDrain();
        }
      } catch (error) {
        logger.error('shutdown.drain_failed', { error });
      }

      logger.info('shutdown.complete', { signal });
      exit(0);
    })();
    return draining;
  };

  const signals: NodeJS.Signals[] = [options.signal ?? 'SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.once(signal, () => {
      void drain(signal);
    });
  }

  return drain;
}
`;

/**
 * The files every generated monorepo service needs in order to satisfy
 * CON-03/CON-04. Paths are relative to the repository root.
 */
export function planObservabilityFiles(): ObservabilityFile[] {
  return [
    { path: 'packages/shared/src/health.ts', content: HEALTH_TS },
    { path: 'packages/shared/src/logger.ts', content: LOGGER_TS },
    { path: 'packages/shared/src/correlation.ts', content: CORRELATION_TS },
    { path: 'packages/shared/src/metrics.ts', content: METRICS_TS },
    { path: 'packages/shared/src/lifecycle.ts', content: LIFECYCLE_TS },
  ];
}

/** Barrel exports the observability modules in the shared package. */
export function sharedObservabilityBarrelLines(): string[] {
  return [
    "export * from './health';",
    "export * from './logger';",
    "export * from './correlation';",
    "export * from './metrics';",
    "export * from './lifecycle';",
  ];
}

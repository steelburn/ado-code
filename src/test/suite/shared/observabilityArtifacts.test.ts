import * as assert from 'assert';
import { HEALTHCHECK_PATH } from '../../../shared/containerHardening';
import {
  OBSERVABILITY_PATHS,
  ObservabilityFile,
  planObservabilityFiles,
  sharedObservabilityBarrelLines,
} from '../../../shared/observabilityArtifacts';

/**
 * The generated `packages/shared` bodies are what every scaffolded service
 * actually runs, so the clauses of CON-03/CON-04 are asserted against that text
 * rather than against this module.
 */
function files(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of planObservabilityFiles()) {
    map.set(file.path, file.content);
  }
  return map;
}

function body(map: Map<string, string>, name: string): string {
  const content = map.get(`packages/shared/src/${name}.ts`);
  assert.ok(content, `expected a generated packages/shared/src/${name}.ts`);
  return content as string;
}

suite('observabilityArtifacts — platform paths', () => {
  test('declares the liveness and readiness split under /healthz', () => {
    assert.strictEqual(OBSERVABILITY_PATHS.live, '/healthz/live');
    assert.strictEqual(OBSERVABILITY_PATHS.ready, '/healthz/ready');
  });

  test('every declared path is absolute and none collide', () => {
    const values = Object.values(OBSERVABILITY_PATHS) as string[];
    assert.ok(values.length >= 4, 'expected live, ready, legacy and metrics paths');
    for (const value of values) {
      assert.strictEqual(value.startsWith('/'), true, `${value} is not an absolute path`);
    }
    assert.strictEqual(new Set(values).size, values.length, 'two platform paths share a route');
  });

  test('liveness and readiness are different routes', () => {
    // Collapsing them would make a draining pod look unhealthy and get killed.
    assert.notStrictEqual(OBSERVABILITY_PATHS.live, OBSERVABILITY_PATHS.ready);
  });

  test('the generated health module declares the same literals as the plan', () => {
    const health = body(files(), 'health');
    for (const value of Object.values(OBSERVABILITY_PATHS) as string[]) {
      assert.ok(health.includes(`'${value}'`), `health.ts does not declare ${value}`);
    }
  });

  test('the docker HEALTHCHECK probes a route the service serves', () => {
    const served = Object.values(OBSERVABILITY_PATHS) as string[];
    assert.ok(
      served.includes(HEALTHCHECK_PATH),
      `HEALTHCHECK_PATH ${HEALTHCHECK_PATH} is not served by the generated app`
    );
  });
});

suite('observabilityArtifacts — generated file set', () => {
  test('emits the five shared modules every service imports', () => {
    const map = files();
    for (const name of ['health', 'logger', 'correlation', 'metrics', 'lifecycle']) {
      assert.ok(map.has(`packages/shared/src/${name}.ts`), `missing ${name}.ts`);
    }
  });

  test('all modules live under packages/shared/src', () => {
    for (const file of planObservabilityFiles()) {
      assert.ok(
        file.path.startsWith('packages/shared/src/'),
        `${file.path} is outside the shared package`
      );
      assert.ok(file.path.endsWith('.ts'), `${file.path} is not TypeScript`);
    }
  });

  test('planning is deterministic', () => {
    assert.deepStrictEqual(planObservabilityFiles(), planObservabilityFiles());
  });

  test('no generated module is empty', () => {
    for (const file of planObservabilityFiles()) {
      assert.ok(file.content.trim().length > 100, `${file.path} is effectively empty`);
    }
  });

  test('the barrel re-exports every generated module', () => {
    const lines = sharedObservabilityBarrelLines();
    for (const name of ['health', 'logger', 'correlation', 'metrics', 'lifecycle']) {
      assert.ok(
        lines.some((line) => line.includes(`'./${name}'`)),
        `barrel does not export ./${name}`
      );
    }
  });

  test('the drain module takes readiness from the single health module', () => {
    // Two sources of truth for readiness would let a drain flip the wrong flag.
    const lifecycle = body(files(), 'lifecycle');
    assert.ok(/import\s*\{\s*setReady\s*\}\s*from\s*'\.\/health'/.test(lifecycle));
  });
});

suite('observabilityArtifacts — structured logging (CON-03)', () => {
  test('writes one JSON object per line to stdout', () => {
    const logger = body(files(), 'logger');
    assert.ok(logger.includes('process.stdout.write('), 'not writing to stdout');
    assert.ok(/JSON\.stringify\(/.test(logger), 'not serialising as JSON');
    assert.ok(/\+ '\\n'\)/.test(logger), 'no per-line newline terminator');
  });

  test('never uses console, which would defeat line-oriented log shipping', () => {
    const logger = body(files(), 'logger');
    assert.strictEqual(/console\.\w+\(/.test(logger), false, 'logger uses console');
  });

  test('honours a LOG_LEVEL threshold', () => {
    const logger = body(files(), 'logger');
    assert.ok(logger.includes('process.env.LOG_LEVEL'), 'level threshold is not configurable');
  });

  test('exposes the five structured levels', () => {
    const logger = body(files(), 'logger');
    for (const level of ['debug', 'info', 'warn', 'error']) {
      assert.ok(new RegExp(`${level}\\(`).test(logger), `missing ${level}()`);
    }
  });

  test('child() carries bindings instead of re-passing them per call', () => {
    const logger = body(files(), 'logger');
    assert.ok(/child\(/.test(logger), 'missing child()');
    assert.ok(/bindings/.test(logger), 'bindings are not merged');
  });

  test('serialises Errors into something a log search can use', () => {
    const logger = body(files(), 'logger');
    assert.ok(/instanceof Error/.test(logger), 'Errors are not detected');
    assert.ok(/\.stack/.test(logger), 'stack is dropped');
  });

  test('a log call can never throw on an unserialisable payload', () => {
    const logger = body(files(), 'logger');
    assert.ok(/catch/.test(logger), 'no fallback for a JSON.stringify failure');
    assert.ok(/service/.test(logger), 'the fallback line loses the service identity');
  });

  test('every line carries a timestamp and a level', () => {
    const logger = body(files(), 'logger');
    assert.ok(logger.includes('timestamp'), 'no timestamp field');
    assert.ok(logger.includes('level'), 'no level field');
  });
});

suite('observabilityArtifacts — correlation (CON-03)', () => {
  test('uses the X-Correlation-ID header', () => {
    const correlation = body(files(), 'correlation');
    assert.ok(correlation.includes('X-Correlation-ID'), 'wrong or missing header name');
  });

  test('reuses an inbound id so a trace survives the hop', () => {
    const correlation = body(files(), 'correlation');
    assert.ok(/headers/.test(correlation), 'inbound headers are ignored');
    assert.ok(/trim\(\)/.test(correlation), 'blank inbound ids are not treated as absent');
  });

  test('bounds the inbound id it will echo', () => {
    // An unbounded header is a log-injection vector.
    assert.ok(/128/.test(body(files(), 'correlation')), 'inbound id is not length-bounded');
  });

  test('mints an id only when there is nothing usable to reuse', () => {
    const correlation = body(files(), 'correlation');
    assert.ok(/randomUUID\(/.test(correlation), 'no id minting');
  });

  test('echoes the id back on the response', () => {
    const correlation = body(files(), 'correlation');
    assert.ok(/setHeader\(/.test(correlation), 'the id is never returned to the caller');
  });

  test('forwards the already-resolved id rather than minting a second one', () => {
    // The double-mint broke the trace at the gateway, the one hop meant to stitch it.
    const correlation = body(files(), 'correlation');
    assert.ok(
      /correlationHeaders\(req[^)]*resolvedId\?:/.test(correlation) &&
        /resolvedId \?\?/.test(correlation),
      'correlationHeaders() re-resolves the id instead of taking the resolved one'
    );
  });
});

suite('observabilityArtifacts — metrics (CON-03)', () => {
  test('renders Prometheus text exposition', () => {
    const metrics = body(files(), 'metrics');
    assert.ok(metrics.includes("'# HELP '"), 'no HELP line');
    assert.ok(metrics.includes("'# TYPE '"), 'no TYPE line');
  });

  test('declares a counter and a histogram', () => {
    const metrics = body(files(), 'metrics');
    assert.ok(/counter/.test(metrics), 'no counter instrument');
    assert.ok(/histogram/i.test(metrics), 'no histogram instrument');
  });

  test('histograms expose cumulative buckets and +Inf', () => {
    const metrics = body(files(), 'metrics');
    assert.ok(/_bucket/.test(metrics), 'no _bucket series');
    assert.ok(metrics.includes('+Inf'), 'no +Inf bucket');
    assert.ok(/le/.test(metrics), 'no le label on buckets');
  });

  test('labels are escaped so a value cannot break the exposition', () => {
    const metrics = body(files(), 'metrics');
    assert.ok(metrics.includes('formatLabels'), 'labels are interpolated raw');
    assert.ok(metrics.includes('replace(/"/g'), 'quotes are not escaped');
  });

  test('the body ends with a newline', () => {
    const metrics = body(files(), 'metrics');
    assert.ok(/\+\s*'\\n'/.test(metrics), 'exposition body is not newline-terminated');
  });

  test('duration is observed in seconds, rounded', () => {
    const metrics = body(files(), 'metrics');
    assert.ok(/\/ 1000/.test(metrics), 'duration is not converted to seconds');
    assert.ok(/toFixed\(/.test(metrics), 'float noise leaks into _sum');
  });

  test('requests are counted per method, route and status', () => {
    const metrics = body(files(), 'metrics');
    assert.ok(/method/.test(metrics) && /route/.test(metrics) && /status/.test(metrics));
  });
});

suite('observabilityArtifacts — lifecycle and drain (CON-04)', () => {
  test('handles SIGTERM and SIGINT', () => {
    const lifecycle = body(files(), 'lifecycle');
    assert.ok(lifecycle.includes('SIGTERM'), 'SIGTERM is not handled');
    assert.ok(lifecycle.includes('SIGINT'), 'SIGINT is not handled');
  });

  test('flips readiness before closing the server', () => {
    const lifecycle = body(files(), 'lifecycle');
    const ready = lifecycle.indexOf('setReady(false');
    const close = lifecycle.indexOf('server.close(');
    assert.ok(ready >= 0, 'the drain never marks the pod unready');
    assert.ok(close >= 0, 'the drain never closes the listener');
    assert.ok(ready < close, 'the listener closes before readiness is withdrawn');
  });

  test('lets in-flight requests finish', () => {
    const lifecycle = body(files(), 'lifecycle');
    assert.ok(/server\.close\(/.test(lifecycle), 'in-flight requests are dropped');
    assert.ok(/await/.test(lifecycle), 'the drain is not awaited');
  });

  test('forces exit so a stuck client cannot hold the pod past its grace period', () => {
    const lifecycle = body(files(), 'lifecycle');
    assert.ok(/setTimeout/.test(lifecycle), 'no drain timeout');
    assert.ok(/closeAllConnections/.test(lifecycle), 'no forced socket teardown');
    assert.ok(/process\.exit/.test(lifecycle), 'a hung drain never exits');
  });

  test('drains once even when both signals arrive', () => {
    const lifecycle = body(files(), 'lifecycle');
    assert.ok(/draining/.test(lifecycle), 'the drain is not guarded');
    assert.ok(/return draining/.test(lifecycle), 'a second signal starts a second drain');
  });

  test('logs the shutdown so the drain is visible in the log stream', () => {
    const lifecycle = body(files(), 'lifecycle');
    assert.ok(/shutdown\.start/.test(lifecycle), 'no shutdown.start log');
    assert.ok(/shutdown\.timeout/.test(lifecycle), 'a forced teardown is silent');
  });
});

suite('observabilityArtifacts — service wiring', () => {
  test('the plan carries no duplicate path', () => {
    const paths = planObservabilityFiles().map((file: ObservabilityFile) => file.path);
    assert.strictEqual(new Set(paths).size, paths.length, 'a shared module is emitted twice');
  });

  test('every task requirement has a module to land in', () => {
    const map = files();
    assert.ok(body(map, 'logger').includes('LOG_LEVEL'), 'logger');
    assert.ok(body(map, 'correlation').includes('X-Correlation-ID'), 'correlation');
    assert.ok(body(map, 'metrics').includes('_bucket'), 'metrics');
    assert.ok(body(map, 'lifecycle').includes('SIGTERM'), 'lifecycle');
    assert.ok(body(map, 'health').includes(OBSERVABILITY_PATHS.live), 'health');
  });
});

import * as assert from 'assert';
import { BASE_LAUNCH_ARGS, buildLaunchArgs, sanitizeLaunchEnv } from '../../launchConfig';

/**
 * Guards the VS Code test-harness launch contract (src/test/runTest.ts).
 *
 * Regression: @vscode/test-electron copies process.env into the VS Code it
 * spawns, so an inherited ELECTRON_RUN_AS_NODE made Code.exe boot as Node and
 * reject the launch flags ("bad option: --disable-extensions", exit 9) — the
 * whole `npm test` run died before a single test executed. runTest.ts must
 * scrub that variable before launching.
 */
suite('Test harness launch config', () => {
  test('keeps --disable-extensions in the launch args', () => {
    assert.ok(
      BASE_LAUNCH_ARGS.includes('--disable-extensions'),
      '--disable-extensions must stay: it isolates tests from installed extensions'
    );
    assert.ok(buildLaunchArgs('/tmp/ws').includes('--disable-extensions'));
  });

  test('orders args as base, workspace, then extras', () => {
    const args = buildLaunchArgs('/tmp/ws', ['--no-sandbox', '--disable-dev-shm-usage']);
    assert.deepStrictEqual(args, [
      '--disable-extensions',
      '/tmp/ws',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ]);
  });

  test('adds no extras when none are supplied', () => {
    assert.deepStrictEqual(buildLaunchArgs('/tmp/ws'), ['--disable-extensions', '/tmp/ws']);
  });

  test('scrubs an inherited ELECTRON_RUN_AS_NODE so Code.exe starts as Electron', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' };
    const result = sanitizeLaunchEnv(env);
    assert.ok(
      !('ELECTRON_RUN_AS_NODE' in result),
      'ELECTRON_RUN_AS_NODE survived — the child would run as Node and fail with "bad option"'
    );
    assert.strictEqual(result.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(result.PATH, '/usr/bin', 'unrelated variables must be preserved');
  });

  test('is a no-op when ELECTRON_RUN_AS_NODE is absent', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/x' };
    const result = sanitizeLaunchEnv(env);
    assert.strictEqual(result, env);
    assert.deepStrictEqual(Object.keys(env), ['HOME']);
  });
});

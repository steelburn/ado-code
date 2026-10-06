import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Guards the Open VSX publish path.
 *
 * The publish script is a thin gate in front of the `ovsx` CLI, so these tests
 * assert the properties that make it safe to run: it is directly executable, it
 * documents itself, it declares the token it needs, and — critically — it fails
 * locally rather than reaching the registry when it is misconfigured.
 *
 * No test here may actually publish. Every case below exits before (or, at
 * worst, with a fake token that could not publish anything) the upload step.
 */
suite('Open VSX publishing', () => {
  function findRepoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error('could not locate repository root from ' + __dirname);
  }

  function scriptPath(): string {
    return path.join(findRepoRoot(), 'scripts', 'publish-open-vsx.js');
  }

  function run(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [scriptPath(), ...args], {
      encoding: 'utf8',
      env,
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  test('the publish script exists and is directly executable', () => {
    assert.ok(fs.existsSync(scriptPath()), 'scripts/publish-open-vsx.js is missing');
    const src = fs.readFileSync(scriptPath(), 'utf8');
    assert.ok(
      src.startsWith('#!/usr/bin/env node'),
      'publish script must start with a node shebang so it can be run directly'
    );
    assert.ok(
      src.includes('OVSX_PAT'),
      'publish script must document/read the OVSX_PAT token'
    );
  });

  test('--help exits 0 and names Open VSX', () => {
    const result = run(['--help'], { ...process.env });
    assert.strictEqual(result.status, 0, 'expected --help to exit 0, got ' + result.status + ': ' + result.stderr);
    assert.ok(
      /open\s*vsx/i.test(result.stdout),
      'help text should explain that this publishes to Open VSX'
    );
  });

  test('refuses to publish without a token', () => {
    const env = { ...process.env };
    delete env.OVSX_PAT;
    const result = run([], env);
    assert.notStrictEqual(result.status, 0, 'publishing with no token must fail');
    assert.ok(
      /OVSX_PAT/.test(result.stdout + result.stderr),
      'the failure should tell the user which variable to set (OVSX_PAT)'
    );
  });

  test('refuses a missing/stale package before invoking ovsx', () => {
    const env = { ...process.env, OVSX_PAT: 'not-a-real-token' };
    const result = run(['--file', 'definitely-missing.vsix'], env);
    assert.notStrictEqual(result.status, 0, 'a package that is not there must fail the run');
    assert.ok(
      /definitely-missing\.vsix/.test(result.stdout + result.stderr),
      'the failure should name the package it could not find (guards against a vacuous pass)'
    );
    assert.ok(
      !/Published/i.test(result.stdout),
      'nothing may be reported as published when the package is missing'
    );
  });

  test('package.json declares the publish:open-vsx script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(findRepoRoot(), 'package.json'), 'utf8'));
    assert.ok(pkg.scripts, 'package.json has no "scripts" block');
    assert.strictEqual(
      pkg.scripts['publish:open-vsx'],
      'node scripts/publish-open-vsx.js',
      'package.json should expose the publish script as "publish:open-vsx"'
    );
  });
});

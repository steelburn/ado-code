#!/usr/bin/env node
/*
 * Publishes the packaged extension to Eclipse Open VSX.
 *
 * Open VSX is the registry that VS Code-compatible editors *other than* the
 * Microsoft build (VSCodium, Gitpod, Theia, code-server, ...) install from.
 * `vsce` cannot publish there — Open VSX is a separate registry with its own
 * CLI (`ovsx`), its own account, and its own token.
 *
 * `ovsx publish` uploads an existing .vsix; it does NOT build one. So this
 * script never packages. It gates, then delegates:
 *
 *   1. a token is present          (OVSX_PAT, or --pat)
 *   2. the .vsix exists            (package it with `vsce package` first)
 *   3. the .vsix filename version  matches package.json "version"
 *
 * Every gate runs BEFORE ovsx is invoked, so a misconfigured run fails on this
 * machine instead of half-authenticating against the registry.
 *
 * Gate 3 is filename-based on purpose: `vsce package` derives the filename from
 * package.json, so the realistic failure — an artifact packaged before a
 * version bump — shows up here as <name>-<old-version>.vsix and is caught.
 *
 * Usage:
 *   node scripts/publish-open-vsx.js                publish <name>-<version>.vsix
 *   node scripts/publish-open-vsx.js --verify-only  check token + namespace, publish nothing
 *   node scripts/publish-open-vsx.js --file x.vsix  publish a specific package
 *   OVSX_PAT=<token> node scripts/publish-open-vsx.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_REGISTRY = 'https://open-vsx.org';

function fail(message) {
  console.error('❌ ' + message);
  process.exit(1);
}

function note(message) {
  console.log('• ' + message);
}

function parseArgs(argv) {
  const opts = { file: null, pat: null, registry: null, verifyOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--verify-only') {
      opts.verifyOnly = true;
    } else if (arg === '--file') {
      opts.file = argv[++i];
    } else if (arg === '--pat') {
      opts.pat = argv[++i];
    } else if (arg === '--registry') {
      opts.registry = argv[++i];
    } else {
      fail('unknown argument: ' + arg + ' (try --help)');
    }
  }
  return opts;
}

function usage() {
  console.log(
    [
      'Publish ado-code to Eclipse Open VSX.',
      '',
      'Usage: node scripts/publish-open-vsx.js [options]',
      '',
      'Options:',
      '  --file <path>      .vsix to publish (default: <name>-<version>.vsix)',
      '  --pat <token>      Open VSX access token (default: $OVSX_PAT)',
      '  --registry <url>   Registry base URL (default: ' + DEFAULT_REGISTRY + ')',
      '  --verify-only      Verify the token can publish to the namespace; publish nothing',
      '  -h, --help         Show this help',
      '',
      'Environment:',
      '  OVSX_PAT           Access token, used when --pat is omitted',
      '  OVSX_BIN           Explicit path to the ovsx CLI entry point (bin/ovsx)',
    ].join('\n')
  );
}

/*
 * Locate the `ovsx` CLI. It is a global tool, not a dependency of this repo, so
 * we probe candidate locations and require the first one that actually runs.
 *
 * We resolve to the JS entry point and run it through `process.execPath` rather
 * than spawning the `ovsx`/`ovsx.cmd` shim: on Windows a `.cmd` cannot be
 * spawned reliably without a shell, and going through a shell would put the
 * access token on a command line where it could be mangled or logged.
 */
function resolveOvsx() {
  const candidates = [];
  if (process.env.OVSX_BIN) {
    candidates.push(process.env.OVSX_BIN);
  }
  candidates.push(path.join(REPO_ROOT, 'node_modules', 'ovsx', 'bin', 'ovsx'));
  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, 'node_modules', 'ovsx', 'bin', 'ovsx'));
  candidates.push(path.join(execDir, '..', 'lib', 'node_modules', 'ovsx', 'bin', 'ovsx'));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const probe = spawnSync(process.execPath, [candidate, '--version'], { encoding: 'utf8' });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function runOvsx(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
  if (result.error) {
    fail('could not run ovsx: ' + result.error.message);
  }
  return result.status === null ? 1 : result.status;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const registry = opts.registry || process.env.OVSX_REGISTRY_URL || DEFAULT_REGISTRY;

  // Gate 1 — credentials. Checked first so a missing token is reported before
  // anything else, and so we never reach the upload step unauthenticated.
  const pat = opts.pat || process.env.OVSX_PAT;
  if (!pat) {
    fail(
      'no Open VSX token.\n' +
        '   Set OVSX_PAT, or pass --pat <token>.\n' +
        '   Create one at ' + registry + ' (User Settings -> Access Tokens) after the\n' +
        '   publisher namespace "' + pkg.publisher + '" is claimed by your account.'
    );
  }

  let vsixPath = null;
  let vsixName = null;

  if (!opts.verifyOnly) {
    // Gate 2 — the artifact.
    const expected = pkg.name + '-' + pkg.version + '.vsix';
    vsixPath = opts.file ? path.resolve(opts.file) : path.join(REPO_ROOT, expected);
    vsixName = path.basename(vsixPath);

    if (!fs.existsSync(vsixPath)) {
      fail(
        'package not found: ' + vsixPath + '\n' +
          '   Package it first with `vsce package` (it runs the compile + bundle steps).'
      );
    }

    // Gate 3 — version identity.
    if (vsixName !== expected) {
      fail(
        '.vsix version does not match package.json\n' +
          '   expected: ' + expected + '\n' +
          '   found:    ' + vsixName + '\n' +
          '   The artifact is stale - repackage before publishing.'
      );
    }
  }

  const ovsx = resolveOvsx();
  if (!ovsx) {
    fail(
      'could not find the ovsx CLI.\n' +
        '   Install it globally:  npm install -g ovsx\n' +
        '   ...or point OVSX_BIN at its bin/ovsx entry point.'
    );
  }

  const common = ['-p', pat, '-r', registry];

  if (opts.verifyOnly) {
    note('verifying token for namespace "' + pkg.publisher + '" on ' + registry);
    const status = runOvsx(ovsx, ['verify-pat', pkg.publisher, ...common]);
    if (status !== 0) {
      fail('token verification failed (ovsx exit ' + status + ')');
    }
    console.log('✅ token can publish to "' + pkg.publisher + '"');
    return;
  }

  note('publishing ' + vsixName + ' to ' + registry + ' as "' + pkg.publisher + '"');
  const status = runOvsx(ovsx, ['publish', vsixPath, ...common]);
  if (status !== 0) {
    fail('ovsx publish failed (exit ' + status + ')');
  }
  console.log('✅ published ' + pkg.name + ' ' + pkg.version + ' to ' + registry);
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}

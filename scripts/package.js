#!/usr/bin/env node
/*
 * Builds the extension and packages it into a .vsix.
 *
 * Why this exists instead of a bare `vsce package`:
 *
 * 1. `vsce package` run from the repo root never finishes here. It enumerates
 *    .vscode-test/ (two full VS Code downloads) and node_modules/ *before* it
 *    applies .vscodeignore, so it walks ~2.5 GB, the shell tool times out, and
 *    the timeout orphans a node.exe that has to be killed by hand. Staging only
 *    the shipped files into a temp dir produces the same package in seconds.
 *
 * 2. The staged set has to be the WHOLE shipped set. `webview-ui-dist/` is the
 *    chat / draft-queue webview bundle (76 files, ~6.8 MB of lazy chunks) and is
 *    easy to leave out because it is a build output rather than a source dir.
 *    Ship without it and nothing looks broken: the extension activates, the
 *    view resolves, and the panel is just blank — the <script src> misses the
 *    CSP allowlist and 404s. So the set is enumerated once, in this file, and
 *    the finished .vsix is asserted to contain both bundles.
 *
 * Usage:
 *   node scripts/package.js                 build + stage + package, then verify
 *   node scripts/package.js --skip-build    reuse dist/ and webview-ui-dist/ as they are
 *   node scripts/package.js --dev           name the file ado-code-<version>-dev.vsix
 *   node scripts/package.js --out file.vsix write somewhere other than the repo root
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Loose files that ship as-is (vsce renames LICENSE to LICENSE.txt itself). */
const SHIP_FILES = ['README.md', 'CHANGELOG.md', 'LICENSE'];

/**
 * Directories that ship whole. `dist/` is the esbuild extension bundle,
 * `webview-ui-dist/` the webpack webview bundle built from src/webview-ui.
 */
const SHIP_DIRS = ['dist', 'webview-ui-dist', 'resources', 'docs'];

/** Entries the finished .vsix must contain — a package missing one is broken. */
const REQUIRED_VSIX_ENTRIES = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/webview-ui-dist/webview.js',
];

/** Build outputs that must exist before packaging. */
const REQUIRED_ARTIFACTS = [
  { rel: 'dist/extension.js', hint: 'npm run bundle' },
  { rel: 'webview-ui-dist/webview.js', hint: 'npm run build:webview' },
];

function fail(message) {
  console.error('\nFAILED: ' + message + '\n');
  process.exit(1);
}

function step(title) {
  console.log('\n' + title);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    // .cmd shims (vsce, npm) only resolve through a shell on Windows.
    shell: process.platform === 'win32',
  });
  if (result.error) fail(command + ': ' + result.error.message);
  if (result.status !== 0) fail(command + ' exited with code ' + result.status);
}

function parseArgs(argv) {
  const options = { build: true, dev: false, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--skip-build') {
      options.build = false;
    } else if (arg === '--dev') {
      options.dev = true;
    } else if (arg === '--out') {
      options.out = argv[++i];
      if (!options.out) fail('--out needs a file path');
    } else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/package.js [--skip-build] [--dev] [--out <file.vsix>]');
      process.exit(0);
    } else {
      fail('unknown argument: ' + arg);
    }
  }
  return options;
}

function build() {
  step('1/5  build');
  run('node', [path.join(REPO_ROOT, 'scripts', 'check-version.js')], REPO_ROOT);
  run('node', [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', './'], REPO_ROOT);
  run('node', [path.join(REPO_ROOT, 'scripts', 'build.js')], REPO_ROOT);
}

function validateArtifacts() {
  step('2/5  verify build outputs');
  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!fs.existsSync(path.join(REPO_ROOT, artifact.rel))) {
      fail('missing ' + artifact.rel + ' — run `' + artifact.hint + '` first, or drop --skip-build');
    }
    console.log('  ok  ' + artifact.rel);
  }
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      // node_modules never ships (.vscodeignore is irrelevant in a staged dir).
      if (entry.name === 'node_modules') continue;
      files += copyTree(source, target);
    } else {
      // .vscodeignore drops **/*.map; the maps are only useful when debugging.
      if (entry.name.endsWith('.map')) continue;
      fs.copyFileSync(source, target);
      files++;
    }
  }
  return files;
}

function stage(staging) {
  step('3/5  stage the shipped file set');
  // vscode:prepublish must go: vsce runs it before packaging, and it would
  // rebuild in a directory that has no node_modules.
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  if (manifest.scripts) delete manifest.scripts['vscode:prepublish'];
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  let files = 1;
  for (const name of SHIP_FILES) {
    fs.copyFileSync(path.join(REPO_ROOT, name), path.join(staging, name));
    files++;
  }
  for (const dir of SHIP_DIRS) {
    const source = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(source)) fail('missing shipped directory: ' + dir);
    files += copyTree(source, path.join(staging, dir));
  }
  console.log('  ' + files + ' files staged');
  return manifest;
}

function packageVsix(staging, outFile) {
  step('4/5  vsce package');
  run('vsce', ['package', '--out', '"' + outFile + '"'], staging);
}

function verifyVsix(vsixFile) {
  step('5/5  verify the .vsix');
  if (!fs.existsSync(vsixFile)) fail('vsce reported success but ' + vsixFile + ' does not exist');
  // Zip stores entry names uncompressed, so a plain byte search finds them
  // without pulling in a zip reader.
  const buffer = fs.readFileSync(vsixFile);
  const missing = REQUIRED_VSIX_ENTRIES.filter((entry) => buffer.indexOf(entry) < 0);
  if (missing.length > 0) fail('the .vsix is missing ' + missing.join(', '));
  const megabytes = buffer.length / (1024 * 1024);
  // A package without the 6.8 MB webview bundle lands around 0.6 MB; anything
  // that small means the bundle silently did not make it in.
  if (megabytes < 1) fail('suspiciously small .vsix (' + megabytes.toFixed(2) + ' MB) — webview-ui-dist/ did not land');
  for (const entry of REQUIRED_VSIX_ENTRIES) console.log('  ok  ' + entry);
  return { bytes: buffer.length, megabytes };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) build();
  validateArtifacts();

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-code-pkg-'));
  try {
    const manifest = stage(staging);
    const suffix = options.dev ? '-dev' : '';
    const outFile = path.resolve(
      options.out || path.join(REPO_ROOT, manifest.name + '-' + manifest.version + suffix + '.vsix'),
    );
    packageVsix(staging, outFile);
    const stats = verifyVsix(outFile);
    console.log('\nPackaged ' + manifest.name + ' ' + manifest.version + ' -> ' + path.basename(outFile));
    console.log('  ' + outFile);
    console.log('  ' + stats.bytes + ' bytes (' + stats.megabytes.toFixed(2) + ' MB)');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}

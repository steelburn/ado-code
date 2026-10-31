#!/usr/bin/env node
/*
 * Tiered test runner — cheap by default, exhaustive on demand.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm test` used to boot the real VS Code test host for every run
 * (src/test/runTest.ts → Electron). Measured on this repo:
 *
 *   Electron host : >120s, needs a GUI + a .vscode-test download, and mocha's
 *                   `spec` reporter printed ~177,000 chars (~44k tokens) of
 *                   "√ <test name>" noise *before it had even finished*.
 *   Headless stub : 97s, no GUI, and the same 132 suite files run to
 *                   2049 passing / 2 pending / 0 failing with ~44 chars out.
 *
 * The host was not adding coverage — it was adding a boot, a download and a
 * context blowout. So the default gate here is the headless run and the host
 * is opt-in (`--host`), reserved for the rare case where a suite passes only
 * because scripts/vscode-stub.js is permissive.
 *
 * USAGE
 *   node scripts/test.js                full suite, headless, quiet   (~97s)
 *   node scripts/test.js --changed      only suites affected by the working tree
 *   node scripts/test.js --changed --base origin/main
 *   node scripts/test.js --grep "GitService"
 *   node scripts/test.js --host         real VS Code host (pre-PR, opt-in)
 *   node scripts/test.js --verbose      spec reporter (every test name)
 *   node scripts/test.js --no-compile   reuse the existing out/ build
 *
 * OUTPUT BUDGET
 *   A green run prints one summary line. A red run prints the failures only,
 *   capped at MAX_FAIL_CHARS, so a broken suite cannot eat the chat context.
 *
 * Zero runtime deps; runs on plain node.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_OUT = path.join(ROOT, 'out', 'test', 'suite');
const TEST_SRC = path.join(ROOT, 'src', 'test', 'suite');
const MOCHA = path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const HOST_RUNNER = path.join(ROOT, 'out', 'test', 'runTest.js');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_FAIL_CHARS = 12000;

/* Files whose blast radius is the whole extension: touching one of these
 * (manifest, build config, shared utilities imported everywhere, the webview
 * bundle) drops the targeted mode and runs everything. */
const GLOBAL_PREFIXES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.eslintrc.json',
  'scripts/',
  'src/webview-ui/',
  'src/shared/',
  'src/test/',
];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name) => argv.includes(name);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : undefined;
};

const opts = {
  changed: arg('--changed') || arg('-c'),
  host: arg('--host'),
  verbose: arg('--verbose'),
  compile: !arg('--no-compile'),
  grep: argValue('--grep'),
  base: argValue('--base'),
  files: argValue('--files'),
  dryRun: arg('--dry-run'),
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const rel = (p) => p.split(path.sep).join('/');

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) { return out; }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, filter, out); }
    else if (filter(entry.name)) { out.push(full); }
  }
  return out;
}

function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) { return []; }
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function fmtSeconds(ms) { return `${Math.round(ms / 1000)}s`; }

// ---------------------------------------------------------------------------
// changed-file → affected-suite mapping
// ---------------------------------------------------------------------------
/* The index is deliberately import-aware but approximate: a suite is selected
 * when it imports a module whose basename matches the changed file, or when it
 * lives in the suite directory named after the changed source directory. That
 * over-selects slightly (cheap) instead of under-selecting (silent green). */
function changedFiles() {
  // --files lets you state the change set explicitly (and makes the mapping
  // testable without dirtying the working tree).
  if (opts.files) {
    return opts.files.split(',').map((f) => rel(f.trim())).filter(Boolean);
  }
  const files = new Set();
  const add = (list) => list.forEach((f) => files.add(rel(f)));

  add(git(['diff', '--name-only']));
  add(git(['diff', '--name-only', '--cached']));
  add(git(['ls-files', '--others', '--exclude-standard']));
  if (opts.base) { add(git(['diff', '--name-only', `${opts.base}...HEAD`])); }
  return [...files];
}

function buildSuiteIndex() {
  const suiteSrc = walk(TEST_SRC, (n) => n.endsWith('.test.ts'));
  return suiteSrc.map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((m) => (m[1] || m[2] || '').split('/').pop())
      .filter((s) => s && s !== '.');
    const dir = rel(path.dirname(path.relative(TEST_SRC, file)));
    const outFile = path.join(TEST_OUT, rel(path.relative(TEST_SRC, file))).replace(/\.ts$/, '.js');
    return { file, outFile, imports, dir };
  });
}

function selectSuites(files) {
  const globalHit = files.find((f) => GLOBAL_PREFIXES.some((p) => f === p || f.startsWith(p)));
  if (globalHit) {
    return { all: true, reason: `${globalHit} has extension-wide blast radius` };
  }

  const sources = files.filter((f) => f.startsWith('src/') && f.endsWith('.ts'));
  if (sources.length === 0) {
    return { all: false, suites: [], reason: 'no source files changed' };
  }

  const index = buildSuiteIndex();
  const picked = new Map();
  const unmatched = [];

  for (const src of sources) {
    const base = path.basename(src, path.extname(src));
    const dirName = path.basename(path.dirname(src));
    const tokens = new Set([base, dirName].filter(Boolean).map((t) => t.toLowerCase()).filter((t) => t !== 'src'));

    let hit = 0;
    for (const suite of index) {
      const nameMatch = suite.imports.some((imp) => tokens.has(imp.toLowerCase()));
      const dirMatch = suite.dir.toLowerCase().split('/').some((seg) => tokens.has(seg));
      if (nameMatch || dirMatch) { picked.set(suite.outFile, suite); hit++; }
    }
    if (hit === 0) { unmatched.push(src); }
  }

  if (picked.size === 0) {
    return { all: true, reason: 'nothing mapped to a suite' };
  }
  return { all: false, suites: [...picked.keys()], total: index.length, unmatched };
}

// ---------------------------------------------------------------------------
// mocha invocation
// ---------------------------------------------------------------------------
function stripAnsi(s) { return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); }

function runMocha(files) {
  const reporter = opts.verbose ? 'spec' : 'min';
  const args = [
    MOCHA,
    '--ui', 'tdd',
    '--timeout', String(DEFAULT_TIMEOUT_MS),
    '--exit',
    '--require', './scripts/vscode-stub.js',
    '--reporter', reporter,
  ];
  if (opts.grep) { args.push('--grep', opts.grep); }
  args.push(...files);

  const started = Date.now();
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const elapsed = fmtSeconds(Date.now() - started);
  const raw = stripAnsi(`${res.stdout || ''}${res.stderr || ''}`);
  const failed = res.status !== 0;

  if (!failed) {
    const line = raw.split('\n').find((l) => /\d+ passing/.test(l));
    const pending = (raw.match(/(\d+) pending/) || [])[1];
    console.log(`\n✅ ${(line || 'tests passed').trim()}${pending ? `, ${pending} pending` : ''} — ${elapsed}`);
    return 0;
  }

  // Red: keep only the failure block, and cap it. Printed on STDOUT so the
  // detail survives wrappers/toolings that drop a non-zero exit's stderr.
  const idx = raw.search(/\n\s*\d+ failing/);
  const detail = idx >= 0 ? raw.slice(idx) : raw;
  const body = detail.length > MAX_FAIL_CHARS
    ? `${detail.slice(0, MAX_FAIL_CHARS)}\n… truncated (${detail.length - MAX_FAIL_CHARS} chars); re-run with --grep "<suite name>" for one failure.\n`
    : detail;
  console.log(`\n❌ tests failed — ${elapsed}${body}`);
  return 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  if (opts.host) {
    // Opt-in exhaustive run: real VS Code host. Use before a PR, or when you
    // suspect a suite only passes because the stub is permissive.
    if (opts.compile) {
      console.log('▶ compiling (tsc)…');
      const tsc = spawnSync(process.execPath, [TSC, '-p', '.'], { cwd: ROOT, stdio: 'inherit' });
      if (tsc.status !== 0) { console.error('❌ compile failed'); return 1; }
    }
    console.log('▶ VS Code host run (exhaustive, noisy — this is the slow tier)…');
    const res = spawnSync(process.execPath, [HOST_RUNNER], { cwd: ROOT, stdio: 'inherit' });
    return res.status || 0;
  }

  if (opts.compile) {
    const started = Date.now();
    const tsc = spawnSync(process.execPath, [TSC, '-p', '.'], { cwd: ROOT, encoding: 'utf8' });
    if (tsc.status !== 0) {
      console.log('❌ compile failed:\n' + stripAnsi(`${tsc.stdout || ''}${tsc.stderr || ''}`).slice(0, MAX_FAIL_CHARS));
      return 1;
    }
    console.log(`▶ tsc ok (${fmtSeconds(Date.now() - started)})`);
  }

  let files;
  if (opts.changed) {
    const files0 = changedFiles();
    const sel = selectSuites(files0);
    if (sel.all) {
      console.log(`▶ changed set → full suite (${sel.reason})`);
      files = [path.join(TEST_OUT, '**', '*.test.js')];
    } else if (sel.suites.length === 0) {
      console.log(`▶ nothing to run (${sel.reason})`);
      return 0;
    } else {
      files = sel.suites.sort();
      console.log(`▶ targeted: ${files.length}/${sel.total} suites`);
      if (sel.unmatched.length) {
        console.log(`  no suite matched: ${sel.unmatched.join(', ')} (review manually)`);
      }
      // dry-run handled centrally below, so the "all suites" path reports too
    }
  } else {
    files = [path.join(TEST_OUT, '**', '*.test.js')];
  }

  if (opts.dryRun) {
    if (files.some((f) => f.includes('*'))) {
      console.log('   (all suites — nothing narrowed the selection)');
    } else {
      files.forEach((f) => console.log('   ' + rel(path.relative(TEST_OUT, f))));
    }
    return 0;
  }

  const existing = files.filter((f) => f.includes('*') || fs.existsSync(f));
  if (existing.length === 0) {
    console.log('❌ no compiled test files — run without --no-compile');
    return 1;
  }
  return runMocha(existing);
}

process.exitCode = main();

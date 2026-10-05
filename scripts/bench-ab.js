#!/usr/bin/env node
'use strict';
/**
 * ADO Code — interleaved A/B startup benchmark.
 *
 * `scripts/bench-startup.js` measures one entry per process; running the two
 * entries one after the other lets machine drift (disk cache, antivirus, other
 * load) leak into the comparison. This driver alternates entries round-robin in
 * the SAME session and reports min / median / mean, which cancels most drift.
 *
 * Usage:
 *   node scripts/bench-ab.js <entryA> <entryB> [--runs N] [--flag ...]
 * Example:
 *   node scripts/bench-ab.js out/extension.js dist/extension.js --runs 7 --activate
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.on('uncaughtException', (e) => {
  fs.writeFileSync(path.join(ROOT, '.bench-error.txt'), e.stack || String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  fs.writeFileSync(path.join(ROOT, '.bench-error.txt'), e && e.stack ? e.stack : String(e));
  process.exit(1);
});
const argv = process.argv.slice(2);
const runsIdx = argv.indexOf('--runs');
const RUNS = runsIdx >= 0 ? parseInt(argv[runsIdx + 1], 10) : 7;
const flags = argv.filter((a, i) => a !== '--runs' && (runsIdx < 0 || i !== runsIdx + 1));
const entries = flags.filter((a) => !a.startsWith('--'));
const extra = flags.filter((a) => a.startsWith('--'));

if (entries.length < 2) {
  console.error('usage: node scripts/bench-ab.js <entryA> <entryB> [--runs N] [--activate] [--services]');
  process.exit(2);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const fmt = (x) => (x === undefined ? '   n/a' : x.toFixed(1).padStart(6));

const samples = new Map(entries.map((e) => [e, []]));
const loads = new Map(entries.map((e) => [e, []]));
const failures = [];

// Warm-up round (discarded) so the first file reads don't skew the samples.
for (const entry of entries) {
  run(entry, true);
}
for (let round = 0; round < RUNS; round++) {
  for (const entry of entries) run(entry, false);
}

function run(entry, warmup) {
  const args = [path.join(ROOT, 'scripts', 'bench-startup.js'), '--entry', entry, '--json', ...extra];
  let out;
  try {
    out = execFileSync(process.execPath, ['--no-warnings', ...args], { encoding: 'utf8', cwd: ROOT, shell: false, windowsHide: true });
  } catch (err) {
    failures.push(`${entry}: ${err.message.split('\n')[0]}`);
    return;
  }
  const json = JSON.parse(out.trim().split('\n').pop());
  if (warmup) return;
  if (json.activateMs !== undefined) samples.get(entry).push(json.activateMs);
  if (json.loadMs !== undefined) loads.get(entry).push(json.loadMs);
}

const summary = {};
console.log(`runs per entry: ${RUNS} (interleaved, 1 warm-up round discarded)\n`);
console.log('entry'.padEnd(30) + 'metric'.padEnd(12) + 'min'.padStart(8) + 'median'.padStart(9) + 'mean'.padStart(9));
for (const entry of entries) {
  summary[entry] = {};
  for (const [name, map] of [['activate() ms', samples], ['cold load ms', loads]]) {
    const xs = map.get(entry);
    if (!xs.length) continue;
    const stat = { min: Math.min(...xs), median: median(xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length, samples: xs };
    summary[entry][name] = stat;
    console.log(entry.padEnd(30) + name.padEnd(12) + fmt(stat.min) + fmt(stat.median).padStart(9) + fmt(stat.mean).padStart(9));
  }
}
fs.writeFileSync(path.join(ROOT, '.bench-ab.json'), JSON.stringify({ runs: RUNS, entries, summary, failures }, null, 2));
if (failures.length) console.log(`\n${failures.length} child run(s) failed:\n  ` + failures.slice(0, 5).join('\n  '));

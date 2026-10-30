#!/usr/bin/env node
'use strict';
/**
 * ADO Code — extension bundler (P1 startup optimisation).
 *
 * Activation cost is dominated by loading the extension's module graph. Before
 * this script the extension was shipped as ~150 loose CommonJS files emitted by
 * `tsc`, so activating it meant ~150 separate `require()` resolutions from disk.
 * We now bundle `src/extension.ts` into a single `dist/extension.js` with
 * esbuild — one file read, minified, tree-shaken.
 *
 * Invariants preserved from the previous "plain tsc, zero runtime dependencies"
 * design (they MUST hold, and are verified below):
 *   - `vscode` is never bundled (it is provided by the extension host).
 *   - The bundle contains no `require()` of any npm package or relative path —
 *     only `vscode` and Node built-ins — so the packaged extension still has
 *     ZERO runtime dependencies and needs no `node_modules`.
 *
 * `tsc` is still run separately (`npm run compile`) for type-checking and for
 * compiling the test suite to `out/`, which is what `npm test` executes.
 *
 * Usage:
 *   node scripts/build.js [--watch] [--no-minify] [--metafile]
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'extension.ts');
const OUTFILE = path.join(ROOT, 'dist', 'extension.js');

const WATCH = process.argv.includes('--watch');
const MINIFY = !process.argv.includes('--no-minify');
const METAFILE = process.argv.includes('--metafile');

const BUILTINS = new Set(Module.builtinModules.flatMap((m) => [m, `node:${m}`]));
const ALLOWED_EXTERNALS = new Set(['vscode', ...BUILTINS]);

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('❌ esbuild is not installed. Run: npm install');
  process.exit(1);
}

/**
 * Fail the build if anything other than `vscode` / Node built-ins ends up in the
 * bundle. This replaces the old comment-based "no bundler, zero runtime deps"
 * promise with a mechanical guarantee.
 *
 * The check reads esbuild's metafile — the module graph esbuild actually
 * resolved — instead of grepping the emitted code for `require(...)` calls: the
 * bundle legitimately carries string *data* that looks like one (the project
 * scaffolder writes a `metro.config.js` that requires
 * `@react-native/metro-config`), and a regex over minified output cannot tell
 * code from data. Two checks cover the invariant from both ends:
 *   1. no input may come from `node_modules` — an inlined npm package would need
 *      files the packaged extension does not ship;
 *   2. every import left in the output must be an allowed external.
 */
function verifyBundle(metafile) {
  const offenders = new Set();
  for (const input of Object.keys(metafile.inputs || {})) {
    if (input.split(/[\\/]/).includes('node_modules')) offenders.add(input);
  }
  for (const out of Object.values(metafile.outputs || {})) {
    for (const imp of out.imports || []) {
      if (imp.external && !ALLOWED_EXTERNALS.has(imp.path)) offenders.add(imp.path);
    }
  }
  if (offenders.size > 0) {
    console.error(`❌ bundle pulls in unexpected modules: ${[...offenders].join(', ')}`);
    console.error('   No npm package may be bundled; only "vscode" and Node built-ins may stay external.');
    process.exit(1);
  }
  console.log('✅ dependency guard: bundle only requires vscode + Node built-ins');
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: MINIFY,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
};

function reportSize() {
  const bytes = fs.statSync(OUTFILE).size;
  let raw = 0;
  for (const f of walk(path.join(ROOT, 'out'))) raw += fs.statSync(f).size;
  console.log(`   bundle: ${(bytes / 1024).toFixed(1)} KB   (unbundled out/: ${(raw / 1024).toFixed(1)} KB)`);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

async function main() {
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  if (WATCH) {
    const ctx = await esbuild.context({ ...options, plugins: [guardPlugin()] });
    await ctx.watch();
    console.log('👀 esbuild watching src/ → dist/extension.js');
    return;
  }
  const result = await esbuild.build(options);
  if (METAFILE) {
    fs.writeFileSync(path.join(ROOT, 'dist', 'meta.json'), JSON.stringify(result.metafile, null, 2));
  }
  verifyBundle(result.metafile);
  reportSize();
  console.log('✅ bundled dist/extension.js');
}

/** Re-runs the guard on every watch rebuild. */
function guardPlugin() {
  return {
    name: 'ado-code-guard',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0 || !result.metafile) return;
        try { verifyBundle(result.metafile); reportSize(); } catch (err) { console.error(err); }
      });
    },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

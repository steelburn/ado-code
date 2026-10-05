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
 * Fail the build if the bundle requires anything other than `vscode` / Node
 * built-ins. This replaces the old comment-based "no bundler, zero runtime deps"
 * promise with a mechanical guarantee.
 */
function verifyExternals(file) {
  const code = fs.readFileSync(file, 'utf8');
  const offenders = new Set();
  const re = /require\(\s*(["'])([^"']+)\1\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const spec = m[2];
    if (!ALLOWED_EXTERNALS.has(spec)) offenders.add(spec);
  }
  if (offenders.size > 0) {
    console.error(`❌ bundle requires unexpected modules: ${[...offenders].join(', ')}`);
    console.error('   Only "vscode" and Node built-ins may remain external.');
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
  metafile: METAFILE,
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
  if (result.metafile) {
    fs.writeFileSync(path.join(ROOT, 'dist', 'meta.json'), JSON.stringify(result.metafile, null, 2));
  }
  verifyExternals(OUTFILE);
  reportSize();
  console.log('✅ bundled dist/extension.js');
}

/** Re-runs the guard on every watch rebuild. */
function guardPlugin() {
  return {
    name: 'ado-code-guard',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        try { verifyExternals(OUTFILE); reportSize(); } catch (err) { console.error(err); }
      });
    },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/*
 * Version-identity gate.
 *
 * The released version is written down in TWO places:
 *   - package.json "version"      — the marketplace manifest (source of truth)
 *   - src/shared/version.ts       — EXTENSION_VERSION / ADO_CODE_USER_AGENT
 *
 * They drifted once: the manifest reached 0.7.0 while EXTENSION_VERSION stayed
 * 0.6.7, so every LLM request announced a version that had never shipped and
 * provider/gateway logs were wrong. package.json is the source of truth, so this
 * script fails hard when the constant does not match it.
 *
 * Runs in two places so drift cannot reach a user:
 *   - `vscode:prepublish` (added) — blocks `vsce package` / `vsce publish`
 *   - scripts/pre-commit.js — fast failure before the VS Code test boot;
 *     src/test/suite/shared/version.test.ts asserts the same invariant in-suite
 *
 * Zero runtime deps and no TypeScript build required: it parses both files as
 * text so it stays valid even when the project does not compile.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const VERSION_TS = path.join(ROOT, 'src', 'shared', 'version.ts');

const fail = (msg) => {
  console.error(`\n❌ version check failed: ${msg}`);
  console.error('   Bump EXTENSION_VERSION in src/shared/version.ts to match package.json "version".');
  process.exit(1);
};

const pkgVersion = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
if (typeof pkgVersion !== 'string' || !pkgVersion) {
  fail('package.json has no "version" field');
}

const src = fs.readFileSync(VERSION_TS, 'utf8');

const constant = src.match(/export\s+const\s+EXTENSION_VERSION\s*=\s*'([^']+)'/);
if (!constant) {
  fail("could not find `export const EXTENSION_VERSION = '<version>'` in src/shared/version.ts");
}

if (constant[1] !== pkgVersion) {
  fail(`EXTENSION_VERSION '${constant[1]}' !== package.json version '${pkgVersion}'`);
}

// The User-Agent must be derived from the constant, never written out again —
// a second literal is exactly how the 0.6.7 value survived into 0.7.0.
const userAgent = src.match(/export\s+const\s+ADO_CODE_USER_AGENT\s*=\s*`([^`]+)`/);
if (!userAgent) {
  fail('could not find `export const ADO_CODE_USER_AGENT = `...`` in src/shared/version.ts');
}
if (!userAgent[1].includes('${EXTENSION_VERSION}')) {
  fail('ADO_CODE_USER_AGENT does not interpolate ${EXTENSION_VERSION} (hardcoded version?)');
}
if (/ADO-Code\/\d+\.\d+\.\d+/.test(userAgent[1])) {
  fail('ADO_CODE_USER_AGENT contains a hardcoded version literal');
}

console.log(`✅ version check passed — package.json and EXTENSION_VERSION both ${pkgVersion}`);

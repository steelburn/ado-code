import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { CONFIG_SETTING_KEYS, parseSaveConfigPayload, isConfigValue } from '../../../shared/configSchema';
import { CATEGORIES, ADVANCED_CATEGORY } from '../../../config/catalog';

// Guardrail for the Stage 4 saveConfig hardening.
//
// The Configuration page posts `{ type: 'saveConfig', config }`, where `config`
// is the full settings map the host handed it via getFullConfig. Two failure
// modes this suite pins down:
//
//   * drift  — a contributed setting the host forgets to read in _allSettings()
//              comes back as `undefined` and a Save clobbers the real value.
//              (mcp.servers shipped exactly this bug.)
//   * garbage — an unknown/typo'd key, or a value that is not a JSON config
//              value (function/symbol/undefined), is written anyway.
//
// zod is used here purely as an INDEPENDENT ORACLE (test-only devDependency).
// It cannot run in the extension host: ADO Code ships ZERO runtime dependencies
// (.vscodeignore excludes node_modules/**) and compiles with plain tsc (no
// bundler), so a runtime `require('zod')` in src/ would crash the host. The
// runtime validator therefore stays dependency-free; this suite proves it agrees
// with a zod schema.

const ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Every `adoCode.*` key contributed via package.json, prefix stripped. */
function contributedKeys(): string[] {
  const pkg = JSON.parse(read('package.json')) as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } };
  };
  const props = pkg.contributes?.configuration?.properties ?? {};
  return Object.keys(props).map(k => k.replace(/^adoCode\./, ''));
}

/** The host must derive _allSettings() from the canonical key list, not a copy. */
function hostReadsCanonicalKeys(): boolean {
  const src = read('src/webview/ChatViewProvider.ts');
  const at = src.indexOf('private _allSettings()');
  assert.ok(at >= 0, '_allSettings() not found in ChatViewProvider.ts');
  const body = src.slice(at, at + 4000);
  return (
    /for \(const key of CONFIG_SETTING_KEYS\)/.test(body) &&
    !/readonly ConfigSettingKey\[\]/.test(body)
  );
}

/** `key: '…'` literals in the Configuration page catalog. */
function catalogKeys(): string[] {
  return [...CATEGORIES, ADVANCED_CATEGORY]
    .flatMap(c => c.sections)
    .flatMap(s => s.settings)
    .map(s => s.key);
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── zod oracle ───────────────────────────────────────────────────────────────
// The substantive rule the runtime validator encodes: every key of the payload
// must be a member of the canonical setting-key union.
const knownKey = z.enum(CONFIG_SETTING_KEYS);
function oracleAcceptsEveryKey(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  return Object.keys(payload as object).every(k => knownKey.safeParse(k).success);
}

suite('Configuration saveConfig schema (Stage 4)', () => {
  test('the canonical key list matches every contributed adoCode.* setting', () => {
    const contributed = contributedKeys().sort();
    const canonical = [...CONFIG_SETTING_KEYS].sort();
    assert.deepStrictEqual(
      canonical,
      contributed,
      'CONFIG_SETTING_KEYS must equal the contributed settings surface',
    );
  });

  test('the canonical key list has no duplicates', () => {
    assert.strictEqual(new Set(CONFIG_SETTING_KEYS).size, CONFIG_SETTING_KEYS.length);
  });

  test('_allSettings derives from the canonical key list (no local copy)', () => {
    assert.ok(
      hostReadsCanonicalKeys(),
      '_allSettings must iterate CONFIG_SETTING_KEYS and keep no second key list',
    );
  });

  test('every catalog key is a canonical setting key', () => {
    const known = new Set<string>(CONFIG_SETTING_KEYS);
    const orphans = catalogKeys().filter(k => !known.has(k));
    assert.deepStrictEqual(orphans, [], 'catalog keys missing from CONFIG_SETTING_KEYS');
  });

  test('the saveConfig handler validates through parseSaveConfigPayload', () => {
    const src = read('src/webview/ChatViewProvider.ts');
    assert.ok(
      /parseSaveConfigPayload\(/.test(src),
      'saveConfig must validate the payload via parseSaveConfigPayload()',
    );
    assert.ok(
      !/Object\.entries\(message\.config\)/.test(src),
      'the unvalidated Object.entries(message.config) loop must be gone',
    );
  });

  test('accepts known keys and ignores unknown ones', () => {
    const parsed = parseSaveConfigPayload({ 'chat.density': 'compact', 'not.a.setting': 1 });
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.entries, [['chat.density', 'compact']]);
    assert.strictEqual(parsed.ignored.length, 1);
    assert.strictEqual(parsed.ignored[0].key, 'not.a.setting');
  });

  test('one bad key never drops the valid ones', () => {
    const parsed = parseSaveConfigPayload({
      'bogus.one': 1,
      'chat.density': 'compact',
      'bogus.two': true,
    });
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.entries, [['chat.density', 'compact']]);
    assert.strictEqual(parsed.ignored.length, 2);
  });

  test('rejects payloads that are not plain objects', () => {
    for (const bad of [null, 42, 'x', true, [], undefined]) {
      const parsed = parseSaveConfigPayload(bad);
      assert.strictEqual(parsed.ok, false, `expected ${String(bad)} to be rejected`);
      assert.deepStrictEqual(parsed.entries, []);
    }
  });

  test('drops values that are not JSON config values', () => {
    assert.strictEqual(isConfigValue(() => 1), false);
    assert.strictEqual(isConfigValue(undefined), false);
    assert.strictEqual(isConfigValue(Symbol('x')), false);
    assert.strictEqual(isConfigValue(NaN), false);
    assert.strictEqual(isConfigValue({ a: [1, 'b', true, null] }), true);

    const parsed = parseSaveConfigPayload({ 'chat.density': () => 1 });
    assert.strictEqual(parsed.entries.length, 0);
    assert.strictEqual(parsed.ignored.length, 1);

    // An unset field carries no value: skip it silently, never warn per save.
    const unset = parseSaveConfigPayload({ 'chat.density': undefined });
    assert.strictEqual(unset.entries.length, 0);
    assert.strictEqual(unset.ignored.length, 0);
  });

  test('accepts nested arrays and objects for structured settings', () => {
    const parsed = parseSaveConfigPayload({
      organizations: [{ name: 'org', url: 'https://dev.azure.com/org', project: 'p', pat: 'x' }],
      'llm.modeConfigs': { 'act/model': { provider: 'openai', apiModel: 'gpt' } },
      'git.protectedBranches': ['main', 'release'],
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.entries.length, 3);
    assert.strictEqual(parsed.ignored.length, 0);
  });

  test('the runtime validator agrees with the zod oracle on key allow-listing', () => {
    const corpus: unknown[] = [
      {},
      { organizations: [] },
      { 'chat.density': 'compact' },
      { 'llm.modeConfigs': { m: { provider: 'openai' } } },
      { 'git.protectedBranches': ['main'] },
      { 'not.a.real.setting': 1 },
      { 'chat.density': 'compact', 'bogus.key': true },
      { ADOcasing: 1 },
      42,
      null,
      [],
      'x',
      true,
    ];
    for (const payload of corpus) {
      const parsed = parseSaveConfigPayload(payload);
      assert.strictEqual(
        parsed.ok,
        isPlainObject(payload),
        `ok() mismatch for ${JSON.stringify(payload)}`,
      );
      const mine = parsed.ok && parsed.ignored.length === 0;
      assert.strictEqual(
        mine,
        oracleAcceptsEveryKey(payload),
        `key allow-listing mismatch for ${JSON.stringify(payload)}`,
      );
    }
  });
});

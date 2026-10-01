import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Stage 3 guard: the Configuration page must render settings through a
// data-driven renderer registry, not a `setting.type === …` dispatch chain, and
// the Advanced sidebar badge must DERIVE its count from the rows actually
// rendered rather than a hand-maintained `extraCount`.
//
// The webview project is excluded from the test tsconfig, so these modules are
// read as text — same approach as configCatalog.test.ts / configModules.test.ts.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CONFIG_DIR = path.join(REPO_ROOT, 'src/webview-ui/src/components/config');
const RENDERERS_SRC = path.join(CONFIG_DIR, 'renderers.tsx');
const CATALOG_SRC = path.join(REPO_ROOT, 'src/config/catalog.ts');
const PAGE_SRC = path.join(
  REPO_ROOT,
  'src/webview-ui/src/components/ConfigurationPage.tsx'
);

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

suite('Configuration setting render registry (Stage 3)', () => {
  test('a renderers module owns the per-type field widgets', () => {
    assert.ok(fs.existsSync(RENDERERS_SRC), `renderers module missing: ${RENDERERS_SRC}`);
    const src = read(RENDERERS_SRC);
    assert.match(
      src,
      /export const SETTING_RENDERERS\b/,
      'renderers.tsx must export SETTING_RENDERERS'
    );
    assert.match(
      src,
      /export function SettingField\b/,
      'renderers.tsx must export SettingField'
    );
  });

  test('the registry is exhaustive over every ConfigSetting type', () => {
    const catalog = read(CATALOG_SRC);
    const union = /type:\s*([^;]+);/.exec(catalog);
    assert.ok(union, 'catalog.ts must declare the ConfigSetting type union');
    const types = [...union[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.ok(types.length >= 10, `expected the full type union, found ${types.length}`);

    const src = read(RENDERERS_SRC);
    const registry = /export const SETTING_RENDERERS[^{]*\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(registry, 'SETTING_RENDERERS must be an object literal');
    const keys = new Set([...registry[1].matchAll(/([A-Za-z]+)\s*:/g)].map(m => m[1]));
    for (const t of types) {
      assert.ok(keys.has(t), `no renderer registered for ConfigSetting type '${t}'`);
    }
  });

  test('the page dispatches through SettingField, not a type chain', () => {
    const src = read(PAGE_SRC);
    assert.ok(
      src.includes('<SettingField'),
      'the page must render settings via <SettingField>'
    );
    assert.doesNotMatch(
      src,
      /setting\.type\s*===\s*'/,
      'the page must not contain a `setting.type === …` dispatch chain'
    );
  });

  test('the Advanced badge count is derived, not hand-asserted', () => {
    const catalog = read(CATALOG_SRC);
    const page = read(PAGE_SRC);
    assert.doesNotMatch(catalog, /extraCount/, 'catalog.ts must not carry a hand-counted extraCount');
    assert.doesNotMatch(page, /extraCount/, 'the page must not reference extraCount');
    assert.match(catalog, /export const MODE_ROWS\b/, 'catalog.ts must export MODE_ROWS');
    assert.match(catalog, /extraRows\s*:/, 'the Advanced category must declare extraRows');
    assert.match(page, /MODE_ROWS\.map\b/, 'the page must render the per-mode rows from MODE_ROWS');
    assert.match(page, /extraRows\b/, 'the page must derive the count from extraRows');
  });

  test('MODE_ROWS is the single list of per-mode rows', () => {
    const catalog = read(CATALOG_SRC);
    const block = /export const MODE_ROWS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(catalog);
    assert.ok(block, 'MODE_ROWS must be an array literal');
    const ids = [...block[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
    assert.strictEqual(ids.length, 4, `expected 4 mode rows, found ${ids.length}`);
    assert.strictEqual(new Set(ids).size, ids.length, 'mode row ids must be unique');
    for (const id of ids) {
      assert.ok(id.length > 0, 'mode row id must be non-empty');
    }
  });
});

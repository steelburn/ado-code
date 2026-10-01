import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Guardrail for the Configuration page catalog.
//
// The settings surface lives in THREE hand-maintained places:
//   1. package.json        contributes.configuration.properties  (source of truth)
//   2. src/config/settings.ts                                    (typed reader)
//   3. src/config/catalog.ts
//      CATEGORIES / ADVANCED_CATEGORY                            (the UI)
// Nothing enforced agreement between (1) and (3), so several releases added a
// contributed setting without ever surfacing it in the UI (e.g. 0.6.0
// skillRegistryUrls, 0.6.3 understanding.agentsMdSync, 0.6.8 chat.inputWhileBusy
// / chat.suggestDelegation). These tests fail the build whenever the catalog and
// package.json drift apart, so the next added setting cannot go missing.
//
// NOTE: src/webview-ui is excluded from the root tsconfig (it has its own), so
// this test reads the catalog SOURCE as text rather than importing the module.
// Stage 2 moved the catalog out of ConfigurationPage.tsx into its own pure-data
// module (see configModules.test.ts), so it now reads config/catalog.ts.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CATALOG_SRC = path.join(
  REPO_ROOT,
  'src/config/catalog.ts'
);
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

// Settings that intentionally have no plain catalog row because they are
// rendered by special-cased UI or written as part of another payload. Every
// entry needs a reason; adding one should be a deliberate act.
const SPECIAL_CASED_KEYS = new Set<string>([
  // Edited per-organization inside OrganizationsInput and saved with the
  // connection payload, not as a standalone catalogue row.
  'adoProject',
  // The Advanced-mode toggle in the sidebar itself.
  'advancedConfig',
  // Per-mode model rows rendered by ModeModelConfig (rows come from MODE_ROWS,
  // counted via ADVANCED_CATEGORY.extraRows).
  'llm.modeConfigs',
  // Per-mode reasoning-effort rows rendered by ModeModelConfig.
  'llm.modeReasoningEffort',
]);

/** Catalog rows are `{ key: '<id>', label: ...` — precise enough to skip
 *  unrelated `key:` usages elsewhere in the component. */
function catalogKeys(): string[] {
  const src = fs.readFileSync(CATALOG_SRC, 'utf8');
  return [...src.matchAll(/\{\s*key:\s*'([^']+)',\s*label:/g)].map(m => m[1]);
}

/** Category ids are the only `id: '...'` literals in the file. */
function categoryIds(): string[] {
  const src = fs.readFileSync(CATALOG_SRC, 'utf8');
  return [...src.matchAll(/^\s*id:\s*'([^']+)',/gm)].map(m => m[1]);
}

/** Every `adoCode.*` key contributed via package.json, prefix stripped. */
function contributedKeys(): string[] {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const props: Record<string, unknown> =
    pkg?.contributes?.configuration?.properties ?? {};
  const prefix = 'adoCode.';
  return Object.keys(props)
    .filter(k => k.startsWith(prefix))
    .map(k => k.slice(prefix.length));
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

suite('Configuration catalog integrity', () => {
  test('catalog source and package.json are both readable', () => {
    assert.ok(fs.existsSync(CATALOG_SRC), `catalog source not found: ${CATALOG_SRC}`);
    assert.ok(fs.existsSync(PACKAGE_JSON), `package.json not found: ${PACKAGE_JSON}`);
    assert.ok(catalogKeys().length > 0, 'no catalog settings parsed');
    assert.ok(contributedKeys().length > 0, 'no contributed settings parsed');
  });

  test('every contributed adoCode.* setting is surfaced in the Configuration UI (or explicitly special-cased)', () => {
    const catalog = new Set(catalogKeys());
    const missing = contributedKeys().filter(
      k => !catalog.has(k) && !SPECIAL_CASED_KEYS.has(k)
    );
    assert.deepStrictEqual(
      missing,
      [],
      'Contributed settings missing from the Configuration page catalog: ' +
        `${missing.join(', ')}. Add a ConfigSetting row, or add the key to ` +
        'SPECIAL_CASED_KEYS with a reason if it is rendered by special-cased UI.'
    );
  });

  test('every catalog key maps to a contributed package.json setting (no orphans)', () => {
    const contributed = new Set(contributedKeys());
    const orphans = catalogKeys().filter(k => !contributed.has(k));
    assert.deepStrictEqual(
      orphans,
      [],
      `Catalog entries with no matching package.json contribution: ${orphans.join(', ')}`
    );
  });

  test('category ids are unique', () => {
    const dupes = duplicates(categoryIds());
    assert.deepStrictEqual(dupes, [], `Duplicate category ids: ${dupes.join(', ')}`);
  });

  test('no setting key is listed twice in the catalog', () => {
    const dupes = duplicates(catalogKeys());
    assert.deepStrictEqual(dupes, [], `Duplicate catalog keys: ${dupes.join(', ')}`);
  });
});

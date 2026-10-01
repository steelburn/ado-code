import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Stage 2 guard: ConfigurationPage.tsx must be a shell-only page component.
//
// History: the page grew to ~1250 lines mixing five concerns — the settings
// catalog (types + CATEGORIES + ADVANCED_CATEGORY), the collection inputs
// (ArrayInput / McpServersInput / OrganizationsInput / CapabilityOverridesInput),
// the model widgets (ModelInput / ModelFetcher / ModelCapabilitiesLine /
// ModeModelConfig), the page shell (state, sidebar, save) and the type-dispatch
// render chain.
//
// Stage 2 splits it mechanically (no behavior change): catalog -> config/catalog.ts,
// field widgets -> config/inputs/*, model widgets -> config/model/*, and the page
// keeps only state + sidebar + save + render. These tests fail if a widget or the
// catalog creeps back into the page, or if an extracted module stops exporting
// what the page renders.
//
// (src/webview-ui is a separate TS project the host test build cannot import, so
// the checks read the sources as text — the same approach as configCatalog.test.ts.)
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CONFIG_DIR = path.join(REPO_ROOT, 'src/webview-ui/src/components/config');
const PAGE_SRC = path.join(
  REPO_ROOT,
  'src/webview-ui/src/components/ConfigurationPage.tsx'
);

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

const MODULES: Array<{ rel: string; exportName: string; label: string }> = [
  { rel: path.join(REPO_ROOT, 'src/config/catalog.ts'), exportName: 'CATEGORIES', label: 'settings catalog' },
  { rel: path.join(REPO_ROOT, 'src/config/catalog.ts'), exportName: 'ADVANCED_CATEGORY', label: 'advanced catalog' },
  { rel: 'inputs/ArrayInput.tsx', exportName: 'ArrayInput', label: 'array input' },
  { rel: 'inputs/McpServersInput.tsx', exportName: 'McpServersInput', label: 'mcp servers input' },
  { rel: 'inputs/OrganizationsInput.tsx', exportName: 'OrganizationsInput', label: 'organizations input' },
  { rel: 'inputs/CapabilityOverridesInput.tsx', exportName: 'CapabilityOverridesInput', label: 'capability overrides input' },
  { rel: 'model/ModelInput.tsx', exportName: 'ModelInput', label: 'model input' },
  { rel: 'model/ModelFetcher.tsx', exportName: 'ModelFetcher', label: 'model fetcher' },
  { rel: 'model/ModelCapabilitiesLine.tsx', exportName: 'ModelCapabilitiesLine', label: 'model capabilities line' },
  { rel: 'model/ModeModelConfig.tsx', exportName: 'ModeModelConfig', label: 'mode model config' },
  { rel: 'renderers.tsx', exportName: 'SETTING_RENDERERS', label: 'setting renderer registry' },
  { rel: 'renderers.tsx', exportName: 'SettingField', label: 'setting field dispatcher' },
];

// Declarations that must now live OUTSIDE the page component.
const EXTRACTED_DECLS = [
  'function ArrayInput(',
  'function McpServersInput(',
  'function OrganizationsInput(',
  'function CapabilityOverridesInput(',
  'function ModelInput(',
  'function ModelFetcher(',
  'function ModelCapabilitiesLine(',
  'function ModeModelConfig(',
  'const CATEGORIES',
  'const ADVANCED_CATEGORY',
];

// Stage 3: the page renders settings through the registry, and still composes
// the LLM-provider widgets and the per-mode rows itself.
const RENDERED_BY_PAGE = [
  '<SettingField',
  '<ModelFetcher',
  '<ModelCapabilitiesLine',
  '<ModeModelConfig',
];

// The per-type field widgets are now rendered by the registry, not the page.
const RENDERED_BY_RENDERERS = [
  '<ArrayInput',
  '<McpServersInput',
  '<OrganizationsInput',
  '<CapabilityOverridesInput',
  '<ModelInput',
];

suite('Configuration page — Stage 2 module split', () => {
  test('every extracted module exists and exports what the page renders', () => {
    for (const m of MODULES) {
      const p = path.isAbsolute(m.rel) ? m.rel : path.join(CONFIG_DIR, m.rel);
      assert.ok(fs.existsSync(p), `${m.label} module missing: ${p}`);
      const src = read(p);
      assert.match(
        src,
        new RegExp(`export (function|const) ${m.exportName}\\b`),
        `${m.rel} must export ${m.exportName}`
      );
    }
  });

  test('the page component is shell-only (owns neither the catalog nor any field widget)', () => {
    const page = read(PAGE_SRC);
    for (const decl of EXTRACTED_DECLS) {
      assert.ok(
        !page.includes(decl),
        `ConfigurationPage.tsx must not declare "${decl}" — it moved to the config/ modules`
      );
    }
    // ...and must not carry catalog rows either.
    assert.doesNotMatch(
      page,
      /\{\s*key:\s*'[^']+',\s*label:/,
      'ConfigurationPage.tsx must not contain catalog setting rows'
    );
  });

  test('the page still renders the widgets it composes (no wiring lost)', () => {
    const page = read(PAGE_SRC);
    for (const tag of RENDERED_BY_PAGE) {
      assert.ok(
        page.includes(tag),
        `ConfigurationPage.tsx must still render ${tag}`
      );
    }
  });

  test('the registry renders the per-type field widgets', () => {
    const src = read(path.join(CONFIG_DIR, 'renderers.tsx'));
    for (const tag of RENDERED_BY_RENDERERS) {
      assert.ok(
        src.includes(tag),
        `renderers.tsx must render ${tag} (moved out of the page in Stage 3)`
      );
    }
  });

  test('the catalog module is pure data (no React / vscode / page imports)', () => {
    const src = read(path.join(REPO_ROOT, 'src/config/catalog.ts'));
    assert.doesNotMatch(src, /from 'react'/, 'catalog.ts must not import React');
    assert.doesNotMatch(src, /from '\.\.\/vscode'/, 'catalog.ts must not import the vscode bridge');
    assert.doesNotMatch(src, /from '\.\.?\/(\.\.\/)*components/, 'catalog.ts must not import the page');
  });

  test('the settings catalog has exactly one home', () => {
    const page = read(PAGE_SRC);
    assert.doesNotMatch(
      page,
      /const CATEGORIES|const ADVANCED_CATEGORY/,
      'the catalog must live only in config/catalog.ts'
    );
    const catalog = read(path.join(REPO_ROOT, 'src/config/catalog.ts'));
    assert.ok(
      catalog.includes("key: 'connection.org'") || /\{\s*key:\s*'[^']+',\s*label:/.test(catalog),
      'config/catalog.ts must contain the setting rows'
    );
  });
});

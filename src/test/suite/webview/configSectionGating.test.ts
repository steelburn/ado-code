import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Guardrail for the Configuration page's special-cased sections (R1).
//
// The page used to decide whether to render the Fetch-Models control and the
// capability readout by comparing `section.title` to a literal string:
//
//     {section.title === 'LLM Provider' && <ModelFetcher …/>}
//
// Renaming a DISPLAY title then silently dropped the control — a stringly-typed
// coupling with no type error and no test failure. The two `ModelFetcher` blocks
// were also byte-identical duplicates. Sections now declare the intent with
// explicit flags (`showModelFetcher` / `showModelCapabilities`).
//
// The catalog now lives in src/config and is importable as data (see
// configCanonicalKeys.test.ts). This guard stays structural on purpose: it pins
// the SOURCE SHAPE of the page's gating, not the catalog's contents.

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', rel), 'utf8');
}

const PAGE = 'src/webview-ui/src/components/ConfigurationPage.tsx';
const CATALOG = 'src/config/catalog.ts';
const HOST = 'src/webview/ChatViewProvider.ts';

suite('Configuration section gating (R1/R3)', () => {
  test('the page does not gate rendering on section.title strings', () => {
    const src = read(PAGE);
    assert.ok(
      !/section\.title\s*===/.test(src),
      'the page must not branch on section.title; use declarative section flags',
    );
  });

  test('the page never mentions the special section titles', () => {
    const src = read(PAGE);
    assert.ok(!/'LLM Provider'/.test(src), "the page must not hard-code the 'LLM Provider' title");
    assert.ok(!/'Model & Counting'/.test(src), "the page must not hard-code the 'Model & Counting' title");
  });

  test('the page renders the model widgets from declarative section flags', () => {
    const src = read(PAGE);
    assert.ok(/section\.showModelFetcher\s*&&/.test(src), 'expected a section.showModelFetcher gate');
    assert.ok(/section\.showModelCapabilities\s*&&/.test(src), 'expected a section.showModelCapabilities gate');
  });

  test('the Fetch-Models control is rendered exactly once (no duplicated block)', () => {
    const src = read(PAGE);
    const n = (src.match(/<ModelFetcher\b/g) || []).length;
    assert.strictEqual(n, 1, `expected a single <ModelFetcher>, found ${n}`);
  });

  test('the catalog declares the flags (fetch control ×2, capability readout ×1)', () => {
    const src = read(CATALOG);
    const fetchers = (src.match(/showModelFetcher:\s*true/g) || []).length;
    const caps = (src.match(/showModelCapabilities:\s*true/g) || []).length;
    assert.strictEqual(fetchers, 2, `expected showModelFetcher on 2 sections, found ${fetchers}`);
    assert.strictEqual(caps, 1, `expected showModelCapabilities on 1 section, found ${caps}`);
  });

  test('the stale "mirror module" comment is gone from the host', () => {
    const src = read(HOST);
    assert.ok(
      !/mirror module/i.test(src),
      'the "mirror module" comment is stale — the webview imports the shared heuristic (Stage 1)',
    );
  });
});

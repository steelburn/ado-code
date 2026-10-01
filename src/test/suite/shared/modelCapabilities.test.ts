import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as host from '../../../llm/modelCapabilities';
import * as shared from '../../../shared/modelCapabilities';

// Stage 1 dedup guard: the model-capability heuristic must have exactly ONE
// source of truth.
//
// History: src/llm/modelCapabilities.ts (host) and ConfigurationPage.tsx
// (webview) each carried their own copy of the vision/tool patterns and the
// inference function, kept in sync by a "Keep the patterns in sync" comment.
// Nothing enforced agreement, so the webview copy could silently drift from
// the host's unit-tested implementation.
//
// Stage 1 hoists the pure, vscode-free module to src/shared/modelCapabilities.ts
// and has BOTH sides import it. The host file becomes a thin re-export barrel.
// The guards below fail if either copy is reintroduced.
//
// (The webview is a separate TS project that the host test build cannot import,
// so its side of the invariant is checked by reading the source text — the same
// approach used by configCatalog.test.ts for the settings catalog. Stage 2 moved
// the widget that consumes the heuristic from ConfigurationPage.tsx into
// config/model/ModelCapabilitiesLine.tsx.)
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SHARED_MODULE = path.join(REPO_ROOT, 'src/shared/modelCapabilities.ts');
const HOST_MODULE = path.join(REPO_ROOT, 'src/llm/modelCapabilities.ts');
// Stage 2 moved the model widgets out of ConfigurationPage.tsx; the widget that
// renders the capability hint now lives in its own module.
const WEBVIEW_MODULE = path.join(
  REPO_ROOT,
  'src/webview-ui/src/components/config/model/ModelCapabilitiesLine.tsx'
);

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

suite('Model capability heuristic — single source', () => {
  test('the shared module exists and owns the heuristic', () => {
    assert.ok(
      fs.existsSync(SHARED_MODULE),
      `expected the heuristic to live at ${SHARED_MODULE}`
    );
    const src = read(SHARED_MODULE);
    assert.match(
      src,
      /export function getModelCapabilities/,
      'shared module must export getModelCapabilities'
    );
  });

  test('the host module is a thin re-export (no second copy)', () => {
    const src = read(HOST_MODULE);
    assert.match(
      src,
      /export \* from '\.\.\/shared\/modelCapabilities'/,
      'host module must re-export the shared implementation'
    );
    assert.doesNotMatch(
      src,
      /const VISION_PATTERN/,
      'host module must not keep its own VISION_PATTERN table'
    );
    assert.doesNotMatch(
      src,
      /function getModelCapabilities/,
      'host module must not keep its own getModelCapabilities implementation'
    );
  });

  test('the configuration webview consumes the shared heuristic instead of duplicating it', () => {
    const src = read(WEBVIEW_MODULE);
    assert.match(
      src,
      /from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/modelCapabilities'/,
      'webview must import the heuristic from src/shared/modelCapabilities'
    );
    assert.doesNotMatch(
      src,
      /function inferModelCapabilities/,
      'webview must not re-implement the heuristic'
    );
    assert.doesNotMatch(
      src,
      /const VISION_PATTERN|const NO_TOOLS/,
      'webview must not keep its own capability pattern tables'
    );
  });
});

suite('Model capability heuristic — shared implementation', () => {
  test('the host barrel exposes the very same function object as the shared module', () => {
    // Identity, not just equality of behaviour: proves there is exactly one
    // implementation and the host barrel is not a re-declaration.
    assert.strictEqual(
      host.getModelCapabilities,
      shared.getModelCapabilities,
      'host getModelCapabilities must BE the shared function'
    );
    assert.strictEqual(
      host.capabilitiesFromGateway,
      shared.capabilitiesFromGateway,
      'host capabilitiesFromGateway must BE the shared function'
    );
  });

  test('empty / unknown model ids default to { vision: false, tools: true }', () => {
    assert.deepStrictEqual(shared.getModelCapabilities(''), {
      vision: false,
      tools: true,
    });
  });

  test('override precedence beats live hints and the name heuristic', () => {
    const caps = shared.getModelCapabilities(
      'gpt-4o',
      { vision: true, tools: true },
      [{ model: 'gpt-4o', tools: false }]
    );
    assert.strictEqual(caps.tools, false, 'explicit override wins');
    assert.strictEqual(caps.vision, true, 'partial override leaves vision to live hint');
  });
});

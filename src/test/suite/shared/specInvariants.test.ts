/**
 * Spec enforcement — the AGENTS.md rules that nothing else checks.
 *
 * AGENTS.md is advice until a test fails on it. The three rules below are the
 * ones a well-meaning change breaks *silently*, with no other test going red:
 *
 *   1. Zero runtime dependencies. Every devDependency is bundled by esbuild and
 *      never installed by the user, so the .vsix loads on a locked-down machine.
 *      A `dependencies` entry ships node_modules inside the package instead and
 *      the extension stops loading offline. Nothing else notices: the local build
 *      still works, because the modules happen to be in node_modules.
 *
 *   2. One system-prompt builder. generateSystemPrompt() is the only injection
 *      point. A second call site (or a hand-rolled second builder) keeps working
 *      and keeps looking right, while losing the cache-aware section ordering and
 *      escaping the static-prompt size budget that 01-prompt-engineering.md
 *      measures — the two properties the prompt layer is actually graded on.
 *
 *   3. Azure DevOps API versions stay on GA, plus the one documented comments
 *      preview. A preview version bumped to reach a new field looks like a local
 *      change but obliges every other call the same client makes, and previews are
 *      retired without notice.
 *
 * These read source text rather than importing it: the rules are about what the
 * repository contains, not about runtime behaviour.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, '.vscodeignore'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`could not locate the repository root from ${__dirname}`);
}

/**
 * Trees that are deliberately outside the rules.
 * - src/test: fixtures contain URLs and imports the extension itself must not have.
 * - src/webview-ui: a separate npm project compiled into its own bundle; it is the
 *   one manifest allowed to declare dependencies, and the host never loads it.
 */
const SCANNED_OUT = ['src/test', 'src/webview-ui'];

/** Every non-test, non-webview .ts file under src/, as repo-relative POSIX paths. */
function sourceFiles(): string[] {
  const root = findRepoRoot();
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!SCANNED_OUT.some((skip) => rel === skip || rel.startsWith(`${skip}/`))) {
          walk(full);
        }
      } else if (entry.name.endsWith('.ts')) {
        out.push(rel);
      }
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(findRepoRoot(), rel), 'utf8');
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readSource('package.json')) as Record<string, unknown>;
}

suite('Spec — zero runtime dependencies', () => {
  const dependencyKeys = ['dependencies', 'optionalDependencies', 'peerDependencies'];

  test('package.json declares no runtime dependencies', () => {
    const manifest = readManifest();
    const declared: string[] = [];
    for (const key of dependencyKeys) {
      declared.push(...Object.keys((manifest[key] as Record<string, unknown> | undefined) ?? {}).map((name) => `${key}.${name}`));
    }
    assert.deepStrictEqual(
      declared,
      [],
      `every runtime dependency ships node_modules inside the .vsix and breaks offline installs: move ${declared.join(', ')} to devDependencies (esbuild bundles those)`
    );
  });

  test('the manifest that governs bundling is the one being read', () => {
    // Guards the rule above against passing because we opened the wrong file:
    // devDependencies is where all 15 build-time packages live, and it is never empty.
    const devDependencies = (readManifest().devDependencies ?? {}) as Record<string, unknown>;
    assert.ok(
      Object.keys(devDependencies).length > 0,
      'devDependencies must be non-empty — otherwise this suite is reading the wrong package.json'
    );
  });
});

suite('Spec — one system-prompt injection point', () => {
  const BUILDER = 'src/llm/prompts/system.ts';
  const ONLY_CALLER = 'src/webview/ChatViewProvider.ts';

  test('only ChatViewProvider imports the prompt builder', () => {
    const importPattern = /(?:from\s+|require\(\s*)['"][^'"]*prompts\/system['"]/;
    const importers = sourceFiles().filter((rel) => rel !== BUILDER && importPattern.test(readSource(rel)));
    assert.deepStrictEqual(
      importers,
      [ONLY_CALLER],
      'a second importer of generateSystemPrompt() bypasses the single injection point — per-turn sections belong in the options object, not a parallel builder'
    );
  });

  test('generateSystemPrompt is called from exactly one place', () => {
    const callSites = sourceFiles()
      .filter((rel) => rel !== BUILDER)
      .map((rel) => ({ rel, calls: (readSource(rel).match(/generateSystemPrompt\s*\(/g) ?? []).length }))
      .filter((site) => site.calls > 0);
    assert.deepStrictEqual(
      callSites,
      [{ rel: ONLY_CALLER, calls: 1 }],
      'one call site per turn keeps static sections first and per-turn sections last, which is what makes provider prefix caching hit'
    );
  });

  test('the builder module exports exactly one builder', () => {
    const source = readSource(BUILDER);
    assert.strictEqual(
      (source.match(/export function generateSystemPrompt\b/g) ?? []).length,
      1,
      'prompts/system.ts must expose generateSystemPrompt() once — a variant export splits the size budget across two paths'
    );
  });
});

suite('Spec — Azure DevOps API versions', () => {
  /** AGENTS.md: 7.1 (GA) everywhere, 7.1-preview.4 for comments. Nothing else. */
  const ALLOWED = ['7.1', '7.1-preview.4'];
  const COMMENTS_CLIENT = 'src/ado/client.ts';

  test('every api-version in the extension is GA or the documented comments preview', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const rel of sourceFiles()) {
      const matches = readSource(rel).matchAll(/api-version=([0-9A-Za-z._-]+)/g);
      for (const match of matches) {
        seen.add(match[1]);
        if (!ALLOWED.includes(match[1])) {
          offenders.push(`${rel}: ${match[1]}`);
        }
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `undocumented API version(s) — previews are retired without notice; document a new one in AGENTS.md and 09-boundaries-sandboxing-spec-driven.md before adding it here:\n${offenders.join('\n')}`
    );
    assert.ok(seen.size > 0, 'the api-version scan found nothing — the rule is vacuous, check the scanner');
    assert.ok(seen.has('7.1'), 'the GA version must still be in use');
  });

  test('a preview version is confined to the client that needs it', () => {
    const previewUsers = sourceFiles().filter((rel) => /api-version=7\.1-preview/.test(readSource(rel)));
    assert.deepStrictEqual(
      previewUsers,
      [COMMENTS_CLIENT],
      'preview versions leak their obligations to every call in the same module — keep them in the one client that documents why they are needed'
    );
  });

  test('the allowlist matches AGENTS.md', () => {
    const agents = readSource('AGENTS.md');
    for (const version of ALLOWED) {
      assert.ok(
        agents.includes(version),
        `AGENTS.md no longer documents api-version ${version} — the spec and this test disagree, and the test is the one that is wrong`
      );
    }
  });
});

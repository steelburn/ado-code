import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildAgentsMdContent } from '../../../webview/agentsMd';

const roots: string[] = [];

/**
 * Create a throwaway workspace: package.json (name "fixture", description
 * "Fixture project", optional scripts) plus optional extra files.
 */
function makeRoot(opts: { scripts?: Record<string, string>; files?: Record<string, string> } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-agentsmd-'));
  roots.push(root);
  const pkg: Record<string, unknown> = { name: 'fixture', description: 'Fixture project', version: '1.0.0' };
  if (opts.scripts) pkg.scripts = opts.scripts;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg), 'utf8');
  for (const [rel, fileContent] of Object.entries(opts.files ?? {})) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fileContent, 'utf8');
  }
  return root;
}

suiteTeardown(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

suite('agentsMd', () => {
  test('emits only scripts that exist — never a hardcoded npm run build', () => {
    const root = makeRoot({ scripts: { compile: 'tsc -p ./', test: 'mocha' } });
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('- `npm run compile`'), 'compile script emitted');
    assert.ok(md.includes('- `npm test`'), 'test script emitted');
    assert.ok(!md.includes('npm run build'), 'no build script — no npm run build line');
  });

  test('prefers build, then build:all, then build:webview', () => {
    const withBuild = makeRoot({ scripts: { build: 'tsc', 'build:all': 'tsc && webpack' } });
    assert.ok(buildAgentsMdContent(withBuild).includes('- `npm run build`'));

    const onlyAll = makeRoot({ scripts: { 'build:all': 'tsc && webpack' } });
    const mdAll = buildAgentsMdContent(onlyAll);
    assert.ok(mdAll.includes('- `npm run build:all`'), 'build:all emitted');
    assert.ok(!mdAll.includes('- `npm run build`'), 'plain build NOT emitted when missing');

    const onlyWebview = makeRoot({ scripts: { 'build:webview': 'webpack' } });
    const mdWv = buildAgentsMdContent(onlyWebview);
    assert.ok(mdWv.includes('- `npm run build:webview`'), 'build:webview emitted');
    assert.ok(!mdWv.includes('- `npm run build`'), 'plain build NOT emitted when missing');
  });

  test('tsconfig without a compile script falls back to npx tsc --noEmit', () => {
    const root = makeRoot({ files: { 'tsconfig.json': '{}' } });
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('- `npx tsc --noEmit`'), 'tsc fallback emitted');
    assert.ok(!md.includes('npm run compile'), 'compile NOT emitted when script missing');
  });

  test('detects ESLint 9 flat config without a lint script', () => {
    const root = makeRoot({ files: { 'eslint.config.js': '' } });
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('- `npx eslint .`'), 'flat config → npx eslint .');
  });

  test('detects legacy .eslintrc.json without a lint script', () => {
    const root = makeRoot({ files: { '.eslintrc.json': '{}' } });
    assert.ok(buildAgentsMdContent(root).includes('- `npx eslint .`'));
  });

  test('a lint script wins over an eslint config', () => {
    const root = makeRoot({ scripts: { lint: 'eslint src --ext ts' }, files: { 'eslint.config.js': '' } });
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('- `npm run lint`'), 'lint script emitted');
    assert.ok(!md.includes('npx eslint'), 'no npx fallback when script exists');
  });

  test('names the detected test runner when there is no test script', () => {
    const jestRoot = makeRoot({ files: { 'jest.config.js': '' } });
    assert.ok(buildAgentsMdContent(jestRoot).includes('- `npx jest`'));

    const vitestRoot = makeRoot({ files: { 'vitest.config.ts': '' } });
    assert.ok(buildAgentsMdContent(vitestRoot).includes('- `npx vitest run`'));

    const mochaRoot = makeRoot({ files: { '.mocharc.json': '{}' } });
    assert.ok(buildAgentsMdContent(mochaRoot).includes('- `npx mocha`'));
  });

  test('a test script wins over runner detection', () => {
    const root = makeRoot({ scripts: { test: 'node test/run.js' }, files: { 'jest.config.js': '' } });
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('- `npm test`'));
    assert.ok(!md.includes('npx jest'));
  });

  test('test dir without a script gets a generic note, not a broken command', () => {
    const root = makeRoot({ files: { 'src/test/foo.test.ts': '' } });
    const md = buildAgentsMdContent(root);
    assert.ok(!md.includes('npm test'), 'npm test NOT emitted without a test script');
    assert.ok(md.includes('Tests exist'), 'notes that tests exist');
  });

  test('honest fallback when nothing recognizable exists', () => {
    const root = makeRoot();
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('See `package.json`'), 'fallback line emitted');
    assert.ok(!md.includes('npm run'), 'no npm command invented');
  });

  test('uses package.json name and description', () => {
    const root = makeRoot();
    const md = buildAgentsMdContent(root);
    assert.ok(md.startsWith('# AGENTS.md — fixture'), 'name from package.json');
    assert.ok(md.includes('Fixture project'), 'description from package.json');
  });

  test('lists top-level directories but skips dot dirs and node_modules', () => {
    const root = makeRoot({ files: { 'src/a.ts': '', 'lib/b.ts': '', 'node_modules/x/index.js': '', '.git/config': '' } });
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('- `src/`'), 'src listed');
    assert.ok(md.includes('- `lib/`'), 'lib listed');
    assert.ok(!md.includes('node_modules'), 'node_modules excluded');
    assert.ok(!md.includes('.git'), '.git excluded');
  });
});

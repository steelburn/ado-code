import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildAgentsMdContent, computeManagedBlock, extractManagedBlock, replaceManagedBlock, evaluateAgentsMdSync, hashBlock, MANAGED_START, MANAGED_END } from '../../../webview/agentsMd';

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

  test('wraps the derived sections in managed markers', () => {
    const root = makeRoot({ scripts: { compile: 'tsc', test: 'mocha' } });
    const md = buildAgentsMdContent(root);
    assert.ok(md.startsWith('# AGENTS.md — fixture'), 'title still leads the file');
    assert.ok(md.includes(MANAGED_START), 'managed start marker present');
    assert.ok(md.includes(MANAGED_END), 'managed end marker present');
    const start = md.indexOf(MANAGED_START);
    const end = md.indexOf(MANAGED_END);
    assert.ok(start < end, 'markers ordered');
    const between = md.slice(start + MANAGED_START.length, end);
    assert.ok(between.includes('## What This Is'), 'What This Is managed');
    assert.ok(between.includes('## Build & Test'), 'Build & Test managed');
    // User-owned sections live OUTSIDE the managed block so in-place syncs
    // never clobber them.
    const after = md.slice(end + MANAGED_END.length);
    assert.ok(after.includes('## Conventions'), 'Conventions preserved outside the block');
    assert.ok(after.includes('## What NOT to Do'), 'What NOT to Do preserved outside the block');
  });

  test('extractManagedBlock round-trips computeManagedBlock for a generated file', () => {
    const root = makeRoot({ scripts: { test: 'mocha', lint: 'eslint' } });
    const md = buildAgentsMdContent(root);
    const extracted = extractManagedBlock(md);
    assert.ok(extracted, 'managed block extracted');
    assert.strictEqual(extracted, computeManagedBlock(root), 'extracted block matches a fresh computation');
    assert.strictEqual(extractManagedBlock('# no markers here'), null, 'null for unmanaged files');
  });

  test('replaceManagedBlock swaps only the managed region', () => {
    const root = makeRoot();
    const md = buildAgentsMdContent(root);
    const upgraded = md + '\n\n## My Notes\nHand-written detail.';
    const replaced = replaceManagedBlock(upgraded, '# REPLACED\nBODY');
    assert.ok(replaced.includes('## My Notes\nHand-written detail.'), 'user content after markers preserved');
    assert.ok(replaced.includes('# REPLACED\nBODY'), 'new block written');
    assert.ok(!replaced.includes('Fixture project'), 'old managed body gone');
    const withMarkers = replaceManagedBlock(md, extractManagedBlock(md) ?? '');
    assert.strictEqual(withMarkers, md, 'replacing with identical block is a no-op');
    assert.strictEqual(replaceManagedBlock('no markers', 'x'), 'no markers', 'no-op without markers');
  });

  test('summary enriches directory bullets and adds the understanding section', () => {
    const root = makeRoot({ files: { 'src/a.ts': '', 'lib/b.ts': '' } });
    const summary = '## Architecture\n- `src/` — extension host code and services\n- `lib/`: shared pure utilities\nThe rest is webview UI.';
    const plain = buildAgentsMdContent(root);
    const enriched = buildAgentsMdContent(root, { summary });
    assert.ok(!plain.includes('## Repository Understanding'), 'no understanding section without a summary');
    assert.ok(enriched.includes('- `src/` — extension host code and services'), 'src described from summary');
    assert.ok(enriched.includes('- `lib/` — shared pure utilities'), 'lib described from summary');
    assert.ok(enriched.includes('## Repository Understanding'), 'understanding section added');
    assert.ok(enriched.includes('.ado-code/understanding'), 'section credits the cache');
    assert.ok(enriched.includes('extension host code and services'), 'summary text embedded');
    // computeManagedBlock agrees so drift checks compare like-for-like.
    assert.strictEqual(extractManagedBlock(enriched), computeManagedBlock(root, { summary }));
  });

  test('prose that merely mentions a directory never becomes a description', () => {
    const root = makeRoot({ files: { 'src/a.ts': '', 'lib/b.ts': '' } });
    const summary = 'The src/ directory holds the main process while lib/ has no clear role yet.';
    const md = buildAgentsMdContent(root, { summary });
    assert.ok(md.includes('- `src/` — project directory'), 'no invented description for prose mention');
    assert.ok(md.includes('- `lib/` — project directory'), 'no invented description for lib/');
  });

  test('honest fallback without any package.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-agentsmd-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    const md = buildAgentsMdContent(root);
    assert.ok(md.includes('README or project tooling'), 'generic tooling note, not an invented npm command');
    assert.ok(!md.includes('npm run'), 'no npm command invented without package.json');
  });
});

suite('evaluateAgentsMdSync', () => {
  test('missing file → offer to generate a managed starter', () => {
    const root = makeRoot();
    const d = evaluateAgentsMdSync(root, {});
    assert.strictEqual(d.kind, 'missing');
    assert.ok(d.candidate.includes(MANAGED_START), 'candidate carries the managed markers');
    assert.ok(d.candidate.startsWith('# AGENTS.md — fixture'));
    assert.ok(d.blockSig && d.factsSig, 'signatures computed');
  });

  test('declined starter offer is remembered — no re-ask for the same state', () => {
    const root = makeRoot();
    const d = evaluateAgentsMdSync(root, {});
    assert.strictEqual(d.kind, 'missing');
    const again = evaluateAgentsMdSync(root, {}, { blockSig: d.blockSig, factsSig: d.factsSig, declines: 1 });
    assert.strictEqual(again.kind, 'none', 'same state after a decline stays silent');
    // …but a changed project re-offers.
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture', description: 'Fixture project', version: '1.0.0', scripts: { test: 'mocha' },
    }), 'utf8');
    const changed = evaluateAgentsMdSync(root, {}, { blockSig: d.blockSig, factsSig: d.factsSig, declines: 1 });
    assert.strictEqual(changed.kind, 'missing', 'project gained a test script → ask again');
  });

  test('freshly generated file → none', () => {
    const root = makeRoot();
    const d = evaluateAgentsMdSync(root, {});
    fs.writeFileSync(path.join(root, 'AGENTS.md'), d.candidate, 'utf8');
    const again = evaluateAgentsMdSync(root, {});
    assert.strictEqual(again.kind, 'none', 'managed + matching block is current');
  });

  test('script change after generation → update with a reason', () => {
    const root = makeRoot({ scripts: { compile: 'tsc' } });
    const d = evaluateAgentsMdSync(root, {});
    fs.writeFileSync(path.join(root, 'AGENTS.md'), d.candidate, 'utf8');
    // The project gains a test runner — AGENTS.md no longer reflects it.
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.scripts = { compile: 'tsc', test: 'mocha' };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');
    const d2 = evaluateAgentsMdSync(root, {});
    assert.strictEqual(d2.kind, 'update', 'drift detected');
    assert.ok(d2.reasons.some((r) => /build|test|lint/i.test(r)), `reason names the change: ${d2.reasons.join(' | ')}`);
    assert.notStrictEqual(d2.candidate, extractManagedBlock(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')), 'candidate differs from the on-disk block');
  });

  test('structure change after generation → update mentioning added/removed dirs', () => {
    const root = makeRoot({ files: { 'src/a.ts': '' } });
    const d = evaluateAgentsMdSync(root, {});
    fs.writeFileSync(path.join(root, 'AGENTS.md'), d.candidate, 'utf8');
    fs.mkdirSync(path.join(root, 'webview'));
    const d2 = evaluateAgentsMdSync(root, {});
    assert.strictEqual(d2.kind, 'update');
    assert.ok(d2.reasons.some((r) => r.includes('added webview')), `reasons mention the new dir: ${d2.reasons.join(' | ')}`);
  });

  test('user edits outside the markers do not count as drift', () => {
    const root = makeRoot();
    const d = evaluateAgentsMdSync(root, {});
    const md = d.candidate + '\n\n## Conventions (mine)\n- My own rules.';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), md, 'utf8');
    const d2 = evaluateAgentsMdSync(root, {});
    assert.strictEqual(d2.kind, 'none', 'extra hand-written sections are preserved, not flagged');
  });

  test('unmanaged file without understanding → none', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# AGENTS.md — fixture\n## Build\n- npm run build\n', 'utf8');
    const d = evaluateAgentsMdSync(root, {});
    assert.strictEqual(d.kind, 'none', 'no reason to rewrite a hand-authored file without a summary');
  });

  test('unmanaged file with a cached summary → adopt', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# AGENTS.md — fixture\nMy hand-written file.\n', 'utf8');
    const d = evaluateAgentsMdSync(root, { summary: '## Architecture\n- `src/` — host code' });
    assert.strictEqual(d.kind, 'adopt', 'offers to fold the LLM summary in');
    assert.ok(d.candidate.includes('## Repository Understanding'), 'candidate embeds the summary');
    assert.ok(d.reasons.some((r) => r.includes('rewrites the file')), 'hand-authored file → wholesale rewrite (with Preview)');
  });

  test('legacy generated file (pre-marker era) → adopt upgrades in place, preserving user sections', () => {
    const root = makeRoot({ scripts: { compile: 'tsc' } });
    // Simulate the old generator output, with a user edit under Conventions.
    const legacy = [
      '# AGENTS.md — fixture',
      '',
      '## What This Is',
      'Fixture project',
      '',
      '## Build & Test',
      '- `npm run compile` — TypeScript compilation',
      '- `npm run build` — Production build (stale: the build script was removed)',
      '',
      '## Conventions',
      '- My team convention.',
      '',
      '## What NOT to Do',
      '- Do not add unnecessary dependencies',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), legacy, 'utf8');
    const d = evaluateAgentsMdSync(root, { summary: '## Architecture\n- `src/` — host code' });
    assert.strictEqual(d.kind, 'adopt');
    assert.ok(d.reasons.some((r) => r.includes('older version')), 'reasons explain the legacy upgrade');
    assert.ok(d.candidate.includes(MANAGED_START), 'markers added');
    assert.ok(d.candidate.includes('- My team convention.'), 'Conventions edits preserved');
    assert.ok(d.candidate.startsWith('# AGENTS.md — fixture'), 'title preserved');
    assert.ok(!d.candidate.includes('npm run build'), 'stale derived body replaced');
    // Round-trips through the sync machinery cleanly.
    assert.strictEqual(extractManagedBlock(d.candidate), computeManagedBlock(root, { summary: '## Architecture\n- `src/` — host code' }));
  });

  test('same candidate already declined → none, even when drifted', () => {
    const root = makeRoot({ scripts: { compile: 'tsc' } });
    const d = evaluateAgentsMdSync(root, {});
    fs.writeFileSync(path.join(root, 'AGENTS.md'), d.candidate, 'utf8');
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.scripts = { compile: 'tsc', test: 'mocha' };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');
    const drifted = evaluateAgentsMdSync(root, {});
    assert.strictEqual(drifted.kind, 'update', 'control: drift exists');
    const silenced = evaluateAgentsMdSync(root, {}, { blockSig: drifted.blockSig, factsSig: drifted.factsSig, declines: 1 });
    assert.strictEqual(silenced.kind, 'none', 'exact candidate already declined → no re-offer');
  });

  test('regenerated summary alone stops nagging after repeated declines', () => {
    const root = makeRoot({ files: { 'src/a.ts': '' } });
    const first = evaluateAgentsMdSync(root, {});
    fs.writeFileSync(path.join(root, 'AGENTS.md'), first.candidate, 'utf8');
    // Understanding refreshes, producing new summary wording — same repo facts.
    const drifted = evaluateAgentsMdSync(root, { summary: '## Architecture\n- `src/` — host code' });
    assert.strictEqual(drifted.kind, 'update', 'control: summary drift offered once');
    const again = evaluateAgentsMdSync(
      root,
      { summary: '## Architecture\n- `src/` — host code (revised wording)' },
      { blockSig: drifted.factsSig, factsSig: drifted.factsSig, declines: 2 }
    );
    assert.strictEqual(again.kind, 'none', '2 declines for the same facts silence summary rewording');
    // …but a real structural change re-offers regardless of past declines.
    fs.mkdirSync(path.join(root, 'webview'));
    const structural = evaluateAgentsMdSync(
      root,
      { summary: '## Architecture\n- `src/` — host code' },
      { blockSig: drifted.factsSig, factsSig: drifted.factsSig, declines: 9 }
    );
    assert.strictEqual(structural.kind, 'update', 'facts changed → offer again');
  });

  test('hashBlock is stable and distinct across content', () => {
    const a = hashBlock('same text');
    assert.strictEqual(a, hashBlock('same text'), 'deterministic');
    assert.notStrictEqual(a, hashBlock('different text'));
  });
});

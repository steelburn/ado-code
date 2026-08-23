import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UnderstandingService, UnderstandingGit } from '../../../services/understanding/UnderstandingService';

function fakeGit(overrides: Partial<UnderstandingGit> = {}): UnderstandingGit {
  return {
    getCurrentBranch: async () => 'main',
    getShortCommitHash: async () => 'abc1234',
    getRemoteOriginUrl: async () => 'https://dev.azure.com/org/repo',
    ...overrides,
  };
}

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

suite('UnderstandingService', () => {
  let tmpDir: string;
  let service: UnderstandingService;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-understanding-'));
    write(tmpDir, 'AGENTS.md', '# Project\nBuild with npm run build.\n');
    write(tmpDir, 'package.json', JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      scripts: { build: 'tsc', test: 'mocha' },
    }));
    service = new UnderstandingService(tmpDir, fakeGit());
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getDir points at .ado-code/understanding', () => {
    assert.strictEqual(service.getDir(), path.join(tmpDir, '.ado-code', 'understanding'));
  });

  test('toPromptString is empty before any cache exists', () => {
    assert.strictEqual(service.toPromptString(), '');
  });

  test('ensureFresh builds repo facts + meta', async () => {
    const ok = await service.ensureFresh();
    assert.strictEqual(ok, true);
    const repo = fs.readFileSync(path.join(service.getDir(), 'repo.md'), 'utf8');
    assert.ok(repo.includes('### Repository Facts'), 'facts header');
    assert.ok(repo.includes('Branch: main'), 'git branch');
    assert.ok(repo.includes('HEAD: abc1234'), 'git head');
    assert.ok(repo.includes('AGENTS.md'), 'AGENTS.md section');
    assert.ok(repo.includes('"build": "tsc"'), 'package.json scripts');
    const meta = service.getMeta();
    assert.ok(meta.repo, 'meta.repo written');
    assert.ok(meta.repo!.fingerprint.includes('branch:main'), 'fingerprint has branch');
    assert.ok(meta.repo!.fingerprint.includes('sha:abc1234'), 'fingerprint has sha');
  });

  test('ensureFresh is a no-op while the fingerprint is unchanged', async () => {
    await service.ensureFresh();
    const before = fs.statSync(path.join(service.getDir(), 'repo.md')).mtimeMs;
    await service.ensureFresh();
    const after = fs.statSync(path.join(service.getDir(), 'repo.md')).mtimeMs;
    assert.strictEqual(before, after, 'repo.md must not be rewritten');
  });

  test('ensureFresh regenerates when AGENTS.md changes', async () => {
    await service.ensureFresh();
    write(tmpDir, 'AGENTS.md', '# Project\nBuild with npm run build.\n\nNew section that changes the size.\n');
    const fingerprintBefore = service.getMeta().repo!.fingerprint;
    await service.ensureFresh();
    const fingerprintAfter = service.getMeta().repo!.fingerprint;
    assert.notStrictEqual(fingerprintAfter, fingerprintBefore, 'fingerprint must change');
    const repo = fs.readFileSync(path.join(service.getDir(), 'repo.md'), 'utf8');
    assert.ok(repo.includes('New section that changes the size'), 'facts reflect the new AGENTS.md');
  });

  test('ensureFresh regenerates when git HEAD changes', async () => {
    await service.ensureFresh();
    service = new UnderstandingService(tmpDir, fakeGit({ getShortCommitHash: async () => 'def5678' }));
    await service.ensureFresh();
    assert.ok(service.getMeta().repo!.fingerprint.includes('sha:def5678'), 'fingerprint tracks new HEAD');
    const repo = fs.readFileSync(path.join(service.getDir(), 'repo.md'), 'utf8');
    assert.ok(repo.includes('HEAD: def5678'), 'facts reflect new HEAD');
  });

  test('ensureFresh skips git lines when git is unavailable', async () => {
    service = new UnderstandingService(tmpDir);
    await service.ensureFresh();
    const repo = fs.readFileSync(path.join(service.getDir(), 'repo.md'), 'utf8');
    assert.ok(repo.includes('### Repository Facts'));
    assert.ok(!repo.includes('Branch:'), 'no git section without a git provider');
  });

  test('refreshRepoSummary writes the LLM summary section', async () => {
    service.setSummarizer(async () => '## Architecture\nSmall demo repo with a tsc build.');
    await service.ensureFresh();
    await service.refreshRepoSummary();
    const repo = fs.readFileSync(path.join(service.getDir(), 'repo.md'), 'utf8');
    assert.ok(repo.includes('### LLM Summary'), 'summary section');
    assert.ok(repo.includes('Small demo repo'), 'summary content');
    assert.strictEqual(service.getMeta().repo!.hasSummary, true);
  });

  test('refreshRepoSummary is a no-op without a summarizer', async () => {
    await service.ensureFresh();
    await service.refreshRepoSummary(); // must not throw
    const repo = fs.readFileSync(path.join(service.getDir(), 'repo.md'), 'utf8');
    assert.ok(!repo.includes('### LLM Summary'), 'no summary without a summarizer');
  });

  test('setWorkItem caches work item context + fingerprint', () => {
    service.setWorkItem(
      { id: 42, title: 'Fix login', description: 'desc', acceptanceCriteria: 'ac', tags: 'web' },
      '2026-08-23T10:00:00Z'
    );
    const file = path.join(service.getDir(), 'workitem-42.md');
    assert.ok(fs.existsSync(file), 'workitem file written');
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('Current work item: #42 - Fix login'), 'formatted context');
    assert.ok(service.toPromptString().includes('Current work item: #42 - Fix login'), 'included in prompt block');
    assert.strictEqual(service.getMeta().workitems!['42'].fingerprint, '2026-08-23T10:00:00Z');
  });

  test('setWorkItem is idempotent for an unchanged fingerprint', () => {
    service.setWorkItem({ id: 42, title: 'Fix login' }, 'fp1');
    const before = fs.statSync(path.join(service.getDir(), 'workitem-42.md')).mtimeMs;
    service.setWorkItem({ id: 42, title: 'Fix login' }, 'fp1');
    const after = fs.statSync(path.join(service.getDir(), 'workitem-42.md')).mtimeMs;
    assert.strictEqual(before, after, 'unchanged work item must not be rewritten');
  });

  test('setWorkItem rewrites when the fingerprint changes', () => {
    service.setWorkItem({ id: 42, title: 'Fix login' }, 'fp1');
    service.setWorkItem({ id: 42, title: 'Fix login — clarified' }, 'fp2');
    const content = fs.readFileSync(path.join(service.getDir(), 'workitem-42.md'), 'utf8');
    assert.ok(content.includes('Fix login — clarified'), 'updated title persisted');
  });

  test('clearWorkItem drops the work item from toPromptString', () => {
    service.setWorkItem({ id: 42, title: 'Fix login' }, 'fp1');
    assert.ok(service.toPromptString().includes('#42'));
    service.clearWorkItem();
    assert.ok(!service.toPromptString().includes('#42'));
  });

  test('appendKnowledge appends dated entries', () => {
    service.appendKnowledge('Decided to use tsc strict mode.');
    service.appendKnowledge('Found a bug in parser.ts.');
    const content = fs.readFileSync(path.join(service.getDir(), 'knowledge.md'), 'utf8');
    assert.ok(content.includes('Decided to use tsc strict mode.'), 'first entry');
    assert.ok(content.includes('Found a bug in parser.ts.'), 'second entry');
    assert.ok(service.toPromptString().includes('Decided to use tsc strict mode.'), 'knowledge reaches the prompt block');
    assert.strictEqual(service.getMeta().knowledge!.entries, 2);
  });

  test('appendKnowledge rotates to stay within budget', () => {
    const big = 'x'.repeat(3000);
    service.appendKnowledge(big);
    service.appendKnowledge(big);
    const content = fs.readFileSync(path.join(service.getDir(), 'knowledge.md'), 'utf8');
    assert.ok(content.length <= 5200, `knowledge file too big: ${content.length}`);
    // The most recent entry survives intact with its header.
    assert.ok(content.includes('## '), 'an entry header survives rotation');
  });

  test('toPromptString caps the total block', () => {
    service.setWorkItem({ id: 1, title: 'Big', description: 'd'.repeat(13000), acceptanceCriteria: 'ac' }, 'fp1');
    const out = service.toPromptString();
    assert.ok(out.includes('…(understanding truncated'), 'truncation marker present');
    assert.ok(out.length <= 12500, `block too big: ${out.length}`);
  });

  test('toPromptString includes the staleness note + all sections', async () => {
    await service.ensureFresh();
    service.setWorkItem({ id: 7, title: 'Add feature' }, 'fp1');
    service.appendKnowledge('Prior decision.');
    const out = service.toPromptString();
    assert.ok(out.startsWith('## Repository Understanding'), 'header first');
    assert.ok(out.includes('Cached understanding'), 'staleness note');
    assert.ok(out.includes('### Repository Facts'), 'repo facts');
    assert.ok(out.includes('### Work Item'), 'work item section');
    assert.ok(out.includes('Prior Session Knowledge'), 'knowledge section');
  });
});

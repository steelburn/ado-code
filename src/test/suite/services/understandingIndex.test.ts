import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  UnderstandingIndex,
  contentHash,
  classifyCacheFile,
  DEFAULT_MAX_ENTRIES,
  INDEX_FILE,
} from '../../../services/understanding/UnderstandingIndex';

/**
 * ADO-27358 — the understanding cache keeps markdown as its payload but gains
 * a compact JSON index for listing, ranking and LRU eviction. Markdown is an
 * export format: exports are copies and must never touch the cache.
 */
suite('UnderstandingIndex — JSON index, LRU eviction and markdown export', () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-uidx-'));
  });

  teardown(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows handle lag — the OS cleans %TEMP% */
    }
  });

  function writeCache(file: string, content: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content, 'utf8');
  }

  function workItemFile(id: number): string {
    return `workitem-${id}.md`;
  }

  test('classifies cache files and hashes content', () => {
    assert.deepStrictEqual(classifyCacheFile('repo.md'), { id: 'repo', kind: 'repo' });
    assert.deepStrictEqual(classifyCacheFile('knowledge.md'), { id: 'knowledge', kind: 'knowledge' });
    assert.deepStrictEqual(classifyCacheFile('workitem-27358.md'), { id: 'workitem-27358', kind: 'workitem' });
    assert.strictEqual(classifyCacheFile('index.json'), null);
    assert.strictEqual(classifyCacheFile('export/repo.md'), null);
    assert.strictEqual(classifyCacheFile('notes.md'), null);
    assert.strictEqual(contentHash('a').length, 16);
    assert.notStrictEqual(contentHash('a'), contentHash('b'));
  });

  test('upsert records metadata and list() ranks by recency', () => {
    const index = new UnderstandingIndex(dir);
    let clock = 1_000;
    index.now = () => new Date((clock += 1_000));

    index.upsert({ id: 'repo', kind: 'repo', title: 'Repository map', content: '# Repo\n' });
    index.upsert({ id: 'workitem-1', kind: 'workitem', title: 'First', content: '# Work item 1\n' });
    index.upsert({ id: 'workitem-2', kind: 'workitem', title: 'Second', content: '# Work item 2\n' });

    const listed = index.list();
    assert.deepStrictEqual(
      listed.map((e) => e.id),
      ['workitem-2', 'workitem-1', 'repo'],
      'most recently accessed first',
    );
    const entry = listed[1]!;
    assert.strictEqual(entry.kind, 'workitem');
    assert.strictEqual(entry.file, 'workitem-1.md');
    assert.strictEqual(entry.chars, '# Work item 1\n'.length);
    assert.ok(entry.bytes > 0);
    assert.ok(fs.existsSync(path.join(dir, INDEX_FILE)), 'index.json is written');

    // touching moves an entry to the front — the LRU signal
    clock += 1_000;
    assert.strictEqual(index.touch('repo'), true);
    assert.strictEqual(index.list()[0]!.id, 'repo');
    assert.strictEqual(index.touch('nope'), false);
  });

  test('rebuilds from the directory when the index is missing or corrupt', () => {
    writeCache('repo.md', '# Repo\n');
    writeCache(workItemFile(7), '# Work item 7\n');
    writeCache('knowledge.md', '# Knowledge\n');

    const first = new UnderstandingIndex(dir).load();
    assert.deepStrictEqual(Object.keys(first.entries).sort(), ['knowledge', 'repo', 'workitem-7']);

    // corrupt index — derived state, so it must self-heal instead of throwing
    fs.writeFileSync(path.join(dir, INDEX_FILE), '{ not json', 'utf8');
    const healed = new UnderstandingIndex(dir).load();
    assert.deepStrictEqual(Object.keys(healed.entries).sort(), ['knowledge', 'repo', 'workitem-7']);

    // missing index
    fs.rmSync(path.join(dir, INDEX_FILE));
    const rebuilt = new UnderstandingIndex(dir).load();
    assert.strictEqual(Object.keys(rebuilt.entries).length, 3);

    // a hand-deleted cache file is pruned on load
    fs.rmSync(path.join(dir, workItemFile(7)));
    const pruned = new UnderstandingIndex(dir).load();
    assert.deepStrictEqual(Object.keys(pruned.entries).sort(), ['knowledge', 'repo']);
  });

  test('LRU eviction honours the cap, protects shared entries and deletes files', () => {
    const index = new UnderstandingIndex(dir);
    let clock = 1_000;
    index.now = () => new Date((clock += 1_000));

    index.upsert({ id: 'repo', kind: 'repo', title: 'Repository map', content: '# Repo\n' });
    index.upsert({ id: 'knowledge', kind: 'knowledge', title: 'Prior session knowledge', content: '# Knowledge\n' });
    for (let i = 1; i <= 12; i++) {
      writeCache(workItemFile(i), `# Work item ${i}\n`);
      index.upsert({ id: `workitem-${i}`, kind: 'workitem', title: `Item ${i}`, content: `# Work item ${i}\n` });
    }
    // refresh the newest few so the oldest are unambiguous
    clock += 1_000;
    index.touch('workitem-12');

    const evicted = index.evictLRU(10, ['repo', 'knowledge']);
    assert.strictEqual(evicted.length, 4, '14 entries down to the cap of 10');
    assert.deepStrictEqual(evicted, ['workitem-1', 'workitem-2', 'workitem-3', 'workitem-4'], 'oldest first');
    assert.ok(!fs.existsSync(path.join(dir, workItemFile(1))), 'evicted file is removed');
    const left = index.list().map((e) => e.id);
    assert.strictEqual(left.length, 10);
    assert.ok(left.includes('repo') && left.includes('knowledge'), 'protected entries survive');
    assert.ok(left.includes('workitem-12'), 'recently used entry survives');

    // already under the cap → no-op
    assert.deepStrictEqual(index.evictLRU(10, ['repo', 'knowledge']), []);
  });

  test('default cap is 300 entries', () => {
    assert.strictEqual(DEFAULT_MAX_ENTRIES, 300);
  });

  test('index stays under ~1% of the cache at 300 entries', () => {
    const index = new UnderstandingIndex(dir);
    // production-sized cache entry (~5 KB): digest + description + acceptance
    // criteria + a few comments, which is what the real cache holds.
    const body = (i: number) => `# Work item ${i}\n\n${'cached context line\n'.repeat(250)}`;
    for (let i = 1; i <= 300; i++) {
      writeCache(workItemFile(i), body(i));
      index.upsert({ id: `workitem-${i}`, kind: 'workitem', title: `Item ${i}`, content: body(i) });
    }
    const indexBytes = index.indexBytes();
    const cacheBytes = index.totalBytes();
    assert.strictEqual(index.list().length, 300);
    assert.ok(
      indexBytes < cacheBytes / 100,
      `index (${indexBytes} B) must stay under 1% of the cache (${cacheBytes} B)`,
    );
  });

  test('export copies the cache verbatim and never mutates it', () => {
    const index = new UnderstandingIndex(dir);
    writeCache('repo.md', '# Repo\n\nfacts');
    writeCache(workItemFile(42), '# Work item 42\n\ndetail');
    index.upsert({ id: 'repo', kind: 'repo', title: 'Repository map', content: fs.readFileSync(path.join(dir, 'repo.md'), 'utf8') });
    index.upsert({
      id: 'workitem-42',
      kind: 'workitem',
      title: 'Item 42',
      content: fs.readFileSync(path.join(dir, workItemFile(42)), 'utf8'),
    });

    const beforeRepo = fs.readFileSync(path.join(dir, 'repo.md'), 'utf8');
    const beforeIndex = fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8');
    const target = path.join(dir, 'export');
    const result = index.exportTo(target);

    assert.strictEqual(result.files.length, 2);
    assert.strictEqual(fs.readFileSync(path.join(target, 'repo.md'), 'utf8'), beforeRepo, 'export content matches the cache');
    assert.ok(fs.existsSync(result.manifestPath), 'manifest written');
    const manifest = fs.readFileSync(result.manifestPath, 'utf8');
    assert.ok(manifest.includes('workitem-42'), manifest);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'repo.md'), 'utf8'), beforeRepo, 'cache unchanged');
    assert.strictEqual(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'), beforeIndex, 'index unchanged');
  });

  test('remove drops the entry and its file', () => {
    const index = new UnderstandingIndex(dir);
    writeCache(workItemFile(5), '# Five\n');
    index.upsert({ id: 'workitem-5', kind: 'workitem', title: 'Five', content: '# Five\n' });
    assert.strictEqual(index.remove('workitem-5'), true);
    assert.ok(!fs.existsSync(path.join(dir, workItemFile(5))));
    assert.strictEqual(index.remove('workitem-5'), false);
  });
});

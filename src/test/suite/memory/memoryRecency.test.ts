import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserMemory } from '../../../memory/UserMemory';
import { WorkspaceMemory } from '../../../memory/WorkspaceMemory';

/**
 * Recency ordering of the memory prompt blocks.
 *
 * `renderMemoryBlock` keeps the HEAD of the digest and drops the tail once the
 * budget is exhausted, so the ordering decides WHICH memories survive. Storing
 * in insertion order (the previous behaviour) evicted the newest entries — the
 * ones most likely to still matter — and kept the stale ones.
 */

const BUDGET = { maxEntries: 2, maxCharsPerEntry: 400, maxTotalChars: 4000 };

interface Seed {
  key: string;
  category: string;
  content: string;
  timestamp: string;
}

function seedEntry(key: string, content: string, timestamp: string): Seed {
  return { key, category: 'context', content, timestamp };
}

function mockContext(seed?: Seed[]): any {
  const store = new Map<string, any>();
  if (seed) store.set('adoCode.userMemory', { entries: seed });
  return {
    globalState: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: any) => { store.set(key, value); },
    },
  };
}

suite('user memory recency ordering', () => {
  test('toPromptString lists the newest entry first', () => {
    const memory = new UserMemory(mockContext([
      seedEntry('oldest', 'value-oldest', '2024-01-01T00:00:00.000Z'),
      seedEntry('middle', 'value-middle', '2024-02-01T00:00:00.000Z'),
      seedEntry('newest', 'value-newest', '2024-03-01T00:00:00.000Z'),
    ]));
    const prompt = memory.toPromptString();
    assert.ok(prompt.indexOf('value-newest') < prompt.indexOf('value-middle'), prompt);
    assert.ok(prompt.indexOf('value-middle') < prompt.indexOf('value-oldest'), prompt);
  });

  test('the budget drops the OLDEST entries, not the newest', () => {
    const memory = new UserMemory(mockContext([
      seedEntry('oldest', 'value-oldest', '2024-01-01T00:00:00.000Z'),
      seedEntry('middle', 'value-middle', '2024-02-01T00:00:00.000Z'),
      seedEntry('newest', 'value-newest', '2024-03-01T00:00:00.000Z'),
    ]));
    const prompt = memory.toPromptString(BUDGET);
    assert.ok(prompt.includes('value-newest'), prompt);
    assert.ok(prompt.includes('value-middle'), prompt);
    assert.ok(!prompt.includes('value-oldest'), `oldest entry should be evicted: ${prompt}`);
  });

  test('updating an entry moves it to the front', () => {
    const memory = new UserMemory(mockContext([
      seedEntry('stack', 'value-stale', '2024-01-01T00:00:00.000Z'),
      seedEntry('other', 'value-other', '2024-02-01T00:00:00.000Z'),
    ]));
    memory.set('stack', 'context', 'value-refreshed');
    const prompt = memory.toPromptString();
    assert.ok(prompt.indexOf('value-refreshed') < prompt.indexOf('value-other'), prompt);
  });

  test('a malformed timestamp sorts as oldest instead of throwing', () => {
    const memory = new UserMemory(mockContext([
      seedEntry('broken', 'value-broken', 'not-a-date'),
      seedEntry('good', 'value-good', '2024-02-01T00:00:00.000Z'),
    ]));
    const prompt = memory.toPromptString();
    assert.ok(prompt.indexOf('value-good') < prompt.indexOf('value-broken'), prompt);
  });
});

suite('workspace memory recency ordering', () => {
  let dir: string;
  let memory: WorkspaceMemory;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-mem-recency-'));
    memory = new WorkspaceMemory(dir);
    memory.init();
  });

  teardown(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('listByRecency returns the newest file first, list() stays alphabetical', () => {
    memory.write('alpha', 'value-alpha');
    memory.write('beta', 'value-beta');
    memory.write('gamma', 'value-gamma');
    const dirPath = path.join(dir, '.ado-code', 'memory');
    const at = (offsetSeconds: number) => new Date(Date.parse('2024-01-01T00:00:00.000Z') + offsetSeconds * 1000);
    fs.utimesSync(path.join(dirPath, 'alpha.md'), at(0), at(0));
    fs.utimesSync(path.join(dirPath, 'beta.md'), at(60), at(60));
    fs.utimesSync(path.join(dirPath, 'gamma.md'), at(120), at(120));

    assert.deepStrictEqual(memory.listByRecency(), ['gamma', 'beta', 'alpha']);
    assert.deepStrictEqual(memory.list(), ['alpha', 'beta', 'gamma']);
  });

  test('toPromptString keeps the newest entries when the budget bites', () => {
    memory.write('alpha', 'value-alpha');
    memory.write('beta', 'value-beta');
    memory.write('gamma', 'value-gamma');
    const dirPath = path.join(dir, '.ado-code', 'memory');
    const at = (offsetSeconds: number) => new Date(Date.parse('2024-01-01T00:00:00.000Z') + offsetSeconds * 1000);
    fs.utimesSync(path.join(dirPath, 'alpha.md'), at(0), at(0));
    fs.utimesSync(path.join(dirPath, 'beta.md'), at(60), at(60));
    fs.utimesSync(path.join(dirPath, 'gamma.md'), at(120), at(120));

    const prompt = memory.toPromptString(BUDGET);
    assert.ok(prompt.includes('value-gamma'), prompt);
    assert.ok(prompt.includes('value-beta'), prompt);
    assert.ok(!prompt.includes('value-alpha'), `oldest entry should be evicted: ${prompt}`);
  });
});

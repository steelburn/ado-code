import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceMemory } from '../../../memory/WorkspaceMemory';

suite('WorkspaceMemory', () => {
  let tmpDir: string;
  let memory: WorkspaceMemory;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-memory-'));
    memory = new WorkspaceMemory(tmpDir);
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getDir returns correct path', () => {
    const expected = path.join(tmpDir, '.ado-code', 'memory');
    assert.strictEqual(memory.getDir(), expected);
  });

  test('init creates the memory directory', () => {
    const dir = memory.getDir();
    assert.ok(!fs.existsSync(dir), 'directory should not exist yet');

    memory.init();

    assert.ok(fs.existsSync(dir), 'directory should exist after init');
    assert.ok(fs.statSync(dir).isDirectory(), 'should be a directory');
  });

  test('init is idempotent', () => {
    memory.init();
    memory.init(); // should not throw
    assert.ok(fs.existsSync(memory.getDir()));
  });

  test('write and read round-trips correctly', () => {
    memory.write('project-conventions', '# Conventions\n- Use TypeScript strict mode');

    const result = memory.read('project-conventions');
    assert.strictEqual(result, '# Conventions\n- Use TypeScript strict mode');
  });

  test('write overwrites existing key', () => {
    memory.write('my-key', 'first value');
    memory.write('my-key', 'second value');

    const result = memory.read('my-key');
    assert.strictEqual(result, 'second value');
  });

  test('read returns null for missing key', () => {
    const result = memory.read('nonexistent');
    assert.strictEqual(result, null);
  });

  test('list returns sorted keys', () => {
    memory.write('zebra', 'z');
    memory.write('alpha', 'a');
    memory.write('middle', 'm');

    const keys = memory.list();
    assert.deepStrictEqual(keys, ['alpha', 'middle', 'zebra']);
  });

  test('list returns empty array when no entries exist', () => {
    const keys = memory.list();
    assert.deepStrictEqual(keys, []);
  });

  test('delete removes an existing key', () => {
    memory.write('to-delete', 'bye');
    const deleted = memory.delete('to-delete');

    assert.strictEqual(deleted, true);
    assert.strictEqual(memory.read('to-delete'), null);
  });

  test('delete returns false for nonexistent key', () => {
    const deleted = memory.delete('nonexistent');
    assert.strictEqual(deleted, false);
  });

  test('toPromptString returns empty string when no entries', () => {
    const result = memory.toPromptString();
    assert.strictEqual(result, '');
  });

  test('toPromptString formats entries as markdown', () => {
    memory.write('architecture', '## Architecture\nMonorepo with shared lib');
    memory.write('conventions', '- Use strict mode\n- No any');

    const result = memory.toPromptString();

    assert.ok(result.startsWith('## Workspace Memory'));
    assert.ok(result.includes('### architecture'));
    assert.ok(result.includes('## Architecture\nMonorepo with shared lib'));
    assert.ok(result.includes('### conventions'));
    assert.ok(result.includes('- Use strict mode\n- No any'));
  });

  test('toPromptString entries are sorted alphabetically', () => {
    memory.write('zzz', 'last');
    memory.write('aaa', 'first');

    const result = memory.toPromptString();
    const aaaIdx = result.indexOf('### aaa');
    const zzzIdx = result.indexOf('### zzz');
    assert.ok(aaaIdx < zzzIdx, 'aaa should come before zzz');
  });

  test('sanitizes path traversal in key names', () => {
    memory.write('../escape', 'bad');
    memory.write('sub/key', 'also-bad');

    // These should be written under the memory dir, not escape it
    const files = fs.readdirSync(memory.getDir());
    // The key '../escape' becomes '_.._escape.md' and 'sub/key' becomes 'sub_key.md'
    assert.ok(files.includes('_.._escape.md'), 'should sanitize ../ escape');
    assert.ok(files.includes('sub_key.md'), 'should sanitize / to _');
    assert.ok(!files.includes('escape.md'), 'should not create file outside memory dir');
  });

  test('handles empty string values', () => {
    memory.write('empty', '');
    const result = memory.read('empty');
    assert.strictEqual(result, '');

    // Empty entries still show up in list
    const keys = memory.list();
    assert.deepStrictEqual(keys, ['empty']);
  });
});

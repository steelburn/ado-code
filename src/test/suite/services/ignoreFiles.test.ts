import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DOT_ADO_CODE,
  IGNORE_FILE_NAMES,
  appendIgnoreEntry,
  ensureEntryInIgnoreFile,
  isEntryIgnored,
  missingIgnoreTargets,
} from '../../../services/ignoreFiles';

suite('ignoreFiles', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-ignore-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  suite('isEntryIgnored', () => {
    test('detects a bare entry line', () => {
      assert.strictEqual(isEntryIgnored('.gitignore\nnode_modules/\n.ado-code\n', DOT_ADO_CODE), true);
    });

    test('detects trailing-slash and root-anchored spellings', () => {
      assert.strictEqual(isEntryIgnored('.ado-code/\n', DOT_ADO_CODE), true);
      assert.strictEqual(isEntryIgnored('/.ado-code\n', DOT_ADO_CODE), true);
      assert.strictEqual(isEntryIgnored('/.ado-code/\n', DOT_ADO_CODE), true);
    });

    test('ignores comment lines and blank lines', () => {
      assert.strictEqual(isEntryIgnored('# .ado-code is important\n', DOT_ADO_CODE), false);
      assert.strictEqual(isEntryIgnored('   \n', DOT_ADO_CODE), false);
    });

    test('does not match substring or prefix lookalikes', () => {
      assert.strictEqual(isEntryIgnored('.ado-code-backup\n', DOT_ADO_CODE), false);
      assert.strictEqual(isEntryIgnored('foo/.ado-code\n', DOT_ADO_CODE), false);
      assert.strictEqual(isEntryIgnored('.ado\n', DOT_ADO_CODE), false);
    });

    test('handles CRLF line endings', () => {
      assert.strictEqual(isEntryIgnored('node_modules/\r\n.ado-code\r\n', DOT_ADO_CODE), true);
    });
  });

  suite('appendIgnoreEntry', () => {
    test('produces a labeled block for empty content', () => {
      const out = appendIgnoreEntry('', DOT_ADO_CODE);
      assert.ok(out.includes('.ado-code\n'));
      assert.ok(out.includes('# ADO Code workspace data'));
    });

    test('appends behind existing content with a blank separator', () => {
      const out = appendIgnoreEntry('node_modules/\n', DOT_ADO_CODE);
      assert.ok(out.startsWith('node_modules/\n\n# ADO Code'));
    });

    test('normalizes a file without a trailing newline', () => {
      const out = appendIgnoreEntry('node_modules/', DOT_ADO_CODE);
      assert.ok(out.includes('node_modules/\n\n# ADO Code'));
    });
  });

  suite('ensureEntryInIgnoreFile', () => {
    test('creates the file when missing and returns true', () => {
      const file = path.join(tmpDir, '.gitignore');
      assert.strictEqual(ensureEntryInIgnoreFile(file, DOT_ADO_CODE), true);
      assert.ok(fs.readFileSync(file, 'utf8').includes('.ado-code'));
    });

    test('is idempotent — second call returns false without duplicating', () => {
      const file = path.join(tmpDir, '.dockerignore');
      assert.strictEqual(ensureEntryInIgnoreFile(file, DOT_ADO_CODE), true);
      assert.strictEqual(ensureEntryInIgnoreFile(file, DOT_ADO_CODE), false);
      const content = fs.readFileSync(file, 'utf8');
      assert.strictEqual(content.split('.ado-code').length - 1, 1);
    });

    test('preserves existing ignore content', () => {
      const file = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(file, 'node_modules/\ndist/\n');
      ensureEntryInIgnoreFile(file, DOT_ADO_CODE);
      const content = fs.readFileSync(file, 'utf8');
      assert.ok(content.includes('node_modules/'));
      assert.ok(content.includes('dist/'));
      assert.ok(content.indexOf('.ado-code') > content.indexOf('dist/'));
    });
  });

  suite('missingIgnoreTargets', () => {
    test('returns files that exist but lack the entry', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
      const missing = missingIgnoreTargets(tmpDir, DOT_ADO_CODE);
      assert.deepStrictEqual(missing, ['.gitignore']);
    });

    test('returns only the files missing the entry', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.ado-code\n');
      fs.writeFileSync(path.join(tmpDir, '.dockerignore'), 'node_modules/\n');
      assert.deepStrictEqual(missingIgnoreTargets(tmpDir, DOT_ADO_CODE), ['.dockerignore']);
    });

    test('returns nothing when both are covered', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.ado-code\n');
      fs.writeFileSync(path.join(tmpDir, '.dockerignore'), '.ado-code/\n');
      assert.deepStrictEqual(missingIgnoreTargets(tmpDir, DOT_ADO_CODE), []);
    });

    test('does not synthesize files that do not exist', () => {
      assert.deepStrictEqual(missingIgnoreTargets(tmpDir, DOT_ADO_CODE), []);
      assert.deepStrictEqual(fs.readdirSync(tmpDir), []);
      assert.deepStrictEqual(IGNORE_FILE_NAMES, ['.gitignore', '.dockerignore']);
    });
  });
});

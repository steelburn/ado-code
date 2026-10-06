import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { cleanTempDir } from '../utils/cleanTempDir';

// Regression guard for the Windows temp-cleanup helper. It must reliably remove
// the directories the suites create (including read-only git object files) and
// must NOT hang or throw on a missing directory - see the harness note in
// CHANGELOG for why the old synchronous `git gc` step was dropped.

suite('cleanTempDir', () => {
  test('removes a nested directory tree recursively', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-clean-test-'));
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'f.txt'), 'x');

    cleanTempDir(dir);

    assert.strictEqual(fs.existsSync(dir), false, 'directory should be gone');
  });

  test('removes a read-only git-object-like tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-clean-ro-'));
    const objDir = path.join(dir, '.git', 'objects', 'ab');
    fs.mkdirSync(objDir, { recursive: true });
    const objFile = path.join(objDir, 'cdef0123');
    fs.writeFileSync(objFile, 'object');
    // Git stores object files read-only on Windows; emulate that.
    fs.chmodSync(objFile, 0o444);
    if (process.platform === 'win32') {
      execFileSync('attrib', ['+R', objFile]);
    }

    cleanTempDir(dir);

    assert.strictEqual(fs.existsSync(dir), false, 'read-only tree should be gone');
  });

  test('does not throw for a missing directory', () => {
    const dir = path.join(os.tmpdir(), `ado-clean-missing-${Date.now()}`);
    assert.strictEqual(fs.existsSync(dir), false);

    cleanTempDir(dir); // must be a silent no-op

    assert.strictEqual(fs.existsSync(dir), false);
  });
});

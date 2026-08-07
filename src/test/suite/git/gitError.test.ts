import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitErrorMessage } from '../../../git/gitError';

suite('gitErrorMessage', () => {
  test('reports missing cwd distinctly from missing binary', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-giterr-'));
    try {
      const missingDir = path.join(tmp, 'does-not-exist');
      const err = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      const msg = gitErrorMessage(err, missingDir);
      assert.ok(msg.includes('working directory does not exist'), msg);
      assert.ok(msg.includes(missingDir), 'names the missing dir');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reports missing PATH binary when cwd exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-giterr2-'));
    try {
      const err = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      const msg = gitErrorMessage(err, tmp);
      assert.ok(msg.includes('git executable not found'), msg);
      assert.ok(msg.includes('git.path'), 'mentions the git.path setting');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('passes through non-ENOENT errors verbatim', () => {
    const msg = gitErrorMessage(new Error('fatal: not a git repository'));
    assert.strictEqual(msg, 'fatal: not a git repository');
  });
});

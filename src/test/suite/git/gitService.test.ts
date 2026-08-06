import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { GitService } from '../../../git/GitService';

suite('GitService', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-git-'));
    cp.execSync('git init', { cwd: tmpDir });
    cp.execSync('git config user.email test@test.com', { cwd: tmpDir });
    cp.execSync('git config user.name test', { cwd: tmpDir });
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('detects a git repository', async () => {
    const service = new GitService(tmpDir);
    assert.strictEqual(await service.isGitRepo(), true);
  });

  test('rejects a non-git directory', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-plain-'));
    try {
      const service = new GitService(plainDir);
      assert.strictEqual(await service.isGitRepo(), false);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  test('creates a task branch with slugified name', async () => {
    const service = new GitService(tmpDir);
    const branch = await service.createTaskBranch(1234, 'Fix login bug!');
    assert.strictEqual(branch, 'feature/ADO-1234-fix-login-bug');
    const out = cp.execSync('git branch --show-current', { cwd: tmpDir });
    assert.strictEqual(out.toString().trim(), branch);
  });

  test('returns null when branch already exists', async () => {
    const service = new GitService(tmpDir);
    await service.createTaskBranch(1234, 'Fix login bug!');
    const branch = await service.createTaskBranch(1234, 'Fix login bug!');
    assert.strictEqual(branch, null);
  });

  test('getWorktreeInfo reports a clean repo after a commit', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add .', { cwd: tmpDir });
    cp.execSync('git commit -m "initial commit"', { cwd: tmpDir });
    const info = await service.getWorktreeInfo(tmpDir);
    assert.strictEqual(info.dirty, false);
    assert.strictEqual(info.changedFiles, 0);
    assert.ok(info.lastCommit?.includes('initial commit'));
  });

  test('getWorktreeInfo reports dirty files', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'new\n');
    const info = await service.getWorktreeInfo(tmpDir);
    assert.strictEqual(info.dirty, true);
    assert.strictEqual(info.changedFiles, 2);
  });

  test('getWorktreeInfo returns defaults for a non-git directory', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-plain-'));
    try {
      const service = new GitService(tmpDir);
      const info = await service.getWorktreeInfo(plainDir);
      assert.deepStrictEqual(info, { dirty: false, changedFiles: 0, ahead: 0, behind: 0, lastCommit: null });
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

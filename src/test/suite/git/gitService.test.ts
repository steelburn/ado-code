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
    // Deterministic default branch (git >= 2.28): some machines have no
    // init.defaultBranch config, where plain `git init` defaults to master and
    // the protected-branch test's `git checkout -b master` then fails.
    cp.execSync('git init -b main', { cwd: tmpDir });
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

  test('createWorktree names the directory with the run id (no double prefix)', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });

    const wtPath = await service.createWorktree('run-1785000000000-42', 'feature/ADO-42-fix-login');
    assert.ok(
      wtPath.endsWith(path.join('.ado-code', 'worktrees', 'run-1785000000000-42')),
      `unexpected dir name: ${wtPath}`
    );
    assert.ok(fs.existsSync(wtPath));

    // listWorktrees round-trips the canonical run id.
    const listed = await service.listWorktrees();
    const mine = listed.find(w => w.branch === 'feature/ADO-42-fix-login');
    assert.ok(mine, 'worktree should be listed');
    assert.strictEqual(mine.runId, 'run-1785000000000-42');

    await service.removeWorktree('run-1785000000000-42');
    assert.ok(!fs.existsSync(wtPath), 'worktree dir should be removed');
  });

  test('listWorktrees normalizes legacy double-prefixed dirs and removeWorktree cleans them', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });

    // Simulate the old layout: directory = `run-` + runId (run-run-999-7).
    const legacyDir = path.join(tmpDir, '.ado-code', 'worktrees', 'run-run-999-7');
    fs.mkdirSync(path.dirname(legacyDir), { recursive: true });
    const branch = 'feature/ADO-7-legacy';
    cp.execSync(`git branch ${branch}`, { cwd: tmpDir });
    cp.execSync(`git worktree add ${legacyDir} ${branch}`, { cwd: tmpDir });

    const listed = await service.listWorktrees();
    const mine = listed.find(w => w.branch === branch);
    assert.ok(mine, 'legacy worktree should be listed');
    assert.strictEqual(mine.runId, 'run-999-7', 'legacy dir normalizes to the canonical run id');

    await service.removeWorktree('run-999-7');
    assert.ok(!fs.existsSync(legacyDir), 'legacy worktree dir should be removed');
  });

  test('commitWorktreeChanges commits a dirty worktree and reports clean ones', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });
    const wtPath = await service.createWorktree('run-1-42', 'feature/ADO-42-fix-login');

    // Clean worktree → nothing to commit.
    const clean = await service.commitWorktreeChanges('run-1-42', 'ADO-42: x');
    assert.deepStrictEqual(clean, { committed: false, reason: 'nothing-to-commit' });

    // Dirty worktree → committed with the given message.
    fs.writeFileSync(path.join(wtPath, 'a.txt'), 'changed\n');
    const committed = await service.commitWorktreeChanges('run-1-42', 'ADO-42: fix login');
    assert.strictEqual(committed.committed, true);
    const log = cp.execSync('git log -1 --format=%s', { cwd: wtPath }).toString().trim();
    assert.strictEqual(log, 'ADO-42: fix login');
  });

  test('pushWorktreeBranch pushes the feature branch and refuses protected branches', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-bare-'));
    cp.execSync('git init --bare', { cwd: bareDir });
    cp.execSync(`git remote add origin ${bareDir}`, { cwd: tmpDir });

    await service.createWorktree('run-1-42', 'feature/ADO-42-fix-login');
    fs.writeFileSync(path.join(service.getWorktreePath('run-1-42'), 'a.txt'), 'changed\n');
    await service.commitWorktreeChanges('run-1-42', 'ADO-42: fix login');

    const push = await service.pushWorktreeBranch('run-1-42');
    assert.strictEqual(push.pushed, true);
    assert.strictEqual(push.branch, 'feature/ADO-42-fix-login');
    // Remote really has it.
    cp.execSync('git ls-remote origin feature/ADO-42-fix-login', { cwd: tmpDir });

    // Protected-branch refusal: a worktree on a protected branch must refuse.
    // Create 'master' branch so we can make a worktree on it (can't use 'main'
    // because it's already checked out as the default branch).
    cp.execSync('git checkout -b master', { cwd: tmpDir });
    cp.execSync('git checkout main', { cwd: tmpDir });
    await service.createWorktree('run-2-1', 'master');
    const refused = await service.pushWorktreeBranch('run-2-1');
    assert.strictEqual(refused.pushed, false);
    assert.ok(String(refused.reason).includes('protected'));
  });

  test('isBranchUpToDate detects a stale base; deleteBranchIfMerged only deletes merged branches', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });
    const wtPath = await service.createWorktree('run-1-42', 'feature/ADO-42-fix-login');
    assert.strictEqual(await service.branchExists('feature/ADO-42-fix-login'), true);
    assert.strictEqual(await service.isBranchUpToDate('feature/ADO-42-fix-login'), true, 'fresh branch is up to date');

    // Base advances; the feature branch is now stale.
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'new\n');
    cp.execSync('git add . && git commit -m "base advanced"', { cwd: tmpDir });
    assert.strictEqual(await service.isBranchUpToDate('feature/ADO-42-fix-login'), false, 'stale after base advanced');

    // Unmerged branch is NOT deleted.
    assert.strictEqual(await service.deleteBranchIfMerged('feature/ADO-42-fix-login'), false);
    assert.strictEqual(await service.branchExists('feature/ADO-42-fix-login'), true);

    // Merge it into the base, remove the worktree, then delete succeeds.
    cp.execSync('git merge feature/ADO-42-fix-login -m "merge"', { cwd: tmpDir });
    await service.removeWorktree('run-1-42');
    assert.strictEqual(await service.deleteBranchIfMerged('feature/ADO-42-fix-login'), true);
    assert.strictEqual(await service.branchExists('feature/ADO-42-fix-login'), false);
    assert.ok(!fs.existsSync(wtPath), 'worktree dir removed');
  });

  test('getWorktreeInfoForRun reports dirty state for a run', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });
    const wtPath = await service.createWorktree('run-1-42', 'feature/ADO-42-fix-login');

    let info = await service.getWorktreeInfoForRun('run-1-42');
    assert.strictEqual(info.dirty, false);

    fs.writeFileSync(path.join(wtPath, 'a.txt'), 'changed\n');
    info = await service.getWorktreeInfoForRun('run-1-42');
    assert.strictEqual(info.dirty, true);
    assert.strictEqual(info.changedFiles, 1);
  });

  test('resolveWorktreePath finds legacy run-run- dirs so commit/push never ENOENT', async () => {
    const service = new GitService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hi\n');
    cp.execSync('git add . && git commit -m "initial"', { cwd: tmpDir });
    // Legacy layout: dirs were created as `run-` + runId (run-run-<ts>-<id>).
    // listWorktrees() normalizes the dir name back to the canonical run id
    // (run-<ts>-<id>), so commit/push must find the LEGACY dir or the cwd
    // doesn't exist → Node throws the misleading "spawn git ENOENT".
    cp.execSync('git branch feature/ADO-42-legacy', { cwd: tmpDir });
    cp.execSync('git worktree add .ado-code/worktrees/run-run-1-42 feature/ADO-42-legacy', { cwd: tmpDir });

    const resolved = service.resolveWorktreePath('run-1-42');
    assert.ok(resolved.endsWith(path.join('.ado-code', 'worktrees', 'run-run-1-42')), `resolved legacy dir, got ${resolved}`);
    assert.ok(fs.existsSync(resolved), 'resolved dir exists');

    // Full round-trip: commit + push must work through the legacy dir.
    fs.writeFileSync(path.join(resolved, 'legacy.txt'), 'legacy work\n');
    const commit = await service.commitWorktreeChanges('run-1-42', 'ADO-42: legacy work');
    assert.strictEqual(commit.committed, true, 'commit succeeds via legacy dir');
    assert.ok(commit.hash, 'commit hash present');
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { parseMergeTreeOutput, getMergeConflicts } from '../../../git/mergeConflicts';

// Real output captured from git 2.34.1 `git merge-tree <base^{tree}> main feature`
// on a repo where both branches edited the same line of f.txt.
const CONFLICT_OUTPUT = `changed in both
  base   100644 83db48f84ec878fbfb30b46d16630e944e34f205 f.txt
  our    100644 d791e9b8158e2be3a792fe1881d57828989a3449 f.txt
  their  100644 00dbdcfd2b3a2c6a3a0facd9c753578741dc921e f.txt
@@ -1,3 +1,7 @@
 line1
+<<<<<<< .our
 MAIN
+=======
+FEATURE
+>>>>>>> .their
 line3
`;

suite('mergeConflicts', () => {
  test('parseMergeTreeOutput extracts base/our/their blob refs for conflicted files', () => {
    const files = parseMergeTreeOutput(CONFLICT_OUTPUT);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'f.txt');
    assert.strictEqual(files[0].baseSha, '83db48f84ec878fbfb30b46d16630e944e34f205');
    assert.strictEqual(files[0].ourSha, 'd791e9b8158e2be3a792fe1881d57828989a3449');
    assert.strictEqual(files[0].theirSha, '00dbdcfd2b3a2c6a3a0facd9c753578741dc921e');
  });

  test('parseMergeTreeOutput handles added-in-both (no base line)', () => {
    const output = `added in both
  our    100644 cd964df426dd6f6b7c723de841a342efbaf4cc69 g.txt
  their  100644 18317f17ea43af60c66d39b4ddf27da2f96f50c4 g.txt
@@ -1,2 +1,7 @@
 alpha
+<<<<<<< .our
 BETA
+=======
+beta
+GAMMA
+>>>>>>> .their
`;
    const files = parseMergeTreeOutput(output);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'g.txt');
    assert.strictEqual(files[0].baseSha, undefined);
    assert.ok(files[0].ourSha && files[0].theirSha);
  });

  test('parseMergeTreeOutput returns [] on clean/empty output', () => {
    assert.deepStrictEqual(parseMergeTreeOutput(''), []);
    assert.deepStrictEqual(parseMergeTreeOutput('merged\n  result 100644 abc f.txt\n'), []);
  });

  test('getMergeConflicts returns the conflicted file with contents (real repo)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-conflicts-'));
    try {
      const git = (cmd: string, cwd = tmp) => cp.execSync(cmd, { cwd, encoding: 'utf8' });
      git('git init -q -b main');
      git('git config user.email test@test.com');
      git('git config user.name test');
      fs.writeFileSync(path.join(tmp, 'f.txt'), 'line1\nline2\nline3\n');
      git('git add . && git commit -qm base');
      git('git checkout -qb feature');
      fs.writeFileSync(path.join(tmp, 'f.txt'), 'line1\nFEATURE\nline3\n');
      git('git commit -qam feature');
      git('git checkout -q main');
      fs.writeFileSync(path.join(tmp, 'f.txt'), 'line1\nMAIN\nline3\n');
      git('git commit -qam mainchange');

      const conflicts = await getMergeConflicts(tmp, 'main', 'feature');

      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].path, 'f.txt');
      assert.strictEqual(conflicts[0].ours, 'line1\nMAIN\nline3\n');
      assert.strictEqual(conflicts[0].theirs, 'line1\nFEATURE\nline3\n');
      assert.strictEqual(conflicts[0].base, 'line1\nline2\nline3\n');
      assert.ok(!conflicts[0].truncated);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('getMergeConflicts returns [] when branches do not touch the same files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-conflicts2-'));
    try {
      const git = (cmd: string, cwd = tmp) => cp.execSync(cmd, { cwd, encoding: 'utf8' });
      git('git init -q -b main');
      git('git config user.email test@test.com');
      git('git config user.name test');
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'a\n');
      git('git add . && git commit -qm base');
      git('git checkout -qb feature');
      fs.writeFileSync(path.join(tmp, 'b.txt'), 'b\n');
      git('git add . && git commit -qm feature');
      git('git checkout -q main');
      fs.writeFileSync(path.join(tmp, 'c.txt'), 'c\n');
      git('git add . && git commit -qm mainchange');

      const conflicts = await getMergeConflicts(tmp, 'main', 'feature');
      assert.deepStrictEqual(conflicts, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

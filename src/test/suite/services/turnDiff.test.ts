import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_UNTRACKED_LINES, collectTurnDiff, newFileDiff, normalizeDiffPaths } from '../../../services/review/turnDiff';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

suite('review diff collection (roadmap #3)', () => {
  let repo: string;
  let gitAvailable = false;

  setup(function () {
    gitAvailable = hasGit();
    if (!gitAvailable) {
      return;
    }
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-code-review-'));
    git(repo, ['init', '-q']);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'const b = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  teardown(() => {
    if (repo && fs.existsSync(repo)) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('diffs only the paths the turn touched', async function () {
    if (!gitAvailable) {
      return this.skip();
    }
    fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 2;\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'const b = 2;\n');
    const diff = await collectTurnDiff(repo, ['a.ts']);
    assert.ok(diff.includes('const a = 2'), 'the touched change must be in the diff');
    assert.ok(!diff.includes('const b = 2'), 'an untouched file must not be blamed on the turn');
  });

  test('an untracked file still reaches the review', async function () {
    if (!gitAvailable) {
      return this.skip();
    }
    fs.writeFileSync(path.join(repo, 'new.ts'), 'export const fresh = true;\n');
    const diff = await collectTurnDiff(repo, ['new.ts']);
    assert.ok(diff.includes('new file mode'), 'a new file has no git diff, so it is rendered by hand');
    assert.ok(diff.includes('+export const fresh = true;'));
  });

  test('a binary untracked file is skipped, not inlined', async function () {
    if (!gitAvailable) {
      return this.skip();
    }
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 4]));
    assert.strictEqual((await collectTurnDiff(repo, ['blob.bin'])).trim(), '');
  });

  test('a huge new file is capped at a stated number of lines', async function () {
    if (!gitAvailable) {
      return this.skip();
    }
    const lines = Array.from({ length: MAX_UNTRACKED_LINES + 25 }, (_v, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(repo, 'big.ts'), lines);
    const block = await newFileDiff(repo, 'big.ts');
    assert.ok(block.includes('25 more lines not shown'), 'the cap must be visible');
    assert.ok(!block.includes(`+line ${MAX_UNTRACKED_LINES + 1}`));
  });

  test('nothing changed means nothing to review', async function () {
    if (!gitAvailable) {
      return this.skip();
    }
    assert.strictEqual((await collectTurnDiff(repo, ['a.ts', 'b.ts'])).trim(), '');
  });

  test('a path outside the repository is dropped', function () {
    assert.deepStrictEqual(normalizeDiffPaths(repo ?? process.cwd(), ['../escape.ts', 'a.ts']), ['a.ts']);
  });

  test('duplicate and empty paths collapse', function () {
    assert.deepStrictEqual(normalizeDiffPaths(repo ?? process.cwd(), ['a.ts', './a.ts', '', ' a.ts ']), ['a.ts']);
  });

  test('not a git repository degrades to an empty diff', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-code-norepo-'));
    try {
      fs.writeFileSync(path.join(plain, 'a.ts'), 'x');
      assert.strictEqual(await collectTurnDiff(plain, ['a.ts']), '');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

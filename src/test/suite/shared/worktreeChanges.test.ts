import * as assert from 'assert';
import {
  WorktreeChange,
  changeIconId,
  changeLabel,
  describeOverwriteWarning,
  detectWorkspaceOverwrites,
  isApplied,
  isDeletion,
  isNewFile,
  normalizeRepoPath,
  mergeWorktreeChanges,
  normalizeStatus,
  parseNameStatus,
  parsePorcelain,
  sortWorktreeChanges,
  summarizeWorktreeChanges,
  summarizeWorktreeCounts,
} from '../../../shared/worktreeChanges';

suite('shared/worktreeChanges', () => {
  suite('parseNameStatus', () => {
    test('reads NUL-separated status/path pairs from git diff', () => {
      const out = 'M\u0000src/a.ts\u0000D\u0000old/b.ts\u0000A\u0000new/c.ts\u0000';
      const changes = parseNameStatus(out);
      assert.deepStrictEqual(changes, [
        { path: 'src/a.ts', status: 'M', pending: false },
        { path: 'old/b.ts', status: 'D', pending: false },
        { path: 'new/c.ts', status: 'A', pending: false },
      ]);
    });

    test('keeps spaces in paths (the -z stream is not quoted)', () => {
      const out = 'M\u0000docs/my notes.md\u0000';
      assert.deepStrictEqual(parseNameStatus(out), [
        { path: 'docs/my notes.md', status: 'M', pending: false },
      ]);
    });

    test('ignores a trailing partial record and empty output', () => {
      assert.deepStrictEqual(parseNameStatus('M\u0000src/a.ts\u0000M'), parseNameStatus('M\u0000src/a.ts\u0000'));
      assert.deepStrictEqual(parseNameStatus(''), []);
      assert.deepStrictEqual(parseNameStatus(undefined as unknown as string), []);
    });
  });

  suite('parsePorcelain', () => {
    test('maps index/worktree columns onto coarse statuses', () => {
      const out = ' M a.txt\u0000 D keep.txt\u0000?? b c.txt\u0000A  staged.ts\u0000';
      assert.deepStrictEqual(parsePorcelain(out), [
        { path: 'a.txt', status: 'M', pending: true },
        { path: 'keep.txt', status: 'D', pending: true },
        { path: 'b c.txt', status: 'U', pending: true },
        { path: 'staged.ts', status: 'A', pending: true },
      ]);
    });

    test('treats unresolved merges as modifications', () => {
      assert.deepStrictEqual(parsePorcelain('UU clash.ts\u0000'), [
        { path: 'clash.ts', status: 'M', pending: true },
      ]);
    });

    test('normalizes backslashes so paths match on Windows', () => {
      assert.deepStrictEqual(parsePorcelain(' M src\\win\\a.ts\u0000'), [
        { path: 'src/win/a.ts', status: 'M', pending: true },
      ]);
    });

    test('drops malformed records', () => {
      assert.deepStrictEqual(parsePorcelain('\u0000 M\u0000'), []);
    });
  });

  suite('mergeWorktreeChanges', () => {
    test('unions committed and pending lists and marks the pending ones', () => {
      const committed = [
        { path: 'a.ts', status: 'M' as const, pending: false },
        { path: 'b.ts', status: 'A' as const, pending: false },
      ];
      const pending = [{ path: 'b.ts', status: 'M' as const, pending: true }];
      assert.deepStrictEqual(mergeWorktreeChanges(committed, pending), [
        { path: 'a.ts', status: 'M', pending: false },
        { path: 'b.ts', status: 'M', pending: true },
      ]);
    });

    test('the pending status wins for a path in both lists', () => {
      const merged = mergeWorktreeChanges(
        [{ path: 'x.ts', status: 'M', pending: false }],
        [{ path: 'x.ts', status: 'U', pending: true }]
      );
      assert.strictEqual(merged[0].status, 'U');
      assert.strictEqual(merged[0].pending, true);
    });

    test('sorts by path and never mutates the inputs', () => {
      const committed = [
        { path: 'z.ts', status: 'M' as const, pending: false },
        { path: 'a.ts', status: 'M' as const, pending: false },
      ];
      const merged = mergeWorktreeChanges(committed, []);
      assert.deepStrictEqual(
        merged.map((c) => c.path),
        ['a.ts', 'z.ts']
      );
      assert.deepStrictEqual(
        committed.map((c) => c.path),
        ['z.ts', 'a.ts']
      );
      assert.deepStrictEqual(sortWorktreeChanges([]), []);
    });
  });

  suite('presentation helpers', () => {
    test('labels and icons per status', () => {
      assert.strictEqual(changeLabel('A'), 'Added');
      assert.strictEqual(changeLabel('M'), 'Modified');
      assert.strictEqual(changeLabel('D'), 'Deleted');
      assert.strictEqual(changeLabel('U'), 'Untracked');
      assert.strictEqual(changeIconId('D'), 'diff-removed');
      assert.strictEqual(changeIconId('M'), 'diff-modified');
    });

    test('normalizeStatus folds renames/copies/typechanges into modifications', () => {
      assert.strictEqual(normalizeStatus('R100'), 'M');
      assert.strictEqual(normalizeStatus('C75'), 'M');
      assert.strictEqual(normalizeStatus('T'), 'M');
      assert.strictEqual(normalizeStatus('a'), 'A');
      assert.strictEqual(normalizeStatus(''), 'M');
    });

    test('deletion / new-file predicates drive accept and reject', () => {
      assert.strictEqual(isDeletion('D'), true);
      assert.strictEqual(isDeletion('M'), false);
      assert.strictEqual(isNewFile('A'), true);
      assert.strictEqual(isNewFile('U'), true);
      assert.strictEqual(isNewFile('D'), false);
    });

    test('summarizeWorktreeChanges reports files, uncommitted and applied', () => {
      assert.strictEqual(summarizeWorktreeChanges([]), 'no changes');
      assert.strictEqual(
        summarizeWorktreeChanges([{ path: 'a', status: 'M', pending: false }]),
        '1 file'
      );
      assert.strictEqual(
        summarizeWorktreeChanges([
          { path: 'a', status: 'M', pending: false },
          { path: 'b', status: 'A', pending: true },
        ]),
        '2 files · 1 uncommitted'
      );
      // applied is the review outcome: it rides alongside uncommitted, which is
      // a git fact accept never changes (the worktree keeps the file for its PR)
      assert.strictEqual(
        summarizeWorktreeChanges([
          { path: 'a', status: 'M', pending: true, applied: true },
          { path: 'b', status: 'A', pending: true },
        ]),
        '2 files · 2 uncommitted · 1 applied'
      );
      assert.strictEqual(
        summarizeWorktreeChanges([{ path: 'a', status: 'M', pending: false, applied: true }]),
        '1 file · 1 applied'
      );
      assert.strictEqual(
        summarizeWorktreeChanges([{ path: 'a', status: 'M', pending: false }]),
        '1 file'
      );
    });

    test('summarizeWorktreeCounts separates uncommitted from applied', () => {
      assert.deepStrictEqual(summarizeWorktreeCounts([]), {
        files: 0,
        uncommitted: 0,
        applied: 0,
      });
      assert.deepStrictEqual(
        summarizeWorktreeCounts([
          { path: 'a', status: 'M', pending: true, applied: true },
          { path: 'b', status: 'A', pending: false },
        ]),
        { files: 2, uncommitted: 1, applied: 1 }
      );
    });
  });
  suite('isApplied', () => {
    const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

    test('a modification counts only when the bytes are identical', () => {
      assert.strictEqual(isApplied('M', buf('a'), buf('a')), true);
      assert.strictEqual(isApplied('M', buf('a'), buf('b')), false);
    });

    test('an added file counts once it exists here with that content', () => {
      assert.strictEqual(isApplied('A', undefined, buf('a')), false);
      assert.strictEqual(isApplied('U', undefined, buf('a')), false);
      assert.strictEqual(isApplied('A', buf('a'), buf('a')), true);
    });

    test('a deletion counts once the file is gone from the workspace', () => {
      assert.strictEqual(isApplied('D', undefined, buf('a')), true);
      assert.strictEqual(isApplied('D', buf('a'), buf('a')), false);
    });

    test('an unreadable side is never reported as applied', () => {
      assert.strictEqual(isApplied('M', undefined, undefined), false);
    });
  });

  suite('normalizeRepoPath', () => {
    test('flattens Windows separators and a leading ./', () => {
      assert.strictEqual(normalizeRepoPath('src\\a\\b.ts'), 'src/a/b.ts');
      assert.strictEqual(normalizeRepoPath('./src/a.ts'), 'src/a.ts');
      assert.strictEqual(normalizeRepoPath('src/a.ts'), 'src/a.ts');
    });
  });

  suite('detectWorkspaceOverwrites', () => {
    const change = (path: string, applied?: boolean): WorktreeChange => ({
      path,
      status: 'M',
      pending: false,
      applied,
    });

    test('reports a path the workspace already carries changes for', () => {
      assert.deepStrictEqual(
        detectWorkspaceOverwrites([change('src/a.ts'), change('src/b.ts')], ['src/a.ts']),
        ['src/a.ts']
      );
    });

    test('ignores a file an earlier accept already applied', () => {
      assert.deepStrictEqual(
        detectWorkspaceOverwrites([change('src/a.ts', true)], ['src/a.ts']),
        []
      );
    });

    test('matches across separator styles and sorts the result', () => {
      assert.deepStrictEqual(
        detectWorkspaceOverwrites(
          [change('src/z.ts'), change('src/a.ts')],
          ['src\\a.ts', 'src/z.ts']
        ),
        ['src/a.ts', 'src/z.ts']
      );
    });

    test('reports nothing when the workspace is clean', () => {
      assert.deepStrictEqual(
        detectWorkspaceOverwrites([change('src/a.ts')], []),
        []
      );
    });
  });

  suite('describeOverwriteWarning', () => {
    test('is empty when nothing clashes', () => {
      assert.strictEqual(describeOverwriteWarning([]), '');
    });

    test('names the paths', () => {
      const msg = describeOverwriteWarning(['src/a.ts', 'src/b.ts']);
      assert.ok(msg.includes('2 file(s) already changed in this workspace'));
      assert.ok(msg.includes('src/a.ts, src/b.ts'));
    });

    test('caps the listing and counts the rest', () => {
      const msg = describeOverwriteWarning(['a', 'b', 'c', 'd', 'e']);
      assert.ok(msg.includes('a, b, c (+2 more)'));
    });
  });
});


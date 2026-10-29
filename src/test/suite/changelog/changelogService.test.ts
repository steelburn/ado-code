import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ChangelogService, buildCompletionEntry, isImplementingBranch } from '../../../changelog/ChangelogService';
import { makeScratchDir } from '../utils/scratchDir';

suite('ChangelogService', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = makeScratchDir('adocode-changelog-');
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates CHANGELOG.md when missing', async () => {
    const service = new ChangelogService(tmpDir);
    const filePath = await service.addEntry({
      workItemId: 42,
      title: 'Fix login bug',
      state: 'Done',
      date: '2026-08-02',
      workItemUrl: 'https://dev.azure.com/org/proj/_workitems/edit/42',
    });
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('## [Unreleased]'));
    assert.ok(content.includes('ADO-42'));
  });

  test('appends under Unreleased in existing file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n- old entry\n');
    const service = new ChangelogService(tmpDir);
    await service.addEntry({
      workItemId: 7,
      title: 'Add feature',
      state: 'Closed',
      date: '2026-08-02',
      workItemUrl: 'https://dev.azure.com/org/proj/_workitems/edit/7',
    });
    const content = fs.readFileSync(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    assert.ok(content.includes('ADO-7'));
    assert.ok(content.indexOf('ADO-7') < content.indexOf('old entry'));
  });

  test('hasEntry is idempotent for same work item', async () => {
    const service = new ChangelogService(tmpDir);
    const entry = {
      workItemId: 99,
      title: 'X',
      state: 'Done',
      date: '2026-08-02',
      workItemUrl: 'u',
    };
    assert.strictEqual(service.hasEntry(99), false);
    await service.addEntry(entry);
    assert.strictEqual(service.hasEntry(99), true);
  });

  test('formatForAdo produces a comment-ready markdown block', async () => {
    const service = new ChangelogService(tmpDir);
    const text = service.formatForAdo({
      workItemId: 42,
      title: 'Fix login bug',
      state: 'Done',
      date: '2026-08-02',
      workItemUrl: 'https://dev.azure.com/org/proj/_workitems/edit/42',
    });
    assert.ok(text.includes('ADO-42'));
    assert.ok(text.includes('Fix login bug'));
    assert.ok(text.includes('**Changelog entry added'));
    assert.ok(text.includes('ADO Code'));
    // ADO collapses single newlines: blocks must be separated by blank lines
    // so paragraphs survive, and the link must be its own bullet.
    assert.ok(text.includes('\n\n'), 'blocks separated by blank lines');
    assert.ok(text.includes('- [Open in Azure DevOps]('), 'clickable link bullet present');
    assert.ok(!text.includes('- [ADO-42]('), 'id/title bullet no longer embeds the raw link');
    assert.ok(!text.includes('Branch:'), 'no branch line when branch/commit are absent');
  });

  test('formatForAdo renders branch and commit as a backticked bullet', async () => {
    const service = new ChangelogService(tmpDir);
    const text = service.formatForAdo({
      workItemId: 7,
      title: 'Add feature',
      state: 'Closed',
      date: '2026-08-02',
      workItemUrl: 'https://dev.azure.com/org/proj/_workitems/edit/7',
      branch: 'feature/ado-7',
      commitHash: 'abc1234',
    });
    assert.ok(text.includes('- Branch: `feature/ado-7 @ abc1234`'), 'branch + commit on one backticked bullet');
  });

  // ── ADO-26933: hasEntry() is an idempotency guard, not a text search ────
  test('hasEntry ignores a prose mention of the id (ADO-26933)', async () => {
    const svc = new ChangelogService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'), [
      '# Changelog',
      '## [Unreleased]',
      '- Resolved [ADO-7](https://example/edit/7): something else',
      // The defect: the branch name quotes ADO-42, which is not an entry.
      '  - branch `feature/ADO-42-slug-abc123`, so a second run for it',
      '',
    ].join('\n'));
    assert.strictEqual(svc.hasEntry(42), false, 'prose mention must not count as an entry');
    assert.strictEqual(svc.hasEntry(7), true, 'the linked bullet is an entry');
  });

  test('hasEntry does not confuse ADO-42 with ADO-421 (ADO-26933)', async () => {
    const svc = new ChangelogService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'), '- Closed [ADO-421](https://example/edit/421): longer id\n');
    assert.strictEqual(svc.hasEntry(42), false, 'ADO-421 is not an entry for ADO-42');
    assert.strictEqual(svc.hasEntry(421), true, 'ADO-421 is an entry for ADO-421');
  });

  test('hasEntry ignores a mid-sentence link mention (ADO-26933)', async () => {
    const svc = new ChangelogService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'), 'See the note about [ADO-42](https://example/edit/42) for details.\n');
    assert.strictEqual(svc.hasEntry(42), false, 'a sentence is not an entry bullet');
  });

  test('the entry is still written when the id only appears in prose (ADO-26933)', async () => {
    const svc = new ChangelogService(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'), [
      '# Changelog',
      '## [Unreleased]',
      '- Resolved [ADO-7](https://example/edit/7): quotes `feature/ADO-42-slug-abc123`',
      '',
    ].join('\n'));
    assert.strictEqual(svc.hasEntry(42), false);
    const filePath = await svc.addEntry({
      workItemId: 42,
      title: 'the closed item',
      state: 'Closed',
      date: '2026-10-15',
      workItemUrl: 'https://example/edit/42',
    });
    const text = fs.readFileSync(filePath, 'utf8');
    assert.ok(text.includes('[ADO-42](https://example/edit/42)'), 'the suppressed entry is now written');
    assert.strictEqual(svc.hasEntry(42), true, 'and the guard now sees it');
    assert.strictEqual(svc.hasEntry(42) && svc.hasEntry(7), true, 'the other entry is untouched');
  });

  // ── ADO-26934: the entry must describe the item being closed ────────────
  test('buildCompletionEntry records the closed item title, not another item (ADO-26934)', () => {
    const entry = buildCompletionEntry({
      workItemId: 26759,
      closedItemTitle: 'AD-02 unique branch + title fallback',
      state: 'Closed',
      date: '2026-10-15',
      workItemUrl: 'https://example/edit/26759',
      branch: 'feature/ADO-26759-unique-branch-abc123',
      commitHash: 'abc1234',
    });
    assert.strictEqual(entry.title, 'AD-02 unique branch + title fallback');
    assert.strictEqual(entry.branch, 'feature/ADO-26759-unique-branch-abc123');
    assert.strictEqual(entry.commitHash, 'abc1234');
  });

  test('buildCompletionEntry falls back to a neutral title (ADO-26934)', () => {
    for (const missing of [undefined, null, '', '   ']) {
      const entry = buildCompletionEntry({
        workItemId: 42,
        closedItemTitle: missing,
        state: 'Closed',
        date: '2026-10-15',
        workItemUrl: 'https://example/edit/42',
      });
      assert.strictEqual(entry.title, 'Work item 42', `neutral title for ${JSON.stringify(missing)}`);
      assert.ok(!entry.title.includes('undefined'), 'never #undefined');
    }
  });

  test('buildCompletionEntry drops the pointer on a non-implementing branch (ADO-26934)', () => {
    for (const branch of ['main', 'master', 'develop', 'trunk', 'HEAD', 'refs/heads/main', '  main  ']) {
      const entry = buildCompletionEntry({
        workItemId: 42,
        closedItemTitle: 't',
        state: 'Closed',
        date: '2026-10-15',
        workItemUrl: 'https://example/edit/42',
        branch,
        commitHash: 'abc1234',
      });
      assert.strictEqual(entry.branch, undefined, `no branch pointer for ${branch}`);
      assert.strictEqual(entry.commitHash, undefined, `no commit pointer for ${branch}`);
    }
  });

  test('isImplementingBranch normalises refs and rejects detachment (ADO-26934)', () => {
    assert.strictEqual(isImplementingBranch('feature/ADO-26931-prompt-only-delegation'), true);
    assert.strictEqual(isImplementingBranch('refs/heads/fix/x'), true);
    assert.strictEqual(isImplementingBranch('refs/heads/main'), false);
    assert.strictEqual(isImplementingBranch('HEAD'), false);
    assert.strictEqual(isImplementingBranch('HEAD~1'), false);
    assert.strictEqual(isImplementingBranch(null), false);
    assert.strictEqual(isImplementingBranch(undefined), false);
    assert.strictEqual(isImplementingBranch(''), false);
  });

});

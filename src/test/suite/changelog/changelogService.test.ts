import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChangelogService } from '../../../changelog/ChangelogService';

suite('ChangelogService', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-changelog-'));
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
});

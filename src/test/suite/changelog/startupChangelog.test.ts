import * as assert from 'assert';
import {
  changelogAnnouncement,
  changelogNotificationText,
  changelogPanelHtml,
  changelogSectionFor,
  escapeHtml,
  readChangelog,
} from '../../../changelog/startupChangelog';

/**
 * Regression suite for the startup "What's New" announcement.
 *
 * The announcement used to live at the END of `activate()` behind an
 * `await vscode.window.showInformationMessage(...)`, and it only fired when a
 * stored `lastSeenVersion` existed — so a fresh install never saw it, and any
 * user who ignored the toast had activation held open behind it. The decision
 * is now a pure function that runs in the first lines of activation.
 */
suite('startupChangelog', () => {
  suite('changelogAnnouncement', () => {
    test('announces the first run when nothing was ever seen', () => {
      assert.strictEqual(changelogAnnouncement(undefined, '0.8.3'), 'first-run');
      assert.strictEqual(changelogAnnouncement(null, '0.8.3'), 'first-run');
      assert.strictEqual(changelogAnnouncement('', '0.8.3'), 'first-run');
      assert.strictEqual(changelogAnnouncement('   ', '0.8.3'), 'first-run');
    });

    test('announces an update when the stored version differs', () => {
      assert.strictEqual(changelogAnnouncement('0.8.2', '0.8.3'), 'update');
    });

    test('stays quiet when the version was already seen', () => {
      assert.strictEqual(changelogAnnouncement('0.8.3', '0.8.3'), null);
      assert.strictEqual(changelogAnnouncement(' 0.8.3 ', '0.8.3'), null);
    });

    test('stays quiet when the current version is unknown', () => {
      assert.strictEqual(changelogAnnouncement('0.8.2', undefined), null);
      assert.strictEqual(changelogAnnouncement('0.8.2', ''), null);
      assert.strictEqual(changelogAnnouncement(undefined, undefined), null);
    });
  });

  suite('changelogNotificationText', () => {
    test('a first run is worded as a welcome, an update as a change', () => {
      const first = changelogNotificationText('first-run', '0.8.3');
      const update = changelogNotificationText('update', '0.8.3');
      assert.ok(first.includes('0.8.3'), `first-run text: ${JSON.stringify(first)}`);
      assert.ok(update.includes('0.8.3'), `update text: ${JSON.stringify(update)}`);
      assert.notStrictEqual(first, update);
      assert.ok(/ready/i.test(first), `first-run text should read like a welcome: ${JSON.stringify(first)}`);
    });
  });

  suite('readChangelog', () => {
    test('reads CHANGELOG.md from the extension folder', () => {
      const seen: string[] = [];
      const content = readChangelog('C:\\ext', (filePath) => {
        seen.push(filePath);
        return '# Changelog\n';
      });
      assert.strictEqual(content, '# Changelog\n');
      assert.strictEqual(seen.length, 1);
      assert.ok(/CHANGELOG\.md$/.test(seen[0]), `read path: ${seen[0]}`);
    });

    test('is undefined instead of throwing when the file cannot be read', () => {
      const content = readChangelog('C:\\ext', () => {
        throw new Error('ENOENT');
      });
      assert.strictEqual(content, undefined);
    });
  });

  suite('changelogSectionFor', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- unreleased thing',
      '',
      '## [0.8.3] - 2024-05-01',
      '',
      '- released thing',
      '',
      '## [0.8.2] - 2024-04-01',
      '',
      '- older thing',
      '',
    ].join('\n');

    test('returns the requested version', () => {
      const section = changelogSectionFor(changelog, '0.8.2');
      assert.ok(section, 'expected a section');
      assert.ok(section!.includes('older thing'), `section: ${JSON.stringify(section)}`);
      assert.ok(!section!.includes('released thing'), `section: ${JSON.stringify(section)}`);
    });

    test('falls back to the newest released section for an unpublished (dev) version', () => {
      const section = changelogSectionFor(changelog, '0.9.0-dev');
      assert.ok(section, 'expected the fallback section');
      assert.ok(section!.includes('released thing'), `section: ${JSON.stringify(section)}`);
      assert.ok(!section!.includes('unreleased thing'), `unreleased entries must not leak: ${JSON.stringify(section)}`);
    });

    test('is undefined when there is no versioned section', () => {
      assert.strictEqual(changelogSectionFor('# Changelog\n\nnothing yet\n', '0.8.3'), undefined);
    });
  });

  suite('escapeHtml', () => {
    test('escapes the characters that would break the panel markup', () => {
      assert.strictEqual(escapeHtml('<b>&"</b>'), '&lt;b&gt;&amp;&quot;&lt;/b&gt;');
    });
  });

  suite('changelogPanelHtml', () => {
    test('renders a standalone page with the version and the section', () => {
      const html = changelogPanelHtml('0.8.3', '- **fixed** the thing');
      assert.ok(html.startsWith('<!DOCTYPE html>'), 'expected a standalone document');
      assert.ok(html.includes('0.8.3'), 'expected the version');
      assert.ok(html.includes('the thing'), 'expected the changelog body');
    });

    test('adds the welcome lead-in on a first run only', () => {
      const first = changelogPanelHtml('0.8.3', '- x', { firstRun: true });
      const update = changelogPanelHtml('0.8.3', '- x');
      assert.ok(first.includes('Welcome to ADO Code'), 'first run should be introduced');
      assert.ok(!update.includes('Welcome to ADO Code'), 'an update should not be introduced');
    });

    test('escapes the version it interpolates', () => {
      const html = changelogPanelHtml('<script>x</script>', '- x');
      assert.ok(!html.includes('<script>x</script>'), 'the version must be escaped');
      assert.ok(html.includes('&lt;script&gt;'), 'the version must be escaped');
    });
  });
});

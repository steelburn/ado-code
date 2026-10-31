import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  extractChangelogSection,
  reflowWrappedLines,
  renderChangelogMarkdown,
} from '../../../changelog/changelogMarkdown';

/**
 * Regression suite for the "What's New" panel: CHANGELOG.md bullets are
 * hard-wrapped, and the panel used to render them line by line, so every
 * entry stopped mid-sentence after its first physical line.
 */
suite('changelogMarkdown', () => {
  test('a wrapped bullet is folded back into one <li>, not cut at line one', () => {
    const markdown = [
      '- **The remote console is now a single-page app.** It used to be',
      '  server-rendered per tab, so every navigation lost the',
      '  scroll position.',
      '- Choice cards answered on either surface now close on both.',
    ].join('\n');

    const html = renderChangelogMarkdown(markdown);
    const items = html.match(/<li>[\s\S]*?<\/li>/g) ?? [];
    assert.strictEqual(items.length, 2, 'two bullets, not five fragments');
    assert.ok(items[0].includes('server-rendered per tab'), 'second line survives');
    assert.ok(items[0].includes('scroll position.'), 'last line survives');
    assert.ok(!items[1].includes('scroll position'), 'bullets stay separate');
  });

  test('a heading does not swallow the bullet that follows it', () => {
    const html = renderChangelogMarkdown('### Added\n\n- first item\n  continued\n\n### Fixed\n\n- second');
    assert.ok(html.includes('<h3>Added</h3>'), 'heading rendered on its own');
    assert.ok(html.includes('<h3>Fixed</h3>'), 'later heading still a heading');
    assert.ok(!/<h3>[^<]*continued/.test(html), 'continuation did not join the heading');
    assert.ok(html.includes('first item continued'), 'bullet text folded');
  });

  test('a blank line still separates paragraphs', () => {
    assert.strictEqual(reflowWrappedLines('one\ntwo\n\nthree\nfour'), 'one two\n\nthree four');
  });

  test('inline markdown inside a folded bullet is rendered', () => {
    const html = renderChangelogMarkdown('- What the host *can* fulfil itself, via `npm i` and **bold**\n  second line');
    assert.ok(html.includes('<em>can</em>'), 'italic');
    assert.ok(html.includes('<strong>bold</strong>'), 'bold');
    assert.ok(html.includes('<code>npm i</code>'), 'inline code');
    assert.ok(html.includes('<strong>bold</strong> second line'), 'fold happened before inline rendering');
  });

  test('a hard break (two trailing spaces) keeps the lines apart', () => {
    assert.strictEqual(reflowWrappedLines('first  \nsecond'), 'first\nsecond');
  });

  test('fenced code is passed through untouched', () => {
    const reflowed = reflowWrappedLines('- item\n  code below:\n```\nconst a = 1;\nconst b = 2;\n```');
    assert.ok(reflowed.includes('const a = 1;\nconst b = 2;'), `reflowed to ${JSON.stringify(reflowed)}`);
  });

  test('extractChangelogSection picks the dated heading and stops at the next one', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- pending',
      '',
      '## [0.8.3] - 2026-10-30',
      '',
      '### Fixed',
      '',
      '- the panel entry',
      '',
      '## [0.8.2] - 2026-10-29',
      '',
      '- older',
    ].join('\n');

    const section = extractChangelogSection(changelog, '0.8.3');
    assert.ok(section, 'section found');
    assert.ok(section!.includes('the panel entry'), 'body included');
    assert.ok(!section!.includes('older'), 'next version excluded');
    assert.strictEqual(extractChangelogSection(changelog, '9.9.9'), undefined);
  });

  // ── The shipped file: this is the exact input the panel renders ─────────
  test('every wrapped bullet in CHANGELOG.md keeps its final line', () => {
    const root = path.join(__dirname, '../../../..');
    const changelogPath = path.join(root, 'CHANGELOG.md');
    if (!fs.existsSync(changelogPath)) return; // no repo root (isolated run)
    const markdown = fs.readFileSync(changelogPath, 'utf8');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;

    const section = extractChangelogSection(markdown, version) ?? extractChangelogSection(markdown, 'Unreleased');
    assert.ok(section, `a changelog section exists for ${version}`);

    const rendered = words(stripTags(renderChangelogMarkdown(section!)));
    const tails = wrappedBulletTails(section!.split('\n'));
    assert.ok(tails.length > 0, 'the section has wrapped bullets to check');
    for (const tail of tails) {
      assert.ok(containsSequence(rendered, tail), `wrapped bullet lost its tail "${tail.join(' ')}"`);
    }
  });
});

/** Drop the tags the renderer emits so inline markup cannot split a phrase. */
function stripTags(html: string): string {
  return html.replace(/<\/?[a-z][a-z0-9]*(?:\s[^>]*)?>/gi, ' ');
}

/**
 * Lower-case word tokens of a string. Comparing word sequences rather than
 * raw text keeps the check independent of HTML tags, entities and the
 * markdown emphasis markers the renderer consumes.
 */
function words(text: string): string[] {
  return (text.replace(/&[a-z]+;/gi, ' ').replace(/&/g, ' ').toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, offset) => haystack[i + offset] === word)) return true;
  }
  return false;
}

/**
 * For every bullet that wraps onto continuation lines, return the last few
 * words of its final continuation line — the text the old line-by-line
 * renderer dropped.
 */
function wrappedBulletTails(lines: string[]): string[][] {
  const tails: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('- ')) continue;
    let last: string | undefined;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') break;
      if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) || /^\s*#{1,6}\s/.test(line)) break;
      last = line;
    }
    if (last) {
      const tail = words(last).slice(-5);
      if (tail.length >= 4) tails.push(tail);
    }
    i = j - 1;
  }
  return tails;
}

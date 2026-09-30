import * as assert from 'assert';
import { summarizeMarkdown, stripMarkdown } from '../../../shared/markdownSummary';

/**
 * Workspace memory `.md` files are surfaced in the status panel; these tests
 * pin the parsing used to render the one-line preview next to each key.
 */
suite('markdownSummary', () => {
  test('uses the first content-bearing line', () => {
    const md = '\n\n# Project conventions\n\n- Use TypeScript strict mode';
    assert.strictEqual(summarizeMarkdown(md), 'Project conventions');
  });

  test('strips heading markers, emphasis and links', () => {
    assert.strictEqual(stripMarkdown('## Use `strict` mode *always*'), 'Use strict mode always');
    assert.strictEqual(stripMarkdown('- See [the guide](https://example.com)'), 'See the guide');
  });

  test('skips blank lines, horizontal rules and frontmatter', () => {
    const md = '---\ntitle: x\n---\n\n> Real content here';
    assert.strictEqual(summarizeMarkdown(md), 'Real content here');
    assert.strictEqual(summarizeMarkdown('---\n\n---\n\n# Heading'), 'Heading');
    assert.strictEqual(summarizeMarkdown('---\n# No closing fence'), 'No closing fence');
  });

  test('falls back to (empty) for whitespace-only content', () => {
    assert.strictEqual(summarizeMarkdown(''), '(empty)');
    assert.strictEqual(summarizeMarkdown('   \n\n\t'), '(empty)');
  });

  test('truncates long summaries with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const summary = summarizeMarkdown(long, 20);
    assert.strictEqual(summary.length, 20);
    assert.ok(summary.endsWith('…'));
  });

  test('handles CRLF line endings', () => {
    assert.strictEqual(summarizeMarkdown('# One\r\n# Two'), 'One');
  });
});

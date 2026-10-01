import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard: a user message typed over multiple lines must render on
// multiple lines.
//
// The bubble prints the raw message text into a <p>, and the default
// `white-space: normal` collapses every newline into a single space - a pasted
// stack trace or numbered list came out as one unreadable line. The fix is a
// `white-space: pre-wrap` on the user bubble's paragraph; these tests pin it so
// a future restyle can't silently drop it again.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_CSS = path.join(REPO_ROOT, 'src', 'webview-ui', 'src', 'styles', 'app.css');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** Body of a `selector { ... }` rule (first match), without the braces. */
function ruleBody(css: string, selectorRe: RegExp): string | null {
  const m = css.match(selectorRe);
  return m ? m[1] : null;
}

suite('Chat message styles — multi-line preservation', () => {
  test('the user message paragraph preserves authored line breaks', () => {
    const css = read(APP_CSS);
    const body = ruleBody(css, /\.message-user\s+\.message-content\s+p\s*\{([^}]*)\}/);
    assert.ok(body !== null, '.message-user .message-content p rule not found');
    assert.ok(
      /white-space:\s*pre-wrap/.test(body!),
      'user message paragraph is missing `white-space: pre-wrap` (newlines collapse to spaces)',
    );
  });
});

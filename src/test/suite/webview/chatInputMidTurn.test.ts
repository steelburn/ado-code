import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard: sending a message WHILE a turn is running must reach the
// host so it can steer/queue it against the live run.
//
// The host (App.handleSend) already routes mid-turn sends according to the
// `chatInputWhileBusy` setting, but InputBar.handleSend bailed out early with
// `if (loading) return;`, so pressing Enter during a run did nothing. These
// tests pin the InputBar side (no loading bail-out) and the host side (the
// steer/queue routing still exists) so the two can't drift apart again.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INPUT_BAR = path.join(REPO_ROOT, 'src', 'webview-ui', 'src', 'components', 'InputBar.tsx');
const APP = path.join(REPO_ROOT, 'src', 'webview-ui', 'src', 'App.tsx');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** Source of a `const <name> = useCallback((...) => { ... }, [...])` block. */
function arrowCallbackBlock(src: string, name: string): string | null {
  const start = src.indexOf(`const ${name} = useCallback`);
  if (start < 0) return null;
  // Walk braces from the first `{` after the opening paren.
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

suite('Chat input — sending mid-turn', () => {
  test('InputBar.handleSend does not bail out while a turn is running', () => {
    const block = arrowCallbackBlock(read(INPUT_BAR), 'handleSend');
    assert.ok(block, 'InputBar.handleSend callback not found');
    assert.ok(
      !/if\s*\(\s*loading\s*\)\s*return/.test(block!),
      'InputBar.handleSend still early-returns on `loading` (Enter does nothing mid-turn)',
    );
  });

  test('the host still routes mid-turn sends via steer/queue', () => {
    const app = read(APP);
    assert.ok(app.includes('inputWhileBusy'), 'App lost the `inputWhileBusy` routing');
    const block = arrowCallbackBlock(app, 'handleSend');
    assert.ok(block, 'App.handleSend callback not found');
    assert.ok(
      /steerNow\s*\(/.test(block!),
      'App.handleSend no longer steers mid-turn messages into the live run',
    );
  });
});

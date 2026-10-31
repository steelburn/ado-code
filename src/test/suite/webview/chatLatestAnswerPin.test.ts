import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard: picking "Latest answer" must PIN the chat to the bottom.
//
// The floating affordance used to jump with a one-shot smooth scroll whose own
// scroll events were read as "the reader scrolled up" - so following stopped a
// frame into the animation, the jump landed short of a still-streaming answer
// and the reader had to keep chasing the bottom. These tests pin the wiring
// that makes the jump sticky: only reader input may change the follow flag.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MESSAGE_LIST = path.join(
  REPO_ROOT,
  'src',
  'webview-ui',
  'src',
  'components',
  'MessageList.tsx',
);

function messageListSource(): string {
  return fs.readFileSync(MESSAGE_LIST, 'utf8');
}

suite('webview/MessageList - "Latest answer" pins the bottom', () => {
  test('the follow flag is resolved through the user-initiated rule', () => {
    const src = messageListSource();
    assert.ok(
      /stickToBottomRef\.current = resolveStickToBottom\(/.test(src),
      'handleScroll no longer routes the follow decision through resolveStickToBottom',
    );
  });

  test('a raw scroll event no longer unpins the view', () => {
    const src = messageListSource();
    assert.ok(
      !/stickToBottomRef\.current = !show;/.test(src),
      'handleScroll unpins on every scroll event again (programmatic scrolls included)',
    );
  });

  test('reader input marks the scroll as user initiated', () => {
    const src = messageListSource();
    for (const handler of ['onWheel', 'onTouchStart', 'onTouchMove', 'onKeyDown']) {
      assert.ok(
        new RegExp(handler + '=\\{markScrollIntent\\}').test(src),
        'the messages area does not mark scroll intent on ' + handler,
      );
    }
  });

  test('jumpToLatest re-pins and scrolls through scrollToBottom', () => {
    const src = messageListSource();
    const match = /const jumpToLatest = \(\) => \{([\s\S]*?)\n {2}\};/.exec(src);
    assert.ok(match, 'jumpToLatest is missing from MessageList');
    assert.ok(
      /stickToBottomRef\.current = true;/.test(match[1]),
      'jumpToLatest does not re-pin the view',
    );
    assert.ok(
      /scrollToBottom\('smooth'\)/.test(match[1]),
      'jumpToLatest does not scroll through scrollToBottom',
    );
  });
});

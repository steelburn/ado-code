import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseWizardConfigPayload } from '../../../shared/configSchema';

// The chat's one-click tool-call toggle (adoCode.chat.showToolCalls).
//
// Three pieces have to agree, or the kebab action silently lies: the webview
// must be able to persist the flip through updateConfig, the host must echo the
// value back (the menu item renders its state from the mirrored config), and
// MessageList must fold every tool card into the quiet disclosure. Each piece
// is pinned below.

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function read(...segments: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

function appSource(): string {
  return read('src', 'webview-ui', 'src', 'App.tsx');
}

function messageListSource(): string {
  return read('src', 'webview-ui', 'src', 'components', 'MessageList.tsx');
}

suite('webview/chat - one-click tool-call toggle', () => {
  test('updateConfig can persist chat.showToolCalls', () => {
    const { entries, ignored } = parseWizardConfigPayload({ chatShowToolCalls: false });
    assert.deepStrictEqual(ignored, [], 'chatShowToolCalls was rejected by the config schema');
    assert.deepStrictEqual(
      entries,
      [['chat.showToolCalls', false]],
      'chatShowToolCalls no longer round-trips to the adoCode.chat.showToolCalls setting',
    );
  });

  test('the sanitized config echoes the setting back to the webview', () => {
    const src = read('src', 'webview', 'ChatViewProvider.ts');
    assert.ok(
      /chatShowToolCalls: s\.chatShowToolCalls,/.test(src),
      'the webview cannot render the toggle state without the value in _sanitizedConfig',
    );
  });

  test('the kebab menu offers the toggle and asks the host to flip it', () => {
    const src = appSource();
    assert.ok(
      /label: `Tool calls: \$\{showToolCalls \? 'shown' : 'hidden'\}`,/.test(src),
      'the kebab menu no longer offers the tool-call toggle',
    );
    assert.ok(
      !/chat-header-toggle/.test(src),
      'a header toggle button came back - the kebab item must stay the only affordance',
    );
    assert.ok(
      /config: \{ chatShowToolCalls: !showToolCalls \}/.test(src),
      'the toggle no longer posts the flip through updateConfig',
    );
    assert.ok(
      /showToolCalls=\{showToolCalls\}/.test(src),
      'MessageList is no longer told about the toggle',
    );
  });

  test('the value defaults to shown and is derived from the mirrored config', () => {
    const src = appSource();
    assert.ok(
      /const showToolCalls = config\?\.chatShowToolCalls !== false;/.test(src),
      'showToolCalls must default to true (tool calls shown) when the host has no value',
    );
  });

  test('MessageList folds completed-turn tool cards away when the toggle is off', () => {
    const src = messageListSource();
    assert.ok(/showToolCalls\?: boolean;/.test(src), 'Props lost showToolCalls');
    assert.ok(/density = 'comfortable', showToolCalls = true \}: Props\)/.test(src), 'the prop defaults to shown');
    assert.ok(
      /\) : showToolCalls \? \(\s*<ToolActivityRow/.test(src),
      'the completed-turn trace no longer gates ToolActivityRow on showToolCalls',
    );
    assert.ok(
      /\) : \(\s*<HiddenToolCalls key=\{`act-\$\{j\}`\} calls=\{seg\.calls\} live=\{loading\} \/>/.test(src),
      'hidden tool calls are no longer folded into the HiddenToolCalls disclosure',
    );
  });

  test('MessageList folds fence-parsed and live tool cards away too', () => {
    const src = messageListSource();
    assert.ok(
      /showToolCalls \? \(\s*toolCalls\.map\(\(tc\) => \(/.test(src),
      'fence-parsed tool cards ignore the toggle',
    );
    assert.ok(
      /<HiddenToolCalls calls=\{toolCalls\} live=\{loading\} \/>/.test(src),
      'fence-parsed tool cards do not fall back to the hidden disclosure',
    );
    assert.ok(
      /seg\.kind === 'thinking' \|\| \(showToolCalls && seg\.call\.showDetails !== false\)/.test(src),
      'the live trace keeps rendering tool cards while the toggle is off',
    );
    assert.ok(
      /\(!showToolCalls \|\| liveTrace\.some\(seg => seg\.kind === 'tool' && seg\.call\.showDetails === false\)\)/.test(src),
      'the live hidden-calls disclosure does not open when the toggle is off',
    );
  });

  test('a finished turn still folds its tools away without claiming to run', () => {
    const src = messageListSource();
    // A completed turn renders through HiddenToolCalls too (persisted trace
    // while the toggle is off), so its header must derive "working" from the
    // calls instead of assuming a live turn.
    assert.ok(
      /const busy = live && doneCount < calls\.length;/.test(src),
      'HiddenToolCalls lost its busy flag - a restored turn would spin forever',
    );
    assert.ok(
      /\{busy && <div className="activity-spinner" \/>\}/.test(src),
      'the hidden-calls spinner is no longer gated on busy',
    );
    assert.ok(
      /\{busy \? 'Working…' : 'Done'\}/.test(src),
      'the hidden-calls label is no longer conditional',
    );
  });

  test('no tool card claims to be running once the turn is over', () => {
    // Liveness is per-TURN information: `live` is the host turn flag threaded
    // into every card. A trace restored from an aborted or crashed turn - or a
    // result frame lost after the turn ended - has no live turn behind it and
    // must therefore render as finished instead of spinning forever.
    const src = messageListSource();
    assert.ok(
      /const done = !live \|\| !!tc\.done \|\| tc\.result !== undefined;/.test(src),
      'ToolCallBlock derives running from the call alone - a stale entry would spin forever',
    );
    assert.ok(
      /const done = !live \|\| tc\.done \|\| !!tc\.result;/.test(src),
      'the hidden-call rows ignore the turn flag',
    );
    assert.ok(
      /const doneCount = live \? calls\.filter/.test(src),
      'the hidden-call header counts unfinished calls while no turn is live',
    );
    const status = read('src', 'webview-ui', 'src', 'components', 'StatusLine.tsx');
    assert.ok(
      /if \(!loading\) return null;/.test(status),
      'the status line paints a leftover running-tools line after the turn ended',
    );
  });

  test('a turn that ends records every tool call as finished', () => {
    const src = appSource();
    assert.ok(
      !/done: seg\.call\.done,/.test(src),
      'the turn trace still copies the live done flag - a call whose result never arrived would restore as a spinner',
    );
    assert.ok(
      /never reported back must not restore from history as a spinner[\s\S]{0,120}done: true,/.test(src),
      'the finished-turn trace no longer forces done:true on every recorded call',
    );
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard: "the agent is still calling tools but the chat box already
// shows the paper-airplane (Send) button".
//
// The Stop/Send icon is driven by ONE boolean, and the webview's `loading` state
// is written from five places. Several of them are not turn lifecycle at all —
// a work-item refresh, a failed project/model fetch, a delegated agent run
// finishing — yet they all post/derive `loading:false` on the same channel while
// the host's agentic loop keeps executing tool calls. These tests pin:
//
//   1. the button state is DERIVED (turn flag OR the session that owns the run),
//   2. the stray clears are guarded instead of ending the turn UI,
//   3. the host's non-turn subsystems never post on the turn channel mid-turn.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP = path.join(REPO_ROOT, 'src', 'webview-ui', 'src', 'App.tsx');
const PROVIDER = path.join(REPO_ROOT, 'src', 'webview', 'ChatViewProvider.ts');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** Slice a brace-balanced block starting at the first `{` at/after `from`. */
function braceBlock(src: string, from: number): string | null {
  const start = src.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

/** Body of `case '<name>':` up to the next `case` at the same indent. */
function caseBlock(src: string, name: string): string | null {
  const start = src.indexOf(`case '${name}':`);
  if (start < 0) return null;
  const next = src.indexOf("\n        case '", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

suite('Chat turn indicator — no premature "done"', () => {
  test('the Stop/Send button is derived from loading OR the owning session run', () => {
    const app = read(APP);
    assert.ok(
      /const isBusy = loading \|\| \(sessionRun !== null && sessionRun\.id === activeSessionId\);/.test(app),
      'App lost the derived isBusy flag (host turn flag OR the session that owns the in-flight run)',
    );
    const at = app.lastIndexOf('loading={');
    assert.ok(at > 0, 'InputBar loading prop not found');
    const expr = app.slice(at, app.indexOf('}', at) + 1);
    assert.ok(
      /isBusy \? mode/.test(expr),
      'InputBar no longer takes the derived flag, so a stray loading:false flips the button back to Send',
    );
    assert.ok(
      !/loading \? mode/.test(expr),
      'InputBar is back on the raw turn flag',
    );
  });

  test('send-while-busy routing uses the derived flag, not the raw one', () => {
    const app = read(APP);
    assert.ok(
      !/if \(loading && inputWhileBusy === '(queue|steer)'\)/.test(app),
      'queue/steer routing keys off the raw flag — a stray clear lets a mid-turn message start a SECOND turn',
    );
    assert.ok(
      /if \(isBusy \|\| queued\.length === 0\) return;/.test(app),
      'the queue drain must wait for the derived flag, otherwise it launches while the turn is still live',
    );
  });

  test('a delegated run finishing (agentResult) does not end the turn UI', () => {
    const block = caseBlock(read(APP), 'agentResult');
    assert.ok(block, "App lost the agentResult case");
    assert.ok(
      !/setLoading\s*\(/.test(block!),
      'agentResult clears the turn spinner directly — a delegated run completing is not the end of the chat turn that spawned it',
    );
    assert.ok(
      /clearTurnLoading\s*\(/.test(block!),
      'agentResult should route through the guarded clearTurnLoading()',
    );
  });

  test("the shared 'loading' channel is guarded while a turn runs", () => {
    const block = caseBlock(read(APP), 'loading');
    assert.ok(block, "App lost the loading case");
    assert.ok(
      !/^\s*setLoading\(msg\.loading\);/m.test(block!),
      "setLoading(msg.loading) is applied verbatim — the work-item refresher shares this channel",
    );
    assert.ok(
      /clearTurnLoading\s*\(/.test(block!),
      "a `loading:false` from a non-turn subsystem must go through clearTurnLoading()",
    );
  });

  test('sessionRunState ends the turn UI (and keeps the button from sticking)', () => {
    const block = caseBlock(read(APP), 'sessionRunState');
    assert.ok(block, "App lost the sessionRunState case");
    assert.ok(
      /applySessionRun\s*\(/.test(block!),
      'sessionRunState must update the run mirror used by the message handler',
    );
    assert.ok(
      /!\s*runState\s*\|/.test(block!) && /setLoading\(false\)/.test(block!),
      'a null (or foreign) run must clear loading, otherwise Stop sticks forever',
    );
  });

  test('guard exists, consults the run mirror, and uses a stable ref', () => {
    const app = read(APP);
    for (const name of ['applySessionRun', 'turnRunningHere', 'clearTurnLoading']) {
      const at = app.indexOf(`const ${name} = useCallback`);
      assert.ok(at > 0, `App lost the ${name} helper`);
      const block = braceBlock(app, at);
      assert.ok(block, `${name} block not parseable`);
      if (name === 'clearTurnLoading') {
        assert.ok(
          /turnRunningHere\(\)/.test(block!),
          'clearTurnLoading no longer checks whether a turn owns the visible session',
        );
      }
    }
    assert.ok(
      /const sessionRunRef = useRef<SessionRunInfo \| null>/.test(app),
      'the message handler needs a session-run ref (it closes over stale state)',
    );
  });

  test('the optimistic onStop no longer clears the spinner', () => {
    const app = read(APP);
    const at = app.indexOf("vscode.postMessage({ type: 'stopGeneration' });");
    assert.ok(at > 0, 'onStop handler not found');
    const body = app.slice(at, app.indexOf('setConsent(null)', at));
    // Strip comments: the handler's own comment explains what it must NOT do.
    const code = body.replace(/\/\/[^\n]*/g, '');
    assert.ok(
      !/\bsetLoading\(false\)/.test(code),
      'onStop clears loading before the host confirms — the Stop button turns back into Send while tools still run',
    );
  });

  test('refreshWorkItems never touches the turn channel mid-turn', () => {
    const src = read(PROVIDER);
    const at = src.indexOf('async refreshWorkItems(');
    assert.ok(at > 0, 'refreshWorkItems not found');
    const block = braceBlock(src, at);
    assert.ok(block, 'refreshWorkItems block not parseable');
    const posts = block!
      .split(/\r?\n/)
      .filter(line => /type: 'loading'/.test(line));
    assert.ok(posts.length > 0, 'expected the work-item refresh to post a loading flag');
    for (const post of posts) {
      assert.ok(
        /if\s*\(!this\.isBusyProcessing\(\)\)/.test(post),
        `unguarded turn-channel post in refreshWorkItems: ${post.trim()}`,
      );
    }
    assert.ok(
      /private isBusyProcessing\(\): boolean \{[\s\S]{0,200}runningTurnSession[\s\S]{0,80}workingDepth/.test(src),
      'isBusyProcessing must consider both the LLM turn and delegated agent runs',
    );
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { SessionMirror } from '../../../webview/SessionMirror';
import type { Session } from '../../../shared/messages';
import { makeScratchDir } from '../utils/scratchDir';

/** A session whose transcript is the supplied texts, alternating user/assistant. */
function makeSession(id: string, texts: string[], createdAt = '2025-01-01T00:00:00.000Z'): Session {
  return {
    id,
    name: id,
    createdAt,
    messages: texts.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content })),
  };
}

function tempDir(): string {
  return makeScratchDir('ado-session-mirror-');
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

suite('SessionMirror · durable session mirror', () => {
  let dir: string;
  let mirror: SessionMirror;

  setup(() => {
    dir = tempDir();
    mirror = new SessionMirror(() => dir, () => 'test-folder');
  });

  teardown(() => cleanup(dir));

  test('round-trips the sessions and the active pointer', () => {
    const sessions = [makeSession('a', ['hi', 'hello']), makeSession('b', ['other'])];
    mirror.write(sessions, 'b');

    const restored = mirror.read();
    assert.ok(restored, 'mirror readable');
    assert.deepStrictEqual(
      restored!.sessions.map(s => s.id).sort(),
      ['a', 'b'],
    );
    assert.deepStrictEqual(restored!.sessions.find(s => s.id === 'a')!.messages.map(m => m.content), [
      'hi',
      'hello',
    ]);
    assert.strictEqual(restored!.activeSessionId, 'b');
  });

  test('files are written atomically — no temp files survive', () => {
    mirror.write([makeSession('a', ['hi'])], 'a');
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'no partial writes left behind');
  });

  test('a corrupt index reads as "no mirror" instead of throwing', () => {
    mirror.write([makeSession('a', ['hi'])], 'a');
    fs.writeFileSync(path.join(dir, 'index.json'), '{not json', 'utf8');
    assert.strictEqual(mirror.read(), undefined);
  });

  test('a session whose file vanished is skipped, not fatal', () => {
    mirror.write([makeSession('a', ['hi']), makeSession('b', ['yo'])], 'a');
    fs.unlinkSync(path.join(dir, 'b.json'));
    const restored = mirror.read();
    assert.ok(restored);
    assert.deepStrictEqual(
      restored!.sessions.map(s => s.id),
      ['a'],
    );
  });

  test('deleted sessions are pruned from disk and from the mirror index', () => {
    mirror.write([makeSession('a', ['hi']), makeSession('b', ['yo'])], 'a');
    mirror.write([makeSession('a', ['hi'])], 'a');

    assert.ok(!fs.existsSync(path.join(dir, 'b.json')), 'stale session file removed');
    const restored = mirror.read();
    assert.deepStrictEqual(
      restored!.sessions.map(s => s.id),
      ['a'],
    );
  });

  test('writePointer records the active session and leaves transcripts alone', () => {
    mirror.write([makeSession('a', ['hi']), makeSession('b', ['yo'])], 'a');
    const onDisk = fs.readFileSync(path.join(dir, 'b.json'), 'utf8');

    mirror.writePointer('b');

    assert.strictEqual(mirror.read()?.activeSessionId, 'b');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), onDisk);
  });

  test('a pointerless list write keeps the last committed pointer', () => {
    mirror.write([makeSession('a', ['hi']), makeSession('b', ['yo'])], 'b');

    // The provider writes the list BEFORE it settles the active session, so a
    // shutdown in that window must not erase the pointer.
    mirror.write([makeSession('a', ['hi']), makeSession('b', ['yo', 'more'])], undefined);

    assert.strictEqual(mirror.read()?.activeSessionId, 'b');
  });

  test('writePointer with an empty id clears the pointer', () => {
    mirror.write([makeSession('a', ['hi'])], 'a');

    mirror.writePointer('');

    assert.strictEqual(mirror.read()?.activeSessionId, undefined);
  });

  test('a carried-over pointer whose session is gone is dropped', () => {
    mirror.write([makeSession('a', ['hi']), makeSession('b', ['yo'])], 'b');

    mirror.write([makeSession('a', ['hi'])], undefined);

    assert.strictEqual(mirror.read()?.activeSessionId, undefined);
  });

  test('writePointer before the first write is kept for the next write', () => {
    mirror.writePointer('a');

    mirror.write([makeSession('a', ['hi'])], undefined);

    assert.strictEqual(mirror.read()?.activeSessionId, 'a');
  });

  test('mirroring is disabled without a directory (no folder open)', () => {
    const disabled = new SessionMirror(() => undefined);
    disabled.write([makeSession('a', ['hi'])], 'a');
    assert.strictEqual(disabled.read(), undefined);
  });
});

suite('SessionMirror.merge · mirror vs Memento', () => {
  test('a mirrored transcript with MORE messages wins (crashed mid-turn)', () => {
    const stored = makeSession('a', ['question', 'partial answer']);
    const mirrored = makeSession('a', ['question', 'partial answer', 'more work']);

    const merged = SessionMirror.merge([stored], [mirrored], 'a', 'a');
    assert.deepStrictEqual(merged.replaced, ['a']);
    assert.strictEqual(merged.sessions[0].messages.length, 3, 'mirror copy adopted');
  });

  test('an equal-length mirror does NOT win (keeps renames / approvals)', () => {
    const stored: Session = { ...makeSession('a', ['question', 'answer']), name: 'Renamed by user' };
    const mirrored = makeSession('a', ['question', 'answer']);

    const merged = SessionMirror.merge([stored], [mirrored], 'a', 'a');
    assert.deepStrictEqual(merged.replaced, []);
    assert.strictEqual(merged.sessions[0].name, 'Renamed by user');
  });

  test('a shorter mirror never truncates stored history', () => {
    const stored = makeSession('a', ['q', 'a1', 'q2', 'a2']);
    const mirrored = makeSession('a', ['q', 'a1']);

    const merged = SessionMirror.merge([stored], [mirrored], 'a', 'a');
    assert.strictEqual(merged.sessions[0].messages.length, 4);
  });

  test('sessions that only exist on disk are added, in creation order', () => {
    const stored = makeSession('new', ['q'], '2025-05-01T00:00:00.000Z');
    const mirrored = [
      makeSession('old', ['q'], '2025-01-01T00:00:00.000Z'),
      makeSession('new', ['q'], '2025-05-01T00:00:00.000Z'),
    ];

    const merged = SessionMirror.merge([stored], mirrored, 'new', 'new');
    assert.deepStrictEqual(merged.added, ['old']);
    assert.deepStrictEqual(
      merged.sessions.map(s => s.id),
      ['old', 'new'],
      'history dropdown stays in creation order',
    );
  });

  test('the active pointer is repaired from the mirror when the session exists', () => {
    const merged = SessionMirror.merge([makeSession('a', ['q'])], [], undefined, 'a');
    assert.strictEqual(merged.activeSessionId, 'a');
  });

  test('a mirrored active pointer at a deleted session is ignored', () => {
    const merged = SessionMirror.merge([makeSession('a', ['q'])], [], 'a', 'gone');
    assert.strictEqual(merged.activeSessionId, 'a');
  });
});

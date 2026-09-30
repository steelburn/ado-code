import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TodoStore,
  normalizeTodoItems,
  normalizeGoalText,
  renderTodoChecklist,
  summarizeTodoList,
  MAX_TODO_ITEMS,
  MAX_TODO_ITEM_CHARS,
  MAX_TODO_GOAL_CHARS,
} from '../../../services/todo/TodoStore';

suite('TodoStore', () => {
  let tmpDir: string;
  let store: TodoStore;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-todos-'));
    store = new TodoStore(tmpDir);
  });

  teardown(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort: Windows may briefly hold a handle */
    }
  });

  // ── Storage layout ────────────────────────────────────────────────

  test('getDir points at .ado-code/todos under the workspace', () => {
    assert.strictEqual(store.getDir(), path.join(tmpDir, '.ado-code', 'todos'));
  });

  test('read returns null for a session with no list', () => {
    assert.strictEqual(store.read('session-a'), null);
  });

  test('replace then read round-trips the list', () => {
    store.replace('session-a', [
      { content: 'Write the store', status: 'completed' },
      { content: 'Write the view', status: 'in_progress' },
      { content: 'Write the tests', status: 'pending' },
    ], 'My Session');

    const list = store.read('session-a');
    assert.ok(list, 'list should exist');
    assert.strictEqual(list!.sessionId, 'session-a');
    assert.strictEqual(list!.sessionName, 'My Session');
    assert.strictEqual(list!.items.length, 3);
    assert.deepStrictEqual(list!.items.map(i => i.status), ['completed', 'in_progress', 'pending']);
    assert.strictEqual(list!.items[0]!.content, 'Write the store');
  });

  test('lists are isolated per session', () => {
    store.replace('session-a', [{ content: 'A task', status: 'pending' }], 'A');
    store.replace('session-b', [{ content: 'B task', status: 'pending' }], 'B');

    assert.strictEqual(store.read('session-a')!.items[0]!.content, 'A task');
    assert.strictEqual(store.read('session-b')!.items[0]!.content, 'B task');
  });

  test('session ids that are not filename-safe still round-trip', () => {
    // Real session ids are ISO timestamps, which contain ':' (illegal on Windows).
    const iso = '2026-09-30T16:38:27.123Z';
    store.replace(iso, [{ content: 'Timestamped', status: 'pending' }], 'ISO');
    assert.strictEqual(store.read(iso)!.items[0]!.content, 'Timestamped');

    // Two ids sharing a long prefix must not collide on the slug cut-off.
    const long1 = 'x'.repeat(80) + '-one';
    const long2 = 'x'.repeat(80) + '-two';
    store.replace(long1, [{ content: 'First', status: 'pending' }], 'One');
    store.replace(long2, [{ content: 'Second', status: 'pending' }], 'Two');
    assert.strictEqual(store.read(long1)!.items[0]!.content, 'First');
    assert.strictEqual(store.read(long2)!.items[0]!.content, 'Second');
  });

  test('reads a corrupt file as null instead of throwing', () => {
    store.init();
    fs.writeFileSync(path.join(store.getDir(), 'broken-00000000.json'), '{not json', 'utf8');
    assert.strictEqual(store.read('broken'), null);
    // list() skips the corrupt file rather than failing the whole tree.
    assert.deepStrictEqual(store.list(), []);
  });

  // ── Item normalization (untrusted tool input) ─────────────────────

  test('normalizeTodoItems drops blanks, dedupes and coerces bad statuses', () => {
    const items = normalizeTodoItems([
      { content: 'Keep me', status: 'completed' },
      { content: '   ', status: 'pending' },
      { content: 'Keep me', status: 'pending' },          // duplicate content
      { content: 'Unknown status', status: 'banana' },     // coerced
      'a bare string item',
      null,
      { status: 'pending' },                               // no content
      { content: 'Multi\nline\ttask', status: 'in_progress' },
    ]);

    assert.deepStrictEqual(items.map(i => i.content), [
      'Keep me',
      'Unknown status',
      'a bare string item',
      'Multi line task',
    ]);
    assert.deepStrictEqual(items.map(i => i.status), [
      'completed',
      'pending',
      'pending',
      'in_progress',
    ]);
  });

  test('normalizeTodoItems caps the item count and label length', () => {
    const many = Array.from({ length: MAX_TODO_ITEMS + 20 }, (_, i) => ({ content: `item ${i}`, status: 'pending' }));
    assert.strictEqual(normalizeTodoItems(many).length, MAX_TODO_ITEMS);

    const long = normalizeTodoItems([{ content: 'y'.repeat(MAX_TODO_ITEM_CHARS + 100), status: 'pending' }]);
    assert.strictEqual(long[0]!.content.length, MAX_TODO_ITEM_CHARS);
  });

  test('normalizeTodoItems ids are stable across calls with the same content', () => {
    const first = normalizeTodoItems([{ content: 'Stable item', status: 'pending' }]);
    const second = normalizeTodoItems([{ content: 'Stable item', status: 'completed' }]);
    assert.strictEqual(first[0]!.id, second[0]!.id, 'the id must survive a status change');
  });

  test('normalizeTodoItems returns an empty list for non-array input', () => {
    assert.deepStrictEqual(normalizeTodoItems(undefined), []);
    assert.deepStrictEqual(normalizeTodoItems('nope'), []);
    assert.deepStrictEqual(normalizeTodoItems({ todos: [] }), []);
  });

  // ── Status transitions ────────────────────────────────────────────

  test('setStatus ticks an item off and back on', () => {
    const list = store.replace('s', [{ content: 'Tick me', status: 'pending' }], 'S');
    const id = list.items[0]!.id;

    store.setStatus('s', id, 'completed');
    assert.strictEqual(store.read('s')!.items[0]!.status, 'completed');

    store.setStatus('s', id, 'pending');
    assert.strictEqual(store.read('s')!.items[0]!.status, 'pending');
  });

  test('setStatus on an unknown session or item is a no-op', () => {
    assert.strictEqual(store.setStatus('missing', 'it-1', 'completed'), null);
    const list = store.replace('s', [{ content: 'Only', status: 'pending' }], 'S');
    store.setStatus('s', 'it-nope', 'completed');
    assert.strictEqual(store.read('s')!.items.length, 1);
    assert.strictEqual(store.read('s')!.items[0]!.id, list.items[0]!.id);
  });

  test('addItem appends without duplicating an existing label', () => {
    store.replace('s', [{ content: 'Existing', status: 'pending' }], 'S');
    store.addItem('s', 'Existing');
    store.addItem('s', 'Brand new');

    const items = store.read('s')!.items;
    assert.deepStrictEqual(items.map(i => i.content), ['Existing', 'Brand new']);
  });

  test('addItem creates a list when the session has none', () => {
    store.addItem('fresh', 'First ever', 'Fresh');
    const list = store.read('fresh');
    assert.ok(list);
    assert.strictEqual(list!.sessionName, 'Fresh');
    assert.strictEqual(list!.items.length, 1);
  });

  test('removeItem deletes the file once the last item goes', () => {
    const list = store.replace('s', [{ content: 'Only one', status: 'pending' }], 'S');
    assert.strictEqual(store.removeItem('s', list.items[0]!.id), null);
    assert.strictEqual(store.read('s'), null, 'an emptied list must not linger as an empty file');
  });

  test('removeItem keeps the rest of the list', () => {
    const list = store.replace('s', [
      { content: 'One', status: 'pending' },
      { content: 'Two', status: 'completed' },
    ], 'S');

    store.removeItem('s', list.items[0]!.id);
    const after = store.read('s');
    assert.ok(after);
    assert.deepStrictEqual(after!.items.map(i => i.content), ['Two']);
  });

  // ── Session lifecycle ─────────────────────────────────────────────

  test('setActiveSession tracks the live session and fires only on change', () => {
    let fires = 0;
    store.onDidChange(() => { fires++; });

    store.setActiveSession('a', 'A');
    assert.strictEqual(store.getActiveSessionId(), 'a');
    assert.strictEqual(fires, 1);

    store.setActiveSession('a', 'A');
    assert.strictEqual(fires, 1, 're-selecting the same session must not re-render');

    store.setActiveSession('b', 'B');
    assert.strictEqual(fires, 2);
  });

  test('setActiveSession refreshes a stored session name (rename)', () => {
    store.replace('a', [{ content: 'Task', status: 'pending' }], 'Old Name');
    store.setActiveSession('a', 'New Name');
    assert.strictEqual(store.read('a')!.sessionName, 'New Name');
  });

  test('rename updates the stored list name', () => {
    store.replace('a', [{ content: 'Task', status: 'pending' }], 'Old');
    store.rename('a', 'Renamed');
    assert.strictEqual(store.read('a')!.sessionName, 'Renamed');
  });

  test('rename is a no-op for a session with no list', () => {
    assert.doesNotThrow(() => store.rename('none', 'Whatever'));
  });

  test('remove deletes one session and reports whether it existed', () => {
    store.replace('a', [{ content: 'A', status: 'pending' }], 'A');
    assert.strictEqual(store.remove('a'), true);
    assert.strictEqual(store.read('a'), null);
    assert.strictEqual(store.remove('a'), false);
  });

  test('removeAll wipes every session list', () => {
    store.replace('a', [{ content: 'A', status: 'pending' }], 'A');
    store.replace('b', [{ content: 'B', status: 'pending' }], 'B');

    assert.strictEqual(store.removeAll(), 2);
    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(store.removeAll(), 0);
  });

  test('list returns every stored list, newest first', async () => {
    store.replace('old', [{ content: 'Old', status: 'pending' }], 'Old');
    // updatedAt has millisecond resolution — leave a clear gap between writes
    // so the ordering assertion can't tie.
    await new Promise(r => setTimeout(r, 20));
    store.replace('new', [{ content: 'New', status: 'pending' }], 'New');

    const lists = store.list();
    assert.deepStrictEqual(lists.map(l => l.sessionId), ['new', 'old']);
    for (let i = 1; i < lists.length; i++) {
      assert.ok(lists[i - 1]!.updatedAt >= lists[i]!.updatedAt, 'list must be sorted newest-first');
    }
  });

  // ── Summary / rendering ───────────────────────────────────────────

  test('summary counts completed and in-progress items', () => {
    store.replace('s', [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'completed' },
      { content: 'C', status: 'in_progress' },
      { content: 'D', status: 'pending' },
    ], 'S');

    const summary = store.summary('s');
    assert.ok(summary);
    assert.strictEqual(summary!.total, 4);
    assert.strictEqual(summary!.completed, 2);
    assert.strictEqual(summary!.inProgress, 1);
  });

  test('summarizeTodoList works on a plain list', () => {
    const summary = summarizeTodoList({
      sessionId: 's',
      sessionName: 'S',
      updatedAt: new Date().toISOString(),
      items: [{ id: 'it-1', content: 'A', status: 'completed' }],
    });
    assert.strictEqual(summary.total, 1);
    assert.strictEqual(summary.completed, 1);
    assert.strictEqual(summary.inProgress, 0);
  });

  test('renderTodoChecklist marks each status distinctly', () => {
    const text = renderTodoChecklist({
      sessionId: 's',
      sessionName: 'S',
      updatedAt: new Date().toISOString(),
      items: [
        { id: 'it-1', content: 'Done thing', status: 'completed' },
        { id: 'it-2', content: 'Running thing', status: 'in_progress', activeForm: 'Running it' },
        { id: 'it-3', content: 'Todo thing', status: 'pending' },
      ],
    });

    assert.ok(text.includes('- [x] Done thing'));
    assert.ok(text.includes('- [~] Running thing'));
    assert.ok(text.includes('Running it'), 'the active form should be surfaced');
    assert.ok(text.includes('- [ ] Todo thing'));
    assert.ok(text.includes('Progress: 1/3 completed'));
  });

  test('renderTodoChecklist says so when the list is empty', () => {
    assert.ok(renderTodoChecklist({
      sessionId: 's', sessionName: 'S', updatedAt: new Date().toISOString(), items: [],
    }).includes('empty'));
  });

  // ── Prompt injection ──────────────────────────────────────────────

  test('toPromptString is empty when there is nothing to inject', () => {
    assert.strictEqual(store.toPromptString('session-a'), '');
    assert.strictEqual(store.toPromptString(null), '');
  });

  test('toPromptString renders the live checklist for the session', () => {
    store.replace('a', [
      { content: 'Finished step', status: 'completed' },
      { content: 'Next step', status: 'pending' },
    ], 'A');

    const prompt = store.toPromptString('a');
    assert.ok(prompt.startsWith('## Current To-do List (this session)'));
    assert.ok(prompt.includes('- [x] Finished step'));
    assert.ok(prompt.includes('- [ ] Next step'));
  });

  test('toPromptString defaults to the active session', () => {
    store.replace('a', [{ content: 'Active work', status: 'pending' }], 'A');
    store.setActiveSession('a', 'A');
    assert.ok(store.toPromptString().includes('- [ ] Active work'));
  });

  test('hasAny reflects whether any session has items', () => {
    assert.strictEqual(store.hasAny(), false);
    store.replace('a', [{ content: 'A', status: 'pending' }], 'A');
    assert.strictEqual(store.hasAny(), true);
  });

  // ── Goal ──────────────────────────────────────────────────────────

  test('setGoal creates the session file before any steps exist', () => {
    const list = store.setGoal('g', 'Ship the feature', 'ai', 'Goal Session');
    assert.ok(list, 'a goal must be persistable without items');
    assert.strictEqual(list!.items.length, 0);
    assert.strictEqual(list!.goal!.text, 'Ship the feature');
    assert.strictEqual(list!.goal!.source, 'ai');
    assert.strictEqual(list!.sessionName, 'Goal Session');
    assert.ok(list!.goal!.setAt, 'setAt is stamped');
  });

  test('setGoal round-trips through read', () => {
    store.setGoal('g', 'Ship the feature', 'user', 'G');
    const read = store.read('g');
    assert.strictEqual(read!.goal!.text, 'Ship the feature');
    assert.strictEqual(read!.goal!.source, 'user');
  });

  test('setGoal replaces an existing goal in place', () => {
    store.setGoal('g', 'First objective', 'ai', 'G');
    store.setGoal('g', 'Second objective', 'user', 'G');
    assert.strictEqual(store.read('g')!.goal!.text, 'Second objective');
    assert.strictEqual(store.read('g')!.goal!.source, 'user');
  });

  test('setGoal with empty text clears the goal', () => {
    store.setGoal('g', 'Ship it', 'ai', 'G');
    store.setGoal('g', '', 'ai', 'G');
    assert.strictEqual(store.read('g'), null, 'a goal-only file disappears when the goal goes');
  });

  test('normalizeGoalText collapses whitespace and caps length', () => {
    assert.strictEqual(normalizeGoalText('  Ship\n\nthe   feature  '), 'Ship the feature');
    assert.strictEqual(normalizeGoalText('z'.repeat(MAX_TODO_GOAL_CHARS + 50)).length, MAX_TODO_GOAL_CHARS);
    for (const bad of [undefined, null, 42, {}, []]) assert.strictEqual(normalizeGoalText(bad), '');
  });

  test('replace (the AI list rewrite) PRESERVES the goal', () => {
    store.setGoal('g', 'Ship the feature', 'ai', 'G');
    store.replace('g', [{ content: 'Step one', status: 'pending' }], 'G');
    assert.strictEqual(store.read('g')!.goal!.text, 'Ship the feature', 'rewriting steps must not drop the objective');
  });

  test('setStatus and addItem preserve the goal', () => {
    store.setGoal('g', 'Ship the feature', 'ai', 'G');
    const list = store.replace('g', [{ content: 'Step one', status: 'pending' }], 'G');
    store.setStatus('g', list.items[0]!.id, 'completed');
    store.addItem('g', 'Step two');
    assert.strictEqual(store.read('g')!.goal!.text, 'Ship the feature');
  });

  test('clearGoal keeps the items', () => {
    store.replace('g', [{ content: 'Step one', status: 'pending' }], 'G');
    store.setGoal('g', 'Ship the feature', 'ai', 'G');
    const after = store.clearGoal('g');
    assert.ok(after);
    assert.strictEqual(after!.goal, undefined);
    assert.strictEqual(after!.items.length, 1, 'clearing the goal must not delete the steps');
  });

  test('clearGoal deletes a goal-only file', () => {
    store.setGoal('g', 'Only a goal', 'ai', 'G');
    assert.strictEqual(store.clearGoal('g'), null);
    assert.strictEqual(store.read('g'), null);
  });

  test('clearGoal on a session without a goal is a no-op', () => {
    store.replace('g', [{ content: 'Step', status: 'pending' }], 'G');
    const after = store.clearGoal('g');
    assert.strictEqual(after!.items.length, 1);
  });

  test('removeItem keeps the file while a goal remains', () => {
    store.replace('g', [{ content: 'Only step', status: 'pending' }], 'G');
    store.setGoal('g', 'Ship the feature', 'ai', 'G');
    const remaining = store.removeItem('g', store.read('g')!.items[0]!.id);
    assert.ok(remaining, 'the objective must survive losing its last step');
    assert.strictEqual(remaining!.items.length, 0);
    assert.strictEqual(store.read('g')!.goal!.text, 'Ship the feature');
  });

  test('list and hasAny include goal-only sessions', () => {
    assert.strictEqual(store.hasAny(), false);
    store.setGoal('g', 'Only a goal', 'ai', 'G');
    assert.strictEqual(store.hasAny(), true, 'a goal alone is worth showing');
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.list()[0]!.goal!.text, 'Only a goal');
  });

  test('summary exposes the goal', () => {
    store.replace('g', [{ content: 'Step', status: 'pending' }], 'G');
    store.setGoal('g', 'Ship the feature', 'ai', 'G');
    assert.strictEqual(store.summary('g')!.goal!.text, 'Ship the feature');
  });

  test('toPromptString includes the goal above the checklist', () => {
    store.replace('g', [{ content: 'Next step', status: 'pending' }], 'G');
    store.setGoal('g', 'Ship the feature', 'ai', 'G');
    const prompt = store.toPromptString('g');
    assert.ok(prompt.includes('**Goal:** Ship the feature'));
    assert.ok(prompt.indexOf('**Goal:**') < prompt.indexOf('- [ ] Next step'), 'goal precedes the steps');
  });

  test('toPromptString injects a goal-only session', () => {
    store.setGoal('g', 'Only a goal', 'ai', 'G');
    const prompt = store.toPromptString('g');
    assert.ok(prompt.includes('**Goal:** Only a goal'));
    assert.ok(prompt.includes('empty'), 'the step list is reported as empty');
  });

  test('a malformed goal in the file is ignored rather than crashing', () => {
    store.init();
    const file = fs.readdirSync(store.getDir())[0];
    assert.strictEqual(file, undefined, 'nothing stored yet');
    store.setGoal('g', 'Real goal', 'ai', 'G');
    // Hand-corrupt the goal shape the way a partial write would.
    const stored = fs.readdirSync(store.getDir())[0]!;
    const raw = JSON.parse(fs.readFileSync(path.join(store.getDir(), stored), 'utf8'));
    raw.goal = { text: '   ', source: 'bogus' };
    fs.writeFileSync(path.join(store.getDir(), stored), JSON.stringify(raw), 'utf8');
    assert.strictEqual(store.read('g')!.goal, undefined, 'a blank goal reads as no goal');
  });

  test('an unknown goal source degrades to ai', () => {
    store.setGoal('g', 'Real goal', 'ai', 'G');
    const stored = fs.readdirSync(store.getDir())[0]!;
    const raw = JSON.parse(fs.readFileSync(path.join(store.getDir(), stored), 'utf8'));
    raw.goal.source = 'somebody-else';
    fs.writeFileSync(path.join(store.getDir(), stored), JSON.stringify(raw), 'utf8');
    assert.strictEqual(store.read('g')!.goal!.source, 'ai');
  });
});

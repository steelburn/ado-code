import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TodoStore } from '../../../services/todo/TodoStore';
import {
  TodoTreeProvider,
  TodoSessionNode,
  TodoItemNode,
  TodoEmptyNode,
} from '../../../webview/TodoTreeProvider';

suite('TodoTreeProvider', () => {
  let tmpDir: string;
  let store: TodoStore;
  let provider: TodoTreeProvider;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-todotree-'));
    store = new TodoStore(tmpDir);
    provider = new TodoTreeProvider(store);
  });

  teardown(() => {
    provider.dispose();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort on Windows */
    }
  });

  /** Shortcut: the current root nodes. */
  const roots = () => provider.getChildren() as Array<TodoSessionNode | TodoEmptyNode>;
  /** Shortcut: one session group's item nodes. */
  const childrenOf = (node: TodoSessionNode) => provider.getChildren(node) as TodoItemNode[];
  /** `checkboxState` is a union (bare enum or object) — normalize it. */
  const checkboxOf = (item: vscode.TreeItem): vscode.TreeItemCheckboxState => {
    const cs = item.checkboxState;
    assert.ok(cs !== undefined, 'expected a checkbox on this item');
    return typeof cs === 'object' ? cs.state : cs;
  };

  test('shows a placeholder when no session has a list', () => {
    const nodes = roots();
    assert.strictEqual(nodes.length, 1);
    assert.ok(nodes[0] instanceof TodoEmptyNode);
    assert.strictEqual((nodes[0] as TodoEmptyNode).contextValue, 'todoEmptyNode');
  });

  test('one root node per session that has a list', () => {
    store.replace('a', [{ content: 'A1', status: 'pending' }], 'Alpha');
    store.replace('b', [{ content: 'B1', status: 'pending' }], 'Beta');

    const nodes = roots();
    assert.strictEqual(nodes.length, 2);
    assert.deepStrictEqual(nodes.map(n => (n as TodoSessionNode).summary.sessionName).sort(), ['Alpha', 'Beta']);
  });

  test('the active session sorts first and is marked active', () => {
    store.replace('a', [{ content: 'A1', status: 'pending' }], 'Alpha');
    store.replace('b', [{ content: 'B1', status: 'pending' }], 'Beta');
    store.setActiveSession('b', 'Beta');

    const nodes = roots() as TodoSessionNode[];
    assert.strictEqual(nodes[0]!.sessionId, 'b');
    assert.ok(nodes[0]!.description!.toString().includes('active'));
    assert.ok(!nodes[1]!.description!.toString().includes('active'));
  });

  test('a session group reports its progress', () => {
    store.replace('a', [
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'pending' },
      { content: 'Three', status: 'in_progress' },
    ], 'Alpha');

    const node = roots()[0] as TodoSessionNode;
    assert.strictEqual(node.description, '1/3');
    assert.strictEqual(node.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(node.contextValue, 'todoSessionNode');
  });

  test('items render with status icons, checkboxes and stable ids', () => {
    store.replace('a', [
      { content: 'Finished', status: 'completed' },
      { content: 'Running', status: 'in_progress', activeForm: 'Running the tests' },
      { content: 'Waiting', status: 'pending' },
    ], 'Alpha');

    const items = childrenOf(roots()[0] as TodoSessionNode);
    assert.strictEqual(items.length, 3);

    // Completed: ticked checkbox + "done" tail + done menu bucket.
    assert.strictEqual(checkboxOf(items[0]!), vscode.TreeItemCheckboxState.Checked);
    assert.strictEqual(items[0]!.description, 'done');
    assert.strictEqual(items[0]!.contextValue, 'todoItemDoneNode');

    // In progress: unticked, spun icon, label swapped to the active form.
    assert.strictEqual(checkboxOf(items[1]!), vscode.TreeItemCheckboxState.Unchecked);
    assert.strictEqual(items[1]!.label, 'Running the tests');
    assert.strictEqual(items[1]!.contextValue, 'todoItemNode');

    // Pending: unticked, original label.
    assert.strictEqual(checkboxOf(items[2]!), vscode.TreeItemCheckboxState.Unchecked);
    assert.strictEqual(items[2]!.label, 'Waiting');

    // Ids must be unique and stable so VS Code keeps checkbox identity.
    const ids = items.map(i => i.id);
    assert.strictEqual(new Set(ids).size, 3);
    assert.strictEqual(childrenOf(roots()[0] as TodoSessionNode)[0]!.id, ids[0]);
  });

  test('a leaf exposes the underlying item id and its session', () => {
    const list = store.replace('a', [{ content: 'Only', status: 'pending' }], 'Alpha');
    const item = childrenOf(roots()[0] as TodoSessionNode)[0]!;
    assert.strictEqual(item.sessionId, 'a');
    assert.strictEqual(item.item.id, list.items[0]!.id);
  });

  test('ticking a checkbox completes the item in the store', () => {
    store.replace('a', [{ content: 'Tick me', status: 'pending' }], 'Alpha');
    const item = childrenOf(roots()[0] as TodoSessionNode)[0]!;

    provider.handleCheckboxChange([[item, vscode.TreeItemCheckboxState.Checked]]);
    assert.strictEqual(store.read('a')!.items[0]!.status, 'completed');

    provider.handleCheckboxChange([[item, vscode.TreeItemCheckboxState.Unchecked]]);
    assert.strictEqual(store.read('a')!.items[0]!.status, 'pending');
  });

  test('handleCheckboxChange ignores non-item nodes', () => {
    store.replace('a', [{ content: 'Kept', status: 'pending' }], 'Alpha');
    const group = roots()[0] as TodoSessionNode;
    assert.doesNotThrow(() =>
      provider.handleCheckboxChange([[group as unknown as vscode.TreeItem, vscode.TreeItemCheckboxState.Checked]])
    );
    assert.strictEqual(store.read('a')!.items[0]!.status, 'pending');
  });

  test('setStatus moves an item explicitly', () => {
    store.replace('a', [{ content: 'Move me', status: 'pending' }], 'Alpha');
    const item = childrenOf(roots()[0] as TodoSessionNode)[0]!;

    provider.setStatus(item, 'in_progress');
    assert.strictEqual(store.read('a')!.items[0]!.status, 'in_progress');
  });

  test('removeItem drops a single item and then the whole list', () => {
    store.replace('a', [
      { content: 'First', status: 'pending' },
      { content: 'Second', status: 'pending' },
    ], 'Alpha');
    const items = childrenOf(roots()[0] as TodoSessionNode);

    provider.removeItem(items[0]!);
    assert.deepStrictEqual(store.read('a')!.items.map(i => i.content), ['Second']);

    provider.removeItem(childrenOf(roots()[0] as TodoSessionNode)[0]!);
    assert.strictEqual(store.read('a'), null);
    assert.ok(roots()[0] instanceof TodoEmptyNode, 'the placeholder returns when the last list goes');
  });

  test('clearSession deletes a session list', () => {
    store.replace('a', [{ content: 'A1', status: 'pending' }], 'Alpha');
    assert.strictEqual(provider.clearSession('a'), true);
    assert.strictEqual(store.read('a'), null);
    assert.strictEqual(provider.clearSession('a'), false);
  });

  test('the tree re-renders when the store changes', () => {
    let fires = 0;
    provider.onDidChangeTreeData(() => { fires++; });

    store.replace('a', [{ content: 'New task', status: 'pending' }], 'Alpha');
    assert.ok(fires > 0, 'a store write must refresh the view');

    const before = fires;
    store.setActiveSession('a', 'Alpha');
    assert.ok(fires > before, 'switching the active session must refresh the view');
  });

  test('setStore follows a rebuilt store (services are recreated on config change)', () => {
    store.replace('a', [{ content: 'Old store task', status: 'pending' }], 'Alpha');
    assert.strictEqual(roots().length, 1);

    const rebuilt = new TodoStore(tmpDir);
    provider.setStore(rebuilt);

    // The rebuilt store reads the same files, so the tree still renders them…
    assert.strictEqual(roots().length, 1);
    // …and it now reflects the NEW instance, not the stale one.
    rebuilt.replace('b', [{ content: 'New store task', status: 'pending' }], 'Beta');
    assert.strictEqual(roots().length, 2);
  });

  test('leaf nodes have no children', () => {
    store.replace('a', [{ content: 'Leaf', status: 'pending' }], 'Alpha');
    const item = childrenOf(roots()[0] as TodoSessionNode)[0]!;
    assert.deepStrictEqual(provider.getChildren(item), []);
  });

  // ── Goal ──────────────────────────────────────────────────────────

  test('the goal becomes the top node label with the target icon', () => {
    store.replace('a', [{ content: 'Step one', status: 'pending' }], 'Alpha');
    store.setGoal('a', 'Ship the to-do feature', 'ai', 'Alpha');
    store.setActiveSession('a', 'Alpha');

    const node = roots()[0] as TodoSessionNode;
    assert.strictEqual(node.label, 'Ship the to-do feature', 'the goal is the label');
    assert.strictEqual(node.contextValue, 'todoGoalNode');
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, 'target');
    // The session name moves into the description so the row still says which chat it is.
    assert.strictEqual(node.description, 'Alpha · 0/1 · active');
    assert.strictEqual(node.goal!.text, 'Ship the to-do feature');
  });

  test('a session without a goal keeps its chat name as the label', () => {
    store.replace('a', [{ content: 'Step one', status: 'pending' }], 'Alpha');
    const node = roots()[0] as TodoSessionNode;
    assert.strictEqual(node.label, 'Alpha');
    assert.strictEqual(node.contextValue, 'todoSessionNode');
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, 'checklist');
    assert.strictEqual(node.goal, undefined);
  });

  test('the goal node has the items nested under it', () => {
    store.replace('g', [
      { content: 'Step one', status: 'completed' },
      { content: 'Step two', status: 'pending' },
    ], 'Goal Session');
    store.setGoal('g', 'Ship the feature', 'ai', 'Goal Session');

    const node = roots().find(n => n instanceof TodoSessionNode && n.sessionId === 'g') as TodoSessionNode;
    assert.strictEqual(node.label, 'Ship the feature');
    const items = childrenOf(node);
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(items.map(i => i.label), ['Step one', 'Step two']);
  });

  test('a goal-only session is shown and is not collapsible', () => {
    store.setGoal('only', 'Just an objective', 'user', 'Only Goal');
    const nodes = roots() as TodoSessionNode[];
    assert.strictEqual(nodes.length, 1, 'a goal alone must render');
    assert.strictEqual(nodes[0]!.label, 'Just an objective');
    assert.strictEqual(nodes[0]!.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.deepStrictEqual(provider.getChildren(nodes[0]!), []);
  });

  test('the goal node reports who set the goal in its tooltip', () => {
    store.setGoal('g', 'Objective', 'user', 'G');
    const node = roots()[0] as TodoSessionNode;
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip.value.includes('set by you'), `expected the user attribution, got: ${tooltip.value}`);

    store.setGoal('g', 'Objective', 'ai', 'G');
    const aiNode = roots()[0] as TodoSessionNode;
    assert.ok((aiNode.tooltip as vscode.MarkdownString).value.includes('set by the AI'));
  });

  test('provider.setGoal writes a user-authored goal', () => {
    store.replace('a', [{ content: 'Step', status: 'pending' }], 'Alpha');
    const node = roots()[0] as TodoSessionNode;
    provider.setGoal(node, 'Ship it');
    const stored = store.read('a')!;
    assert.strictEqual(stored.goal!.text, 'Ship it');
    assert.strictEqual(stored.goal!.source, 'user', 'the view authors as the user');
    assert.strictEqual(stored.items.length, 1, 'the steps are untouched');
  });

  test('provider.clearGoal drops the goal but keeps the items', () => {
    store.replace('a', [{ content: 'Step', status: 'pending' }], 'Alpha');
    store.setGoal('a', 'Ship it', 'user', 'Alpha');
    provider.clearGoal(roots()[0] as TodoSessionNode);
    const stored = store.read('a')!;
    assert.strictEqual(stored.goal, undefined);
    assert.strictEqual(stored.items.length, 1);
    // …and the node falls back to the chat name.
    assert.strictEqual((roots()[0] as TodoSessionNode).label, 'Alpha');
  });

  test('the tree re-renders when the goal changes', () => {
    store.replace('a', [{ content: 'Step', status: 'pending' }], 'Alpha');
    let fires = 0;
    provider.onDidChangeTreeData(() => { fires++; });
    store.setGoal('a', 'New objective', 'ai', 'Alpha');
    assert.ok(fires > 0, 'setting a goal must refresh the view');
  });
});

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DRAFT_QUEUE_VIEW_TYPE, DraftQueuePage } from '../../../webview/draftQueuePage';
import { createDraftQueueSerializer } from '../../../webview/draftQueueSerializer';
import { WorkItemDraftQueue } from '../../../shared/draftQueue';
import {
  createWorkspaceSelectionStore,
  getDraftSelectionStore,
  resetDraftSelectionStore,
  sanitizeSelection,
  setDraftSelectionStore,
} from '../../../webview/draftQueueSelection';

const EXT_URI = vscode.Uri.file('d:/Development/vscode/ado-code');
/** Nothing here accepts a draft, so the ADO executor is never called. */
const stubExecutor: any = async () => ({ adoId: 1 });

interface FakePanel {
  panel: any;
  posted: any[];
  messageHandlers: Array<(message: any) => void>;
  revealCalls: number;
  disposeCalls: number;
}

/**
 * Minimal stand-in for a WebviewPanel: just enough surface for the page to wire
 * itself up. Tracks reveal() so the reload path can prove it does not steal
 * focus from whatever the user was editing.
 */
function makePanel(): FakePanel {
  const fake: any = { posted: [], messageHandlers: [], revealCalls: 0, disposeCalls: 0 };
  fake.panel = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: any) => uri,
      postMessage: (message: any) => {
        fake.posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (callback: any) => {
        fake.messageHandlers.push(callback);
        return { dispose() { /* noop */ } };
      },
    },
    onDidDispose: (callback: any) => {
      fake.panel.onDisposeCallback = callback;
      return { dispose() { /* noop */ } };
    },
    reveal: () => { fake.revealCalls += 1; },
    dispose: () => {
      fake.disposeCalls += 1;
      if (fake.panel.onDisposeCallback) fake.panel.onDisposeCallback();
    },
  };
  return fake;
}

/** The snapshot the page last pushed to its webview, if any. */
function lastSnapshot(posted: any[]): any {
  const snapshots = posted.filter((m) => m && m.type === 'draftQueue');
  return snapshots[snapshots.length - 1];
}

suite('DraftQueuePage — restored after a reload', () => {
  test('the serializer view type matches the one the page creates panels with', () => {
    // A mismatch here is silent: VS Code simply stops restoring the tab.
    assert.strictEqual(DRAFT_QUEUE_VIEW_TYPE, 'adoCode.draftQueuePage');
  });

  test('restore wires the panel, enables scripts and keeps focus where it was', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    queue.enqueue({ workItemType: 'Task', title: 'Persisted row' });
    const fake = makePanel();
    try {
      DraftQueuePage.restore(fake.panel, EXT_URI, queue);
      assert.ok(String(fake.panel.webview.html).includes('data-mode'), 'page html is built');
      assert.ok(String(fake.panel.webview.html).includes('draftQueue'), 'built for the queue surface');
      // A deserialized panel has no options of its own, so the page must set them
      // or the restored tab renders a script-less shell.
      assert.strictEqual(fake.panel.webview.options.enableScripts, true);
      assert.ok(Array.isArray(fake.panel.webview.options.localResourceRoots), 'local roots set');
      assert.strictEqual(fake.revealCalls, 0, 'restore must not steal focus');
    } finally {
      fake.panel.dispose();
    }
  });

  test('the restored page serves the rows that survived in workspaceState', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    queue.enqueue({ workItemType: 'Task', title: 'First' });
    queue.enqueue({ workItemType: 'Bug', title: 'Second' });
    const fake = makePanel();
    try {
      DraftQueuePage.restore(fake.panel, EXT_URI, queue);
      assert.strictEqual(fake.messageHandlers.length, 1, 'page listens for webview messages');
      fake.messageHandlers[0]({ type: 'draftQueueGet' });
      const snapshot = lastSnapshot(fake.posted);
      assert.ok(snapshot, 'a draftQueue snapshot was posted');
      assert.deepStrictEqual(
        snapshot.drafts.map((d: any) => d.title),
        ['First', 'Second'],
      );
    } finally {
      fake.panel.dispose();
    }
  });

  test('restore does not leak a queue subscription once the tab closes', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    const fake = makePanel();
    DraftQueuePage.restore(fake.panel, EXT_URI, queue);
    fake.panel.dispose();
    const before = fake.posted.length;
    queue.enqueue({ workItemType: 'Task', title: 'After close' });
    assert.strictEqual(fake.posted.length, before, 'a closed page stops receiving rows');
  });

  test('a second restore disposes the duplicate instead of showing two tabs', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    const first = makePanel();
    const second = makePanel();
    try {
      DraftQueuePage.restore(first.panel, EXT_URI, queue);
      DraftQueuePage.restore(second.panel, EXT_URI, queue);
      assert.strictEqual(second.disposeCalls, 1, 'the newcomer is dropped');
      assert.strictEqual(second.panel.webview.html, '', 'the newcomer was never wired');
      assert.strictEqual(first.disposeCalls, 0, 'the open tab survives');
    } finally {
      first.panel.dispose();
    }
  });

  test('the serializer forwards the restored panel to the provider', async () => {
    const seen: any[] = [];
    const serializer = createDraftQueueSerializer({
      restoreDraftQueuePage: (panel: any) => { seen.push(panel); },
    });
    const fake = makePanel();
    await serializer.deserializeWebviewPanel(fake.panel, {});
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0], fake.panel);
  });
});


suite('DraftQueuePage — row selection survives a reload', () => {
  /** In-memory Memento shaped like workspaceState. */
  function makeMemento(): { data: Record<string, unknown>; state: vscode.Memento } {
    const data: Record<string, unknown> = {};
    const state = {
      get: <T>(key: string): T | undefined => data[key] as T | undefined,
      update: (key: string, value: unknown) => {
        data[key] = value;
        return Promise.resolve();
      },
      keys: () => Object.keys(data),
    } as unknown as vscode.Memento;
    return { data, state };
  }

  teardown(() => {
    // The store is module-level (one page per window), so it leaks between tests.
    resetDraftSelectionStore();
  });

  test('sanitizeSelection drops junk, dedupes and caps a corrupt blob', () => {
    assert.deepStrictEqual(sanitizeSelection('not-an-array'), []);
    assert.deepStrictEqual(sanitizeSelection([1, null, {}, 'draft-1', 'draft-1', '']), ['draft-1']);
    const many = Array.from({ length: 900 }, (_unused, i) => 'draft-' + i);
    assert.strictEqual(sanitizeSelection(many).length, 500, 'selection is bounded');
  });

  test('a selection reported by the webview is written to the store', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    queue.enqueue({ workItemType: 'Task', title: 'Row' });
    const fake = makePanel();
    try {
      DraftQueuePage.restore(fake.panel, EXT_URI, queue);
      fake.messageHandlers[0]({ type: 'draftQueueSelection', ids: ['draft-1', 'draft-1', 42] });
      assert.deepStrictEqual(getDraftSelectionStore().load(), ['draft-1']);
    } finally {
      fake.panel.dispose();
    }
  });

  test('every snapshot carries the stored selection, so a repaint cannot lose it', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    queue.enqueue({ workItemType: 'Task', title: 'Row' });
    const fake = makePanel();
    try {
      DraftQueuePage.restore(fake.panel, EXT_URI, queue);
      fake.messageHandlers[0]({ type: 'draftQueueSelection', ids: ['draft-1'] });
      fake.messageHandlers[0]({ type: 'draftQueueGet' });
      assert.deepStrictEqual(lastSnapshot(fake.posted).selectedIds, ['draft-1']);
    } finally {
      fake.panel.dispose();
    }
  });

  test('a new page over the same workspaceState reports the selection back', () => {
    const { data, state } = makeMemento();
    setDraftSelectionStore(createWorkspaceSelectionStore(state, 'sel'));

    const before = new WorkItemDraftQueue(stubExecutor);
    before.enqueue({ workItemType: 'Task', title: 'Restored row' });
    const first = makePanel();
    DraftQueuePage.restore(first.panel, EXT_URI, before);
    first.messageHandlers[0]({ type: 'draftQueueSelection', ids: ['draft-9', 'draft-7'] });
    first.panel.dispose();
    assert.deepStrictEqual(data['sel'], ['draft-9', 'draft-7'], 'selection reached storage');

    // What a reload looks like: new queue instance, new page, same memento.
    setDraftSelectionStore(createWorkspaceSelectionStore(state, 'sel'));
    const after = new WorkItemDraftQueue(stubExecutor);
    after.enqueue({ workItemType: 'Task', title: 'Restored row' });
    const second = makePanel();
    try {
      DraftQueuePage.restore(second.panel, EXT_URI, after);
      second.messageHandlers[0]({ type: 'draftQueueGet' });
      const snapshot = lastSnapshot(second.posted);
      assert.strictEqual(snapshot.drafts.length, 1);
      assert.deepStrictEqual(snapshot.selectedIds, ['draft-9', 'draft-7']);
    } finally {
      second.panel.dispose();
    }
  });
});

suite('DraftQueuePage — an automatic open keeps the keyboard where it was', () => {
  /** Swap vscode.window.createWebviewPanel for a recorder; returns a restore(). */
  function recordCreate(panel: any, calls: any[]): () => void {
    const win: any = vscode.window;
    const saved = win.createWebviewPanel;
    win.createWebviewPanel = (viewType: string, title: string, column: any, options: any) => {
      calls.push({ viewType, title, column, options });
      return panel;
    };
    return () => { win.createWebviewPanel = saved; };
  }

  test('show({ preserveFocus: true }) creates the tab without taking focus', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    queue.enqueue({ workItemType: 'Task', title: 'Queued by an agent' });
    const fake = makePanel();
    const calls: any[] = [];
    const restore = recordCreate(fake.panel, calls);
    try {
      DraftQueuePage.show(EXT_URI, queue, { preserveFocus: true });
      assert.strictEqual(calls.length, 1, 'the page is created exactly once');
      assert.deepStrictEqual(
        calls[0].column,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        'createWebviewPanel must be told to preserve focus',
      );
      assert.strictEqual(fake.revealCalls, 0, 'the constructor must not grab focus either');
    } finally {
      fake.panel.dispose(); // clears the cached page so later suites start clean
      restore();
    }
  });

  test('the explicit command still takes focus', () => {
    const queue = new WorkItemDraftQueue(stubExecutor);
    queue.enqueue({ workItemType: 'Task', title: 'Queued by an agent' });
    const fake = makePanel();
    const calls: any[] = [];
    const restore = recordCreate(fake.panel, calls);
    try {
      DraftQueuePage.show(EXT_URI, queue);
      assert.deepStrictEqual(
        calls[0].column,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        'a requested open is allowed to take the keyboard',
      );
      assert.strictEqual(fake.revealCalls, 1, 'the constructor reveals the new tab');
    } finally {
      fake.panel.dispose();
      restore();
    }
  });
});

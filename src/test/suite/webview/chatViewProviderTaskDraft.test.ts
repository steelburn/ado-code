import * as assert from 'assert';
import * as nodeFs from 'fs';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';
import { WorkItemDraftQueue } from '../../../shared/draftQueue';
import { makeScratchDir } from '../utils/scratchDir';

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a CONDITION rather than sleeping a fixed delay. A draft flow writes
 * its file, opens the editor and only then asks for confirmation, so 10ms is
 * not an upper bound on a loaded machine (this suite failed the pre-commit gate
 * with "0 !== 1" because the first card had not appeared yet).
 */
async function waitFor(predicate: () => boolean, what: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for ' + what);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeSessionContext(): any {
  const data = new Map<string, any>();
  return {
    workspaceState: {
      get: (k: string, d?: any) => (data.has(k) ? data.get(k) : d),
      update: async (k: string, v: any) => { data.set(k, v); },
    },
  };
}

function makeServices(): any {
  return {
    todos: {
      setActiveSession() { /* noop */ },
      rename() { /* noop */ },
      removeSession() { /* noop */ },
      removeAll() { /* noop */ },
      setGoal() { /* noop */ },
    },
  };
}

suite('ChatViewProvider — draft queue', () => {
  let tmp: string;
  let savedFolders: any;
  let savedOpen: any;
  let savedShow: any;

  suiteSetup(() => {
    tmp = makeScratchDir('ado-draft-');
    const ws: any = vscode.workspace;
    const win: any = vscode.window;
    savedFolders = ws.workspaceFolders;
    savedOpen = ws.openTextDocument;
    savedShow = win.showTextDocument;
    // `workspaceFolders` is a dynamic (getter) property on the real VS Code API —
    // a direct assignment is a silent no-op there, so redefine it (as the
    // consent tests do) to make this suite behave the same in both harnesses.
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: [{ uri: vscode.Uri.file(tmp), name: 't', index: 0 }],
      configurable: true,
      writable: true,
    });
    ws.openTextDocument = async (uri: any) => ({ uri });
    win.showTextDocument = async () => ({ show() { /* noop */ }, document: {} });
  });

  suiteTeardown(() => {
    const ws: any = vscode.workspace;
    const win: any = vscode.window;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: savedFolders,
      configurable: true,
      writable: true,
    });
    ws.openTextDocument = savedOpen;
    win.showTextDocument = savedShow;
    try { nodeFs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('concurrent create_work_item calls append rows instead of blocking on cards', async () => {
    const provider: any = new ChatViewProvider({} as any, makeServices(), makeSessionContext());
    const posted: any[] = [];
    provider._view = { webview: { postMessage: (m: any) => { posted.push(m); } } };

    // Swap in a deterministic executor: this test is about ROUTING, not ADO.
    const created: string[] = [];
    provider.workItemDrafts = new WorkItemDraftQueue(async (draft: any) => {
      created.push(draft.title);
      return { id: 100 + created.length, url: 'https://example.test/' + created.length };
    });

    let cards = 0;
    provider.requestConfirmation = async () => { cards += 1; return null; };

    // Three create_work_item calls dispatched in ONE agentic iteration. Each used
    // to await its own confirmation card; now they only append a row and return.
    const a = provider.enqueueWorkItemDraft({ workItemType: 'Task', title: 'R-1', parentWorkItemId: 4242 });
    const b = provider.enqueueWorkItemDraft({ workItemType: 'Task', title: 'R-2', parentWorkItemId: 4242 });
    const c = provider.enqueueWorkItemDraft({ workItemType: 'Task', title: 'R-3', parentWorkItemId: 4242 });
    await tick(1);

    assert.deepStrictEqual(
      [a, b, c].map((r) => r.draftId),
      ['draft-1', 'draft-2', 'draft-3'],
      'each call returns its queued draft id to the tool'
    );
    assert.strictEqual(provider.workItemDrafts.list().length, 3, 'all three rows coexist');
    assert.ok(provider.workItemDrafts.list().every((d: any) => d.status === 'pending'));
    assert.strictEqual(cards, 0, 'no blocking confirmation card is raised');
    assert.strictEqual(created.length, 0, 'drafting must not touch ADO');

    // The queue is its own page now (src/webview/draftQueuePage.ts): the chat
    // webview is deliberately NOT mirrored, so it must not receive a snapshot.
    assert.strictEqual(
      posted.filter((m) => m.type === 'draftQueue').length,
      0,
      'the chat webview no longer mirrors the queue — the dedicated page does',
    );
  });

  test('case A — rows keep their existing ADO parent and accept in any order', async () => {
    const provider: any = new ChatViewProvider({} as any, makeServices(), makeSessionContext());
    provider._view = { webview: { postMessage: () => { /* noop */ } } };

    const created: Array<{ title: string; parent?: number }> = [];
    provider.workItemDrafts = new WorkItemDraftQueue(async (draft: any, ctx: any) => {
      created.push({ title: draft.title, parent: ctx.parentAdoId });
      return { id: 200 + created.length, url: 'https://example.test/' + created.length };
    });

    const queue = provider.workItemDrafts;
    const ids = ['R-1', 'R-2', 'R-3'].map((title: string) =>
      queue.enqueue({ workItemType: 'Task', title, parentWorkItemId: 4242 } as any).id);
    assert.ok(
      queue.list().every((d: any) => d.parentRef && d.parentRef.kind === 'ado' && d.parentRef.id === 4242),
      'a flat ADO parent normalises to a canonical ado ParentRef'
    );

    // Click the LAST row first: with an existing ADO parent nothing is blocked.
    assert.strictEqual(queue.accept([ids[2]]), 1);
    queue.finalize();
    await waitFor(() => queue.get(ids[2])?.status === 'created', 'the third row to be created');
    assert.strictEqual(queue.get(ids[0])?.status, 'pending', 'untouched rows stay pending');

    assert.strictEqual(queue.accept([ids[0], ids[1]]), 2);
    queue.finalize();
    await waitFor(() => queue.counts().created === 3, 'all three rows to be created');
    assert.deepStrictEqual(
      created.map((row) => row.parent),
      [4242, 4242, 4242],
      'every child is created under the existing ADO parent'
    );
  });
});

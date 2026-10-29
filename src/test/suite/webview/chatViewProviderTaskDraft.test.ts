import * as assert from 'assert';
import * as nodeFs from 'fs';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';
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

suite('ChatViewProvider — task-draft concurrency', () => {
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

  test('concurrent create_work_item calls present one draft card at a time', async () => {
    const provider: any = new ChatViewProvider({} as any, makeServices(), makeSessionContext());
    provider._view = { webview: { postMessage: () => { /* noop */ } } };

    const cards: string[] = [];
    const resolvers: Array<(value: any) => void> = [];
    provider.requestConfirmation = (title: string) => {
      cards.push(title);
      return new Promise((resolve) => resolvers.push(resolve));
    };

    // Three create_work_item calls dispatched in ONE agentic iteration — the
    // loop runs auto-approved calls concurrently, so all three land at once.
    const first = provider.showTaskDraftInEditor({ workItemType: 'Task', title: 'R-1' });
    const second = provider.showTaskDraftInEditor({ workItemType: 'Task', title: 'R-2' });
    const third = provider.showTaskDraftInEditor({ workItemType: 'Task', title: 'R-3' });

    await waitFor(() => cards.length >= 1, 'the first draft card');
    await tick(50); // give any wrongly-concurrent flow a chance to surface
    assert.strictEqual(cards.length, 1, 'only the first draft card may be shown');
    assert.strictEqual(resolvers.length, 1);

    // User cancels the first card. The second must surface only now, and must
    // NOT have been pre-emptively cancelled by the first one's supersede.
    resolvers[0]!(null);
    assert.strictEqual(await first, null);
    await waitFor(() => cards.length >= 2, 'the second draft card');
    assert.strictEqual(cards.length, 2, 'second card appears only after the first settled');

    resolvers[1]!(null);
    assert.strictEqual(await second, null);
    await waitFor(() => cards.length >= 3, 'the third draft card');
    assert.strictEqual(cards.length, 3, 'third card appears last');

    resolvers[2]!(null);
    assert.strictEqual(await third, null);
  });

  test('drafts share one fixed staging file and it is removed once the flow settles', async () => {
    const provider: any = new ChatViewProvider({} as any, makeServices(), makeSessionContext());
    provider._view = { webview: { postMessage: () => { /* noop */ } } };

    // Every card is cancelled, so each flow must clean up after itself.
    provider.requestConfirmation = async () => null;
    const opened: string[] = [];
    (vscode.workspace as any).openTextDocument = async (uri: any) => {
      opened.push(uri.fsPath ?? String(uri));
      return { uri };
    };

    await Promise.all([
      provider.showTaskDraftInEditor({ workItemType: 'Task', title: 'A' }),
      provider.showTaskDraftInEditor({ workItemType: 'Task', title: 'B' }),
      provider.showTaskDraftInEditor({ workItemType: 'Task', title: 'C' }),
    ]);

    assert.strictEqual(opened.length, 3, 'each flow still stages a draft');
    assert.strictEqual(new Set(opened).size, 1, 'drafts share ONE fixed staging slot, not per-call files');
    assert.ok(
      opened[0].replace(/\\/g, '/').endsWith('.ado-code/task-draft.md'),
      `draft must live in the ephemeral staging slot, got ${opened[0]}`,
    );
    assert.ok(!nodeFs.existsSync(opened[0]), 'the draft file must not survive the flow');
  });
});

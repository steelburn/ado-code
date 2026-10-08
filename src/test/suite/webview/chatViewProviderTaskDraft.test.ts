import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as nodeFs from 'fs';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'ado-draft-'));
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

    await tick();
    assert.strictEqual(cards.length, 1, 'only the first draft card may be shown');
    assert.strictEqual(resolvers.length, 1);

    // User cancels the first card. The second must surface only now, and must
    // NOT have been pre-emptively cancelled by the first one's supersede.
    resolvers[0]!(null);
    assert.strictEqual(await first, null);
    await tick();
    assert.strictEqual(cards.length, 2, 'second card appears only after the first settled');

    resolvers[1]!(null);
    assert.strictEqual(await second, null);
    await tick();
    assert.strictEqual(cards.length, 3, 'third card appears last');

    resolvers[2]!(null);
    assert.strictEqual(await third, null);
  });

  test('each draft gets a distinct file even within the same millisecond', async () => {
    const provider: any = new ChatViewProvider({} as any, makeServices(), makeSessionContext());
    provider._view = { webview: { postMessage: () => { /* noop */ } } };

    const paths: string[] = [];
    provider.requestConfirmation = (title: string) => {
      return new Promise((resolve) => {
        // capture the draft path this call wrote (recorded via openTextDocument)
        paths.push(title);
        resolve(null);
      });
    };
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

    assert.strictEqual(opened.length, 3);
    assert.strictEqual(new Set(opened).size, 3, 'draft filenames must be unique');
  });
});

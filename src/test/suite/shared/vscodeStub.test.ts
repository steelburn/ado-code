import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Guardrail for the headless `vscode` stub used by `npm run test:unit`
// (`--require ./scripts/vscode-stub.js`) and by the compiled webview suites.
//
// The stub used to expose only *permissive* stand-ins: `TreeItem` was a generic
// proxy whose `set` trap swallowed writes (so `node.label`/`node.sessionId` came
// back as a function), `EventEmitter.event()` returned a dummy Disposable that
// never registered the listener, and `Uri`/`workspace.fs` had no real backing.
// The tree views and the SVG-export/mermaid panels therefore failed headless —
// 33 tests — even though the same code passes under `node out/test/runTest.js`.
//
// These tests pin the *behavioural contract* the suites rely on. Every
// assertion also holds against the real VS Code API, so the file is safe to run
// in the extension host too — it simply stops the stub from silently drifting
// back to a no-op.
suite('shared/vscodeStub', () => {
  test('TreeItem keeps own properties (label/id/context/description/checkboxState)', () => {
    const item = new vscode.TreeItem('Root', vscode.TreeItemCollapsibleState.Collapsed);
    item.id = 'todos:a';
    item.contextValue = 'todoSession';
    item.description = '2/5 done';
    item.checkboxState = vscode.TreeItemCheckboxState.Checked;
    item.iconPath = new vscode.ThemeIcon('target');

    assert.strictEqual(item.label, 'Root');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(item.id, 'todos:a');
    assert.strictEqual(item.contextValue, 'todoSession');
    assert.strictEqual(item.description, '2/5 done');
    assert.strictEqual(item.checkboxState, vscode.TreeItemCheckboxState.Checked);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
  });

  test('a TreeItem subclass keeps the fields it declares', () => {
    class SessionNode extends vscode.TreeItem {
      public readonly sessionId: string;
      constructor(sessionId: string) {
        super('Chat session', vscode.TreeItemCollapsibleState.None);
        this.sessionId = sessionId;
      }
    }

    const node = new SessionNode('a');
    assert.ok(node instanceof SessionNode);
    assert.ok(node instanceof vscode.TreeItem);
    assert.strictEqual(node.sessionId, 'a');
    assert.strictEqual(node.label, 'Chat session');
  });

  test('MarkdownString accumulates appended text', () => {
    const md = new vscode.MarkdownString('Each session can carry a **goal**.');
    md.appendText(' with steps.');
    md.appendMarkdown(' __done__');

    assert.strictEqual(md.value, 'Each session can carry a **goal**. with steps. __done__');
  });

  test('EventEmitter delivers to registered listeners and stops after dispose', () => {
    const emitter = new vscode.EventEmitter<number>();
    const seen: number[] = [];
    const subscription = emitter.event((value) => seen.push(value));

    emitter.fire(1);
    emitter.fire(2);
    subscription.dispose();
    emitter.fire(3);
    emitter.dispose();

    assert.deepStrictEqual(seen, [1, 2], 'disposed listeners must not be called');
  });

  test('Uri.joinPath produces a navigable path that keeps the child segment', () => {
    const joined = vscode.Uri.joinPath(
      vscode.Uri.file('/mock/extension'),
      'webview-ui-dist',
      'mermaid.js'
    );

    assert.ok(joined.toString().includes('mermaid.js'), 'toString() must expose the child');
    assert.ok(joined.fsPath.replace(/\\/g, '/').endsWith('webview-ui-dist/mermaid.js'));
  });

  test('workspace.fs round-trips a file through the real filesystem', async () => {
    const uri = vscode.Uri.file(path.join(os.tmpdir(), `ado-code-stub-${process.pid}-${Date.now()}.txt`));
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('hello stub', 'utf8'));
      const data = await vscode.workspace.fs.readFile(uri);
      assert.strictEqual(Buffer.from(data).toString('utf8'), 'hello stub');
    } finally {
      await vscode.workspace.fs.delete(uri);
    }
  });
});

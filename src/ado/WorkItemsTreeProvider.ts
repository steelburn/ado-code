import * as vscode from 'vscode';
// Task 8 compile-ready stub — the real typed tree provider replaces this in Task 9.
export class WorkItemsTreeProvider implements vscode.TreeDataProvider<unknown> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  getTreeItem(element: unknown): vscode.TreeItem { return element as vscode.TreeItem; }
  getChildren(): Thenable<unknown[]> { return Promise.resolve([]); }
  refresh(_items?: unknown[]): void { this._onDidChangeTreeData.fire(); }
}

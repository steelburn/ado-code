import * as vscode from 'vscode';
import { WorkItemSummary } from '../shared/messages';

// H-6 fix: the tree consumes WorkItemSummary (what refreshWorkItems posts),
// NOT raw AdoWorkItem — matches the onItemsFetched callback type.
export class WorkItemsTreeProvider implements vscode.TreeDataProvider<WorkItemNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkItemNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workItems: WorkItemSummary[] = [];

  // Data is pushed in via refresh() (called from ChatViewProvider.refreshWorkItems,
  // Task 8 Step 4). The provider itself never talks to ADO.
  constructor() {}

  refresh(items: WorkItemSummary[]): void {
    this.workItems = items;
    this._onDidChangeTreeData.fire(undefined);
  }

  getWorkItemById(id: number): WorkItemSummary | undefined {
    return this.workItems.find(wi => wi.id === id);
  }

  getTreeItem(element: WorkItemNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkItemNode): WorkItemNode[] {
    if (!element) {
      return this.workItems.map(wi => new WorkItemNode(wi));
    }
    return [];
  }
}

// HIGH fix: WorkItemNode must be EXPORTED — extension.ts types command args
// with it (Task 9/28) and imports only WorkItemsTreeProvider.
export class WorkItemNode extends vscode.TreeItem {
  constructor(workItem: WorkItemSummary) {
    super(workItem.title, vscode.TreeItemCollapsibleState.None);
    this.description = `#${workItem.id}`;
    this.tooltip = `${workItem.workItemType} - ${workItem.state}`;
    this.id = String(workItem.id);
    this.iconPath = new vscode.ThemeIcon(
      workItem.state === 'Active' ? 'circle-outline' : 'check'
    );
    // NOTE: no `command` field here. Clicking a tree item fires the command
    // passed via the context menu; tree-item commands are invoked with the
    // TreeItem as the FIRST argument (not an `arguments` array — that only
    // applies to clicking). We therefore register commands that take the node.
    this.contextValue = 'workItemNode';
    this.workItemId = workItem.id;
    this.workItemTitle = workItem.title;
  }

  public readonly workItemId: number;
  public readonly workItemTitle: string;
}

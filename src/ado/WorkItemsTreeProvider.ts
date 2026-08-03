import * as vscode from 'vscode';
import { WorkItemSummary } from '../shared/messages';

// H-6 fix: the tree consumes WorkItemSummary (what refreshWorkItems posts),
// NOT raw AdoWorkItem — matches the onItemsFetched callback type.
export class WorkItemsTreeProvider implements vscode.TreeDataProvider<WorkItemNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkItemNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workItems: WorkItemSummary[] = [];
  // Track which work items have active agent runs
  private activeAgentRuns = new Map<number, { agent: string; status: string }>();

  // Data is pushed in via refresh() (called from ChatViewProvider.refreshWorkItems,
  // Task 8 Step 4). The provider itself never talks to ADO.
  constructor(private readonly nodeContextValue = 'workItemNode') {}

  refresh(items: WorkItemSummary[]): void {
    this.workItems = items;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Update agent run status for a work item. */
  updateAgentStatus(workItemId: number, agent: string, status: string): void {
    if (status === 'running') {
      this.activeAgentRuns.set(workItemId, { agent, status });
    } else {
      this.activeAgentRuns.delete(workItemId);
    }
    // Refresh the specific node if it exists
    const node = this.workItems.find(wi => wi.id === workItemId);
    if (node) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  getWorkItemById(id: number): WorkItemSummary | undefined {
    return this.workItems.find(wi => wi.id === id);
  }

  getTreeItem(element: WorkItemNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkItemNode): WorkItemNode[] {
    if (!element) {
      return this.workItems.map(wi => {
        const agentRun = this.activeAgentRuns.get(wi.id);
        return new WorkItemNode(wi, agentRun, this.nodeContextValue);
      });
    }
    return [];
  }
}

// HIGH fix: WorkItemNode must be EXPORTED — extension.ts types command args
// with it (Task 9/28) and imports only WorkItemsTreeProvider.
export class WorkItemNode extends vscode.TreeItem {
  constructor(workItem: WorkItemSummary, agentRun?: { agent: string; status: string }, contextValue = 'workItemNode') {
    super(workItem.title, vscode.TreeItemCollapsibleState.None);

    if (agentRun) {
      // Show agent status in description
      this.description = `#${workItem.id} 🤖 ${agentRun.agent}`;
      this.tooltip = `${workItem.workItemType} - ${workItem.state}\nAgent: ${agentRun.agent} (${agentRun.status})`;
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    } else {
      this.description = `#${workItem.id}`;
      this.tooltip = `${workItem.workItemType} - ${workItem.state}`;
      this.iconPath = new vscode.ThemeIcon(
        workItem.state === 'Active' ? 'circle-outline' : 'check'
      );
    }

    // NOTE: no `command` field here. Clicking a tree item fires the command
    // passed via the context menu; tree-item commands are invoked with the
    // TreeItem as the FIRST argument (not an `arguments` array — that only
    // applies to clicking). We therefore register commands that take the node.
    // The contextValue differs per tree (workItemNode vs unassignedWorkItemNode)
    // so context menus can be gated per view.
    this.contextValue = contextValue;
    this.workItemId = workItem.id;
    this.workItemTitle = workItem.title;
    // Exposed for context-menu commands (e.g. changeWorkItemState needs the
    // item TYPE to fetch its available states, and the current state to mark
    // the picker).
    this.workItemType = workItem.workItemType;
    this.state = workItem.state;
  }

  public readonly workItemId: number;
  public readonly workItemTitle: string;
  public readonly workItemType: string;
  public readonly state: string;
}

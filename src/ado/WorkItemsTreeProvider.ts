import * as vscode from 'vscode';
import { WorkItemSummary } from '../shared/messages';

// H-6 fix: the tree consumes WorkItemSummary (what refreshWorkItems posts),
// NOT raw AdoWorkItem — matches the onItemsFetched callback type.

/** Map ADO work item types to VS Code theme icons. */
const TYPE_ICONS: Record<string, string> = {
  'Epic': 'layers',
  'Feature': 'flag',
  'User Story': 'account',
  'Product Backlog Item': 'account',
  'Task': 'checklist',
  'Bug': 'bug',
  'Issue': 'alert',
  'Test Case': 'beaker',
  'Test Suite': 'list-flat',
  'Shared Step': 'references',
  'Risk': 'warning',
  'Impediment': 'circle-slash',
  'Goal': 'target',
  'Plan': 'project',
};

function iconForType(workItemType: string): string {
  return TYPE_ICONS[workItemType] ?? 'circle-outline';
}

export interface WorkItemFilterState {
  states: string[];
  types: string[];
  text: string;
}

export class WorkItemsTreeProvider implements vscode.TreeDataProvider<WorkItemNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkItemNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workItems: WorkItemSummary[] = [];
  // Track which work items have active agent runs
  private activeAgentRuns = new Map<number, { agent: string; status: string }>();
  // Track the currently selected work item for highlighting
  private selectedWorkItemId?: number;
  // Parent → children index (built on refresh)
  private childrenOf = new Map<number, WorkItemSummary[]>();
  private roots: WorkItemSummary[] = [];

  // Filter state
  private filterState: Set<string> = new Set(); // empty = show all states
  private filterType: Set<string> = new Set();   // empty = show all types
  private filterText: string = '';

  // Data is pushed in via refresh() (called from ChatViewProvider.refreshWorkItems,
  // Task 8 Step 4). The provider itself never talks to ADO.
  constructor(private readonly nodeContextValue = 'workItemNode') {}

  refresh(items: WorkItemSummary[]): void {
    this.workItems = items;
    this.buildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set the state filter (empty array = show all states). */
  setFilterState(states: string[]): void {
    this.filterState = new Set(states);
    this.buildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set the type filter (empty array = show all types). */
  setFilterType(types: string[]): void {
    this.filterType = new Set(types);
    this.buildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set the text search filter (empty string = no text filter). */
  setFilterText(text: string): void {
    this.filterText = text;
    this.buildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Clear all filters and rebuild the tree. */
  clearFilters(): void {
    this.filterState.clear();
    this.filterType.clear();
    this.filterText = '';
    this.buildTree();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Return the currently active filters (for UI display). */
  getActiveFilters(): WorkItemFilterState {
    return {
      states: [...this.filterState],
      types: [...this.filterType],
      text: this.filterText,
    };
  }

  /** Check if any filter is currently active. */
  hasActiveFilters(): boolean {
    return this.filterState.size > 0 || this.filterType.size > 0 || this.filterText.length > 0;
  }

  /** Check whether a work item passes all active filters. */
  private matchesFilters(item: WorkItemSummary): boolean {
    if (this.filterState.size > 0 && !this.filterState.has(item.state)) {
      return false;
    }
    if (this.filterType.size > 0 && !this.filterType.has(item.workItemType)) {
      return false;
    }
    if (this.filterText.length > 0) {
      const lowerFilter = this.filterText.toLowerCase();
      if (!item.title.toLowerCase().includes(lowerFilter)) {
        return false;
      }
    }
    return true;
  }

  /** Build parent→children index and root list from flat work item array. */
  private buildTree(): void {
    // Build the full (unfiltered) tree first
    const allChildrenOf = new Map<number, WorkItemSummary[]>();
    const allRoots: WorkItemSummary[] = [];

    // Index all items by id for parent lookup
    const byId = new Map<number, WorkItemSummary>();
    for (const wi of this.workItems) {
      byId.set(wi.id, wi);
    }

    // Partition into roots (no parent or parent not in the fetched set)
    // and children (parent is in the fetched set)
    for (const wi of this.workItems) {
      const parentId = wi.parentId;
      if (parentId && byId.has(parentId)) {
        const siblings = allChildrenOf.get(parentId) ?? [];
        siblings.push(wi);
        allChildrenOf.set(parentId, siblings);
      } else {
        allRoots.push(wi);
      }
    }

    // Sort type order helper
    const typeOrder = ['Epic', 'Feature', 'User Story', 'Product Backlog Item', 'Task', 'Bug', 'Issue'];
    const sortByTypeAndTitle = (a: WorkItemSummary, b: WorkItemSummary) => {
      const ai = typeOrder.indexOf(a.workItemType);
      const bi = typeOrder.indexOf(b.workItemType);
      const aOrder = ai === -1 ? 99 : ai;
      const bOrder = bi === -1 ? 99 : bi;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.title.localeCompare(b.title);
    };

    // If no filters are active, use the full tree
    const hasFilters = this.hasActiveFilters();
    if (!hasFilters) {
      this.childrenOf = allChildrenOf;
      this.roots = allRoots.sort(sortByTypeAndTitle);

      // Sort children within each parent
      for (const [, children] of this.childrenOf) {
        children.sort(sortByTypeAndTitle);
      }
      return;
    }

    // Apply filters: a parent is visible if IT passes OR any child passes
    // First, compute which items pass the filter
    const matchingItems = new Set<number>();
    for (const wi of this.workItems) {
      if (this.matchesFilters(wi)) {
        matchingItems.add(wi.id);
      }
    }

    // Walk up from matching items to their ancestors so the tree path is visible
    const visibleItems = new Set<number>();
    for (const id of matchingItems) {
      let current = byId.get(id);
      while (current) {
        visibleItems.add(current.id);
        const pid = current.parentId;
        current = pid ? byId.get(pid) : undefined;
      }
    }

    // Rebuild filtered childrenOf — only keep children that are visible
    this.childrenOf.clear();
    for (const [parentId, children] of allChildrenOf) {
      if (!visibleItems.has(parentId)) continue;
      const filtered = children.filter(c => visibleItems.has(c.id));
      if (filtered.length > 0) {
        this.childrenOf.set(parentId, filtered);
      }
    }

    // Rebuild filtered roots — only keep roots that are visible
    this.roots = allRoots
      .filter(r => visibleItems.has(r.id))
      .sort(sortByTypeAndTitle);

    // Sort children within each parent
    for (const [, children] of this.childrenOf) {
      children.sort(sortByTypeAndTitle);
    }
  }

  /** Return all work items (unfiltered) for filter value discovery. */
  getUniqueFilterValues(): WorkItemSummary[] {
    return this.workItems;
  }

  /** Return the number of currently visible (filtered) root items. */
  getVisibleCount(): number {
    return this.roots.length;
  }

  /** Update agent run status for a work item. */
  updateAgentStatus(workItemId: number, agent: string, status: string): void {
    if (status === 'running') {
      this.activeAgentRuns.set(workItemId, { agent, status });
    } else {
      this.activeAgentRuns.delete(workItemId);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set the selected work item for visual highlighting. */
  setSelected(workItemId?: number): void {
    this.selectedWorkItemId = workItemId;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Get the currently selected work item ID. */
  getSelectedId(): number | undefined {
    return this.selectedWorkItemId;
  }

  getWorkItemById(id: number): WorkItemSummary | undefined {
    return this.workItems.find(wi => wi.id === id);
  }

  getTreeItem(element: WorkItemNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkItemNode): WorkItemNode[] {
    if (!element) {
      // Root level: items with no parent (or parent not in fetched set)
      return this.roots.map(wi => this.toNode(wi));
    }
    // Children of this node
    const children = this.childrenOf.get(element.workItemId) ?? [];
    return children.map(wi => this.toNode(wi));
  }

  private toNode(wi: WorkItemSummary): WorkItemNode {
    const agentRun = this.activeAgentRuns.get(wi.id);
    const hasChildren = this.childrenOf.has(wi.id);
    const isSelected = wi.id === this.selectedWorkItemId;
    return new WorkItemNode(wi, agentRun, this.nodeContextValue, hasChildren, isSelected);
  }
}

// HIGH fix: WorkItemNode must be EXPORTED — extension.ts types command args
// with it (Task 9/28) and imports only WorkItemsTreeProvider.
export class WorkItemNode extends vscode.TreeItem {
  constructor(
    workItem: WorkItemSummary,
    agentRun?: { agent: string; status: string },
    contextValue = 'workItemNode',
    hasChildren = false,
    isSelected = false
  ) {
    super(
      workItem.title,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (agentRun) {
      // Show agent status in description
      this.description = `#${workItem.id} 🤖 ${agentRun.agent}`;
      this.tooltip = `${workItem.workItemType} - ${workItem.state}\\nAgent: ${agentRun.agent} (${agentRun.status})`;
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    } else if (isSelected) {
      // Selected item: highlighted icon + badge
      this.description = `#${workItem.id} ◀ active`;
      this.tooltip = `${workItem.workItemType} - ${workItem.state}\\nSelected for chat context`;
      this.iconPath = new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green'));
    } else {
      this.description = `#${workItem.id}`;
      this.tooltip = `${workItem.workItemType} - ${workItem.state}`;
      this.iconPath = new vscode.ThemeIcon(iconForType(workItem.workItemType));
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

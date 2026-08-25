import * as vscode from 'vscode';
import { WorkItemSummary } from '../shared/messages';
import { WorkItemsMode, workItemsModeLabel } from '../shared/workItemsMode';
import { logger } from '../services/logger';

// H-6 fix: the tree consumes WorkItemSummary (what refreshWorkItems posts),
// NOT raw AdoWorkItem — matches the onItemsFetched callback type.

/** Assignment state of a work item relative to the signed-in user. */
export type AssignmentState = 'me' | 'other' | 'unassigned';

/**
 * Assignment-coded icons: a blue person = assigned to you, an orange person
 * = assigned to someone else, a grey empty circle = unassigned. The work
 * item TYPE moves into the description ("#123 · Task") and the tooltip keeps
 * type/state/assignee, so the visual cue replaces the type icon without
 * losing any information.
 */
const ASSIGNMENT_ICONS: Record<AssignmentState, { icon: string; color?: vscode.ThemeColor }> = {
  'me': { icon: 'account', color: new vscode.ThemeColor('charts.blue') },
  'other': { icon: 'account', color: new vscode.ThemeColor('charts.orange') },
  'unassigned': { icon: 'circle-outline', color: new vscode.ThemeColor('charts.grey') },
};

function assignmentLabel(assignment: AssignmentState, assignedTo: string): string {
  switch (assignment) {
    case 'me': return 'Assigned to you';
    case 'other': return `Assigned to ${assignedTo || 'someone else'}`;
    default: return 'Unassigned';
  }
}

export interface WorkItemFilterState {
  states: string[];
  types: string[];
  text: string;
}

export class WorkItemsTreeProvider implements vscode.TreeDataProvider<WorkItemNode | WorkItemsModeHeader> {
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

  // Which dataset the view shows (drives the header row label).
  private viewMode: WorkItemsMode = 'mine';

  // Display name of the signed-in user (pushed in from ChatViewProvider via
  // the refresh callback) — used to color-code assignment in the tree.
  private currentUserDisplayName = '';

  // Data is pushed in via refresh() (called from ChatViewProvider.refreshWorkItems,
  // Task 8 Step 4). The provider itself never talks to ADO.
  constructor() {}

  /** Current view mode (My / All / Unassigned) — shown in the header row. */
  getMode(): WorkItemsMode {
    return this.viewMode;
  }

  /** Remember who "me" is so assigned items can be color-coded. */
  setCurrentUser(displayName: string): void {
    if (displayName === this.currentUserDisplayName) return;
    this.currentUserDisplayName = displayName;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Update the view mode (kept in sync by the toggle command) and re-render. */
  setMode(mode: WorkItemsMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(items: WorkItemSummary[]): void {
    this.workItems = items;
    this.buildTree();
    // Diagnostic: how many summaries actually carry a parent id and how many
    // root nodes the tree produced — a flat tree with many parented items
    // points at rendering; zero parented items points at the ADO mapping.
    const withParent = items.filter(i => i.parentId !== undefined).length;
    logger.info(`Work items tree: ${items.length} items (${withParent} with parentId, ${this.roots.length} roots)`);
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

  getChildren(element?: WorkItemNode | WorkItemsModeHeader): (WorkItemNode | WorkItemsModeHeader)[] {
    if (!element) {
      // Header row (visible mode toggle) + root items.
      return [new WorkItemsModeHeader(this.viewMode), ...this.roots.map(wi => this.toNode(wi))];
    }
    // Children of this node (only work item nodes have children)
    if (element instanceof WorkItemsModeHeader) return [];
    const children = this.childrenOf.get(element.workItemId) ?? [];
    return children.map(wi => this.toNode(wi));
  }

  private toNode(wi: WorkItemSummary): WorkItemNode {
    const agentRun = this.activeAgentRuns.get(wi.id);
    const hasChildren = this.childrenOf.has(wi.id);
    const isSelected = wi.id === this.selectedWorkItemId;
    // Context menus are gated per ITEM, not per view: unassigned items get
    // the unassigned menu (Take Ownership, Reassign…) wherever they appear
    // (Unassigned mode, All mode, or as a child in My mode).
    const contextValue = wi.assignedTo ? 'workItemNode' : 'unassignedWorkItemNode';
    return new WorkItemNode(wi, agentRun, contextValue, hasChildren, isSelected, wi.isContext, this.assignmentOf(wi));
  }

  /** Classify an item's assignment relative to the signed-in user. */
  private assignmentOf(wi: WorkItemSummary): AssignmentState {
    if (!wi.assignedTo) return 'unassigned';
    return wi.assignedTo.trim() === this.currentUserDisplayName.trim()
      ? 'me'
      : 'other';
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
    isSelected = false,
    // Hierarchy-context node: not part of the base query (assigned/unassigned)
    // but pulled in because it is a parent/child of a base item.
    isContext = false,
    // Assignment relative to the signed-in user — drives the icon cue.
    assignment: AssignmentState = 'unassigned'
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
      this.tooltip = `${workItem.workItemType} - ${workItem.state}\nAgent: ${agentRun.agent} (${agentRun.status})`;
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    } else if (isSelected) {
      // Selected item: highlighted icon + badge
      this.description = `#${workItem.id} ◀ active`;
      this.tooltip = `${workItem.workItemType} - ${workItem.state}\nSelected for chat context`;
      this.iconPath = new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green'));
    } else {
      // Assignment cue: blue person = yours, orange person = someone else's,
      // grey empty circle = unassigned (hover the item for the assignee).
      // The work item type moves into the description so it isn't lost.
      const cue = ASSIGNMENT_ICONS[assignment];
      this.description = `#${workItem.id} · ${workItem.workItemType}${isContext ? ' · context' : ''}`;
      this.tooltip = `${workItem.workItemType} - ${workItem.state}\n${assignmentLabel(assignment, workItem.assignedTo)}${isContext ? '\nContext item — not in the base list; pulled in for hierarchy' : ''}`;
      this.iconPath = new vscode.ThemeIcon(cue.icon, cue.color);
    }

    // NOTE: no `command` field here. Clicking a tree item fires the command
    // passed via the context menu; tree-item commands are invoked with the
    // TreeItem as the FIRST argument (not an `arguments` array — that only
    // applies to clicking). We therefore register commands that take the node.
    // The contextValue differs per ITEM (workItemNode vs unassignedWorkItemNode)
    // so context menus can be gated per item regardless of the active view mode.
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

/**
 * First row of the Work Items tree: a visible mode indicator ("View: My Work
 * Items") that opens the mode QuickPick when clicked — the tree equivalent of
 * the Chat|Plan|Act|Yolo toggle. It is not a work item: no work item commands
 * match its contextValue and it never appears as a child of anything.
 */
export class WorkItemsModeHeader extends vscode.TreeItem {
  constructor(mode: WorkItemsMode) {
    super(`View: ${workItemsModeLabel(mode)}`, vscode.TreeItemCollapsibleState.None);
    this.id = 'workItemsModeHeader';
    this.contextValue = 'workItemsModeHeader';
    this.iconPath = new vscode.ThemeIcon('list-selection');
    this.description = 'click to switch ▾';
    this.tooltip = 'Work Items view mode — click to switch between My / All / Unassigned';
    this.command = { command: 'adoCode.workItemsToggleMode', title: 'Switch Work Items View' };
  }
}

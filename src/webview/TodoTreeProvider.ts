import * as vscode from 'vscode';
import { TodoGoal, TodoItem, TodoListSummary, TodoStore, TodoStatus } from '../services/todo/TodoStore';

/**
 * The **To-do** view (`adoCode.todos`): the AI-generated task list for each
 * chat session, rendered as a checkbox tree.
 *
 * One root node per session that has a list (the active chat session first and
 * expanded); its children are the items. The AI ticks items off through the
 * `update_todo_list` tool as it works, and the user can tick them by hand —
 * both paths write through `TodoStore`, so the tree never holds its own copy
 * of the state and every surface stays in sync via `onDidChange`.
 */

/** Root node: one session's goal (or name) with its items nested below. */
export class TodoSessionNode extends vscode.TreeItem {
  constructor(
    public readonly sessionId: string,
    public readonly summary: TodoListSummary,
    isActive: boolean
  ) {
    // The GOAL is the top node: it is what the items are steps toward, so it
    // takes the label and the target icon. A session without a goal falls back
    // to its chat name (and offers "Set Goal" in the context menu).
    const goal = summary.goal;
    super(
      goal ? goal.text : (summary.sessionName || 'Chat session'),
      summary.total > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    // Stable identity so VS Code keeps expansion state across refreshes.
    this.id = `todos:${sessionId}`;
    const remaining = summary.total - summary.completed;
    // When the label IS the goal, the session name moves into the description
    // so the row still says which chat it belongs to.
    const parts = [
      ...(goal ? [summary.sessionName || 'Chat session'] : []),
      `${summary.completed}/${summary.total}`,
      ...(isActive ? ['active'] : []),
    ];
    this.description = parts.join(' · ');
    this.iconPath = goal
      ? new vscode.ThemeIcon('target', new vscode.ThemeColor(isActive ? 'charts.purple' : 'charts.grey'))
      : new vscode.ThemeIcon('checklist', new vscode.ThemeColor(isActive ? 'charts.blue' : 'charts.grey'));
    const md = new vscode.MarkdownString(
      [
        `**${goal ? goal.text : summary.sessionName || 'Chat session'}**${isActive ? ' — active chat session' : ''}`,
        '',
        ...(goal
          ? [`$(target) Goal _(${goal.source === 'user' ? 'set by you' : 'set by the AI'})_`, '']
          : ['_No goal set for this session._', '']),
        `- Session: ${summary.sessionName || 'Chat session'}`,
        `- Items: ${summary.total}`,
        `- Completed: ${summary.completed}`,
        `- In progress: ${summary.inProgress}`,
        `- Remaining: ${remaining}`,
        '',
        `_Stored in \`.ado-code/todos/\`_`,
      ].join('\n')
    );
    md.supportThemeIcons = true;
    this.tooltip = md;
    this.contextValue = goal ? 'todoGoalNode' : 'todoSessionNode';
    this.goal = goal;
  }

  /** The session's goal, when one is set. */
  public readonly goal?: TodoGoal;
}

/** Leaf node: one to-do item, with a checkbox for completion. */
export class TodoItemNode extends vscode.TreeItem {
  constructor(
    public readonly sessionId: string,
    public readonly item: TodoItem
  ) {
    // In-progress items adopt their present-participle label (the AI's
    // `activeForm`), so the tree reads as "what is happening right now".
    const running = item.status === 'in_progress';
    const label = running ? (item.activeForm?.trim() || item.content) : item.content;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `todo:${sessionId}:${item.id}`;
    this.contextValue = item.status === 'completed' ? 'todoItemDoneNode' : 'todoItemNode';
    this.checkboxState = {
      state: item.status === 'completed'
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: item.status === 'completed' ? 'Completed — uncheck to reopen' : 'Mark completed',
    };

    if (item.status === 'completed') {
      this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
      this.description = 'done';
    } else if (running) {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-large-outline');
    }

    const statusLabel = item.status === 'completed'
      ? 'Completed'
      : running
        ? 'In progress'
        : 'Pending';
    const md = new vscode.MarkdownString(
      [
        `**${item.content}**`,
        '',
        `Status: ${statusLabel}`,
        ...(running && item.activeForm ? [`Doing: ${item.activeForm}`] : []),
      ].join('\n')
    );
    this.tooltip = md;
  }
}

/** Placeholder root shown when no session has a goal or a to-do list yet. */
export class TodoEmptyNode extends vscode.TreeItem {
  constructor() {
    super('No goal or to-do list yet', vscode.TreeItemCollapsibleState.None);
    this.id = 'todos:empty';
    this.description = 'the AI creates one when it plans work';
    this.iconPath = new vscode.ThemeIcon('target');
    this.tooltip = new vscode.MarkdownString(
      [
        'Each chat session can carry a **goal** — the objective — with the to-do',
        'list as the steps toward it. The AI records both as it works: it sets the',
        'goal with `set_goal` and the steps with `update_todo_list`, ticking each',
        'one off as it completes it.',
        '',
        'Set the goal yourself with `/goal <objective>` in the chat, or use',
        '**Set Goal** in this view\'s toolbar.',
      ].join('\n')
    );
    this.contextValue = 'todoEmptyNode';
  }
}

export class TodoTreeProvider implements vscode.TreeDataProvider<TodoSessionNode | TodoItemNode | TodoEmptyNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private storeSub: vscode.Disposable;

  constructor(private store: TodoStore) {
    // The store is the single source of truth (it also fires when the active
    // chat session changes), so one subscription keeps the tree live.
    this.storeSub = store.onDidChange(() => this.refresh());
  }

  /**
   * Adopt a rebuilt store. The services bundle (and therefore every store) is
   * recreated on org switch / ADO config change, so the view must re-subscribe
   * or it would keep rendering the stale instance.
   */
  setStore(store: TodoStore): void {
    this.storeSub.dispose();
    this.store = store;
    this.storeSub = store.onDidChange(() => this.refresh());
    this.refresh();
  }

  dispose(): void {
    this.storeSub.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TodoSessionNode | TodoItemNode | TodoEmptyNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TodoSessionNode | TodoItemNode | TodoEmptyNode): Array<TodoSessionNode | TodoItemNode | TodoEmptyNode> {
    if (element) {
      // Only session groups have children; leaves are terminal.
      if (element instanceof TodoSessionNode) {
        return element.summary.items.map(item => new TodoItemNode(element.sessionId, item));
      }
      return [];
    }

    const activeId = this.store.getActiveSessionId();
    // Sessions whose file was emptied are not stored at all, so every entry
    // here has items, a goal, or both.
    const lists = this.store.list().filter(l => l.items.length > 0 || !!l.goal);
    if (lists.length === 0) return [new TodoEmptyNode()];

    // Active session first; the rest keep the store's recency order.
    const ordered = [...lists].sort((a, b) => {
      const aActive = a.sessionId === activeId ? 0 : 1;
      const bActive = b.sessionId === activeId ? 0 : 1;
      return aActive - bActive;
    });
    return ordered.map(list => new TodoSessionNode(list.sessionId, list, list.sessionId === activeId));
  }

  /**
   * Checkbox toggles from the view. `completed` when ticked, back to `pending`
   * when unticked — the same transitions the AI's tool performs. Non-item
   * entries are ignored (only leaves carry checkboxes).
   */
  handleCheckboxChange(changes: readonly [vscode.TreeItem, vscode.TreeItemCheckboxState][]): void {
    for (const [node, state] of changes) {
      if (!(node instanceof TodoItemNode)) continue;
      const status: TodoStatus = state === vscode.TreeItemCheckboxState.Checked ? 'completed' : 'pending';
      this.store.setStatus(node.sessionId, node.item.id, status);
    }
  }

  /** Move an item to a specific status (context-menu actions). */
  setStatus(node: TodoItemNode, status: TodoStatus): void {
    this.store.setStatus(node.sessionId, node.item.id, status);
  }

  /** Set (or with an empty string, clear) a session's goal. */
  setGoal(node: TodoSessionNode, text: string): void {
    this.store.setGoal(node.sessionId, text, 'user', node.summary.sessionName);
  }

  /** Drop a session's goal (its items, if any, stay). */
  clearGoal(node: TodoSessionNode): void {
    this.store.clearGoal(node.sessionId);
  }

  /** Delete one item from its session's list. */
  removeItem(node: TodoItemNode): void {
    this.store.removeItem(node.sessionId, node.item.id);
  }

  /** Delete a whole session's list. */
  clearSession(sessionId: string): boolean {
    return this.store.remove(sessionId);
  }
}

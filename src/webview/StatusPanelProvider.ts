import * as vscode from 'vscode';
import { Services } from '../services';
import { getSettings } from '../config/settings';
import { AgentCapability } from '../agents/types';

export class StatusPanelProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached agent detection results (async → cached for sync getChildren). */
  private agentCapabilities: AgentCapability[] = [];

  /** Debounce timer for rapid config changes. */
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private services: Services) {
    // Kick off initial async agent detection; fire tree refresh when done
    // so the STATUS tree shows agents after the async probe completes.
    void this.refreshAgents().then(() => this._onDidChangeTreeData.fire(undefined));
  }

  /**
   * Full refresh: re-detect agents + re-render tree.
   * Call this when agents or deep structural data may have changed.
   */
  refresh(): void {
    void this.refreshAgents();
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Debounced refresh — coalesces rapid calls (e.g. tag/chip edits,
   * sequential config updates) into a single tree re-render after 300ms.
   */
  debouncedRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      this._onDidChangeTreeData.fire(undefined);
    }, 300);
  }

  /**
   * Lightweight refresh for data that doesn't affect agents.
   * Skips the async agent detection (no shell calls), just re-renders the
   * tree with current memory/MCP/mode snapshots.
   */
  refreshLight(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Handle a VS Code configuration change event. */
  onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration('adoCode')) return;

    // Only rebuild services + re-detect agents when ADO/agent-relevant
    // keys change. Everything else (mode, theme, etc.) is a light refresh.
    const agentKeys = [
      'adoCode.mcp.servers',
      'adoCode.agents',
    ];
    const needsAgentRefresh = agentKeys.some(k => e.affectsConfiguration(k));

    if (needsAgentRefresh) {
      this.refresh();
    } else {
      this.debouncedRefresh();
    }
  }

  /** Fire only the agents subtree (lighter than full refresh). */
  private async refreshAgents(): Promise<void> {
    try {
      this.agentCapabilities = await this.services.agents.detect();
    } catch {
      this.agentCapabilities = [];
    }
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: StatusItem): Promise<StatusItem[]> {
    if (element) return element.children ?? [];

    const items: StatusItem[] = [];

    // ── Mode ──────────────────────────────────────────────────────
    try {
      const settings = getSettings();
      const modeItem = new StatusItem(
        `Mode: ${settings.mode}`,
        vscode.TreeItemCollapsibleState.None
      );
      modeItem.iconPath = new vscode.ThemeIcon('compass');
      modeItem.command = { command: 'adoCode.setMode', title: 'Change Mode' };
      items.push(modeItem);
    } catch {
      // settings not configured yet
    }

    // ── Memory ────────────────────────────────────────────────────
    try {
      const userMemories = this.services.memory.getAll();
      const workspaceMemories = this.services.workspaceMemory.list();
      const memItem = new StatusItem(
        `Memory: ${userMemories.length} user, ${workspaceMemories.length} workspace`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      memItem.iconPath = new vscode.ThemeIcon('brain');
      for (const entry of userMemories) {
        const child = new StatusItem(
          `[${entry.category}] ${entry.key}: ${entry.content.substring(0, 60)}`,
          vscode.TreeItemCollapsibleState.None
        );
        child.iconPath = new vscode.ThemeIcon('person');
        child.description = new Date(entry.timestamp).toLocaleDateString();
        child.contextValue = 'statusMemoryUser';
        child.meta = { key: entry.key, category: entry.category, content: entry.content, source: 'user' };
        memItem.children = memItem.children ?? [];
        memItem.children.push(child);
      }
      for (const key of workspaceMemories) {
        const child = new StatusItem(key, vscode.TreeItemCollapsibleState.None);
        child.iconPath = new vscode.ThemeIcon('folder');
        child.contextValue = 'statusMemoryWorkspace';
        child.meta = { key, source: 'workspace' };
        memItem.children = memItem.children ?? [];
        memItem.children.push(child);
      }
      items.push(memItem);
    } catch {
      // memory not available
    }

    // ── MCP ───────────────────────────────────────────────────────
    try {
      const mcpServers = this.services.mcp.getConnectedServers();
      const mcpItem = new StatusItem(
        `MCP: ${mcpServers.length} server(s) connected`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      mcpItem.iconPath = new vscode.ThemeIcon('plug');
      for (const name of mcpServers) {
        const child = new StatusItem(name, vscode.TreeItemCollapsibleState.None);
        child.iconPath = new vscode.ThemeIcon('check');
        mcpItem.children = mcpItem.children ?? [];
        mcpItem.children.push(child);
      }
      if (mcpServers.length === 0) {
        const child = new StatusItem('No servers connected', vscode.TreeItemCollapsibleState.None);
        child.description = 'Configure adoCode.mcp.servers';
        mcpItem.children = mcpItem.children ?? [];
        mcpItem.children.push(child);
      }
      items.push(mcpItem);
    } catch {
      // mcp not available
    }

    // ── Agents ────────────────────────────────────────────────────
    try {
      const installed = this.agentCapabilities.filter(a => a.installed);
      if (installed.length > 0) {
        const agentItem = new StatusItem('Agents', vscode.TreeItemCollapsibleState.Expanded);
        agentItem.iconPath = new vscode.ThemeIcon('hubot');
        for (const agent of installed) {
          const child = new StatusItem(
            agent.displayName,
            vscode.TreeItemCollapsibleState.None
          );
          child.iconPath = new vscode.ThemeIcon('check');
          child.description = agent.version ?? 'installed';
          child.contextValue = 'statusAgent';
          child.meta = { name: agent.name, displayName: agent.displayName, version: agent.version };
          agentItem.children = agentItem.children ?? [];
          agentItem.children.push(child);
        }
        items.push(agentItem);
      }
    } catch {
      // agents not available
    }

    // ── Worktrees (agent isolation) ──────────────────────────────
    try {
      const worktrees = await this.services.git.listWorktrees();
      if (worktrees.length > 0) {
        const wtItem = new StatusItem(
          `Worktrees: ${worktrees.length} active`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        wtItem.iconPath = new vscode.ThemeIcon('folder-opened');
        for (const wt of worktrees) {
          const child = new StatusItem(
            wt.branch,
            vscode.TreeItemCollapsibleState.None
          );
          child.iconPath = new vscode.ThemeIcon('git-branch');
          child.description = wt.runId;
          child.tooltip = wt.path;
          child.contextValue = 'statusWorktree';
          child.meta = { runId: wt.runId, path: wt.path, branch: wt.branch };
          wtItem.children = wtItem.children ?? [];
          wtItem.children.push(child);
        }
        items.push(wtItem);
      }
    } catch {
      // worktrees not available
    }

    return items;
  }
}

class StatusItem extends vscode.TreeItem {
  children?: StatusItem[];
  /** Extra metadata carried for context-menu commands. */
  meta?: Record<string, any>;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    openCommand?: vscode.Command
  ) {
    super(label, collapsibleState);
    if (openCommand) this.command = openCommand;
  }
}

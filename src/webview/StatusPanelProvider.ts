import * as vscode from 'vscode';
import { Services } from '../services';
import { getSettings } from '../config/settings';
import { AgentCapability } from '../agents/types';
import { AgentRunner } from '../agents/AgentRunner';

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export class StatusPanelProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached agent detection results (async → cached for sync getChildren). */
  private agentCapabilities: AgentCapability[] = [];
  private agentRunner?: AgentRunner;

  /** Debounce timer for rapid config changes. */
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private services: Services) {
    // Kick off initial async agent detection; fire tree refresh when done
    // so the STATUS tree shows agents after the async probe completes.
    void this.refreshAgents().then(() => this._onDidChangeTreeData.fire(undefined));
  }

  setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
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
      modeItem.contextValue = 'statusMode';
      modeItem.meta = { mode: settings.mode };
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
      memItem.contextValue = 'statusMemory';
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
        child.contextValue = 'statusMcpServer';
        child.meta = { name };
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

    // ── Worktrees ─────────────────────────────────────────────────
    // Removed: superseded by the dedicated "Worktrees" view
    // (adoCode.worktrees / WorktreesTreeProvider), which shows per-worktree
    // run status, dirty files, last commit and ahead/behind. The context
    // menus (Open in Terminal/Explorer, Remove) are shared via the
    // `worktreeNode` contextValue.

    // ── Recent Runs ──────────────────────────────────────────────
    try {
      if (this.agentRunner) {
        const runs = this.agentRunner.listRuns()
          .filter(r => r.status !== 'running')
          .sort((a, b) => {
            const aTime = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
            const bTime = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
            return bTime - aTime;
          })
          .slice(0, 10);

        const runsItem = new StatusItem('Recent Runs', vscode.TreeItemCollapsibleState.Expanded);
        runsItem.iconPath = new vscode.ThemeIcon('history');
        if (runs.length === 0) {
          const child = new StatusItem('No recent runs', vscode.TreeItemCollapsibleState.None);
          runsItem.children = runsItem.children ?? [];
          runsItem.children.push(child);
        } else {
          for (const run of runs) {
            const statusIcon =
              run.status === 'succeeded' ? 'check' :
              run.status === 'failed' ? 'error' :
              run.status === 'cancelled' ? 'close' :
              'warning'; // interrupted
            const label = `#${run.workItemId ?? '?'} — ${run.agent}`;
            const timeDesc = run.finishedAt ? relativeTime(run.finishedAt) : '';
            const child = new StatusItem(label, vscode.TreeItemCollapsibleState.None);
            child.iconPath = new vscode.ThemeIcon(statusIcon);
            child.description = timeDesc;
            child.contextValue = 'statusRun';
            child.meta = { runId: run.id, status: run.status, summary: run.summary, worktreePath: run.worktreePath };
            runsItem.children = runsItem.children ?? [];
            runsItem.children.push(child);
          }
        }
        items.push(runsItem);
      }
    } catch {
      // agentRunner not available
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

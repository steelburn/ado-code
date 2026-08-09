import * as vscode from 'vscode';
import { Services } from '../services';
import { AgentRunner } from '../agents/AgentRunner';
import { AgentRun } from '../agents/types';
import { logger } from '../services/logger';

/**
 * Dedicated "Worktrees" sidebar view: one node per agent worktree under
 * `.ado-code/worktrees/`, with per-worktree detail children (agent run info,
 * dirty/clean files, last commit, ahead/behind, path). The run record is
 * joined from AgentRunner by id — listWorktrees() returns the full run id
 * (`run-<ts>-<workItemId>`), which matches AgentRunner's run ids directly.
 *
 * Refreshes when a run's status changes (delegate start, cancel, completion)
 * via refreshIfChanged(), on explicit refresh, and after worktree removal.
 */
interface WorktreeEntry {
  runId: string;
  path: string;
  branch: string;
  run?: AgentRun;
  dirty: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
  lastCommit: string | null;
}

export { WorktreeEntry };

export class WorktreesTreeProvider implements vscode.TreeDataProvider<WorktreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorktreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private worktreeNodes: WorktreeNode[] = [];
  private rootNode!: WorktreeNode;
  private agentRunner?: AgentRunner;
  // Last seen run status per run id — reload the tree only when the status
  // actually changes (start/cancel/complete) instead of on every streamed chunk.
  private lastStatus = new Map<string, string>();
  // Serializes reloads so concurrent triggers (constructor, status changes)
  // never interleave; awaiting refresh() waits for the LAST enqueued reload.
  private reloadChain: Promise<void> = Promise.resolve();

  constructor(private services: Services) {
    this.rootNode = new WorktreeNode(
      'Worktrees',
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.rootNode.contextValue = 'worktreesRoot';
    this.rootNode.iconPath = new vscode.ThemeIcon('git-branch');
    void this.enqueueReload();
  }

  setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
  }

  /**
   * Remove all worktrees whose agent run is in a terminal (completed)
   * state: succeeded, failed, cancelled, or interrupted.
   * Returns the number of worktrees removed.
   */
  async removeAllCompleted(): Promise<number> {
    if (!this.agentRunner) return 0;
    const runs = this.agentRunner.listRuns();
    const completed = runs.filter(
      (r) =>
        r.status === 'succeeded' ||
        r.status === 'failed' ||
        r.status === 'cancelled' ||
        r.status === 'interrupted'
    );
    let removed = 0;
    for (const run of completed) {
      try {
        await this.services.git.removeWorktree(run.id);
        await this.services.git.deleteBranchIfMerged(run.branch ?? '');
        removed++;
      } catch {
        // Best effort — worktree may already be gone or branch may not exist
      }
    }
    await this.enqueueReload();
    return removed;
  }

  /** Called after each successful reload with the fresh entries — the host
   * wires the post-merge cleanup auto-offer here. */
  onReloaded?: (entries: WorktreeEntry[]) => void;

  /** Full re-read of worktrees + git details. Resolves when the reload lands. */
  refresh(): Promise<void> {
    return this.enqueueReload();
  }

  /**
   * Reload when a run's status changed (cheap check, callable per chunk).
   * Returns the reload chain so callers can await the settled state.
   */
  refreshIfChanged(run: AgentRun): Promise<void> {
    if (this.lastStatus.get(run.id) !== run.status) {
      this.lastStatus.set(run.id, run.status);
      return this.enqueueReload();
    }
    return this.reloadChain;
  }

  private enqueueReload(): Promise<void> {
    this.reloadChain = this.reloadChain
      .then(() => this.doReload())
      .catch(() => { /* keep the chain alive on unexpected errors */ });
    return this.reloadChain;
  }

  private async doReload(): Promise<void> {
    try {
      const list = await this.services.git.listWorktrees();
      const runs = this.agentRunner?.listRuns() ?? [];
      const entries = await Promise.all(
        list.map(async (wt) => {
          const run = runs.find((r) => r.id === wt.runId);
          const info = await this.services.git.getWorktreeInfo(wt.path);
          return { runId: wt.runId, path: wt.path, branch: wt.branch, run, ...info };
        })
      );
      this.worktreeNodes = entries.map((e) => this.toNode(e));
      this.rootNode.children = this.worktreeNodes;
      // Host hook: post-merge cleanup auto-offer (fire-and-forget — the
      // host throttles ADO polling per run).
      try { this.onReloaded?.(entries); } catch { /* never break the tree */ }
    } catch (err) {
      logger.error('Worktrees: reload failed', err);
      this.worktreeNodes = [];
      this.rootNode.children = [];
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  private toNode(e: WorktreeEntry): WorktreeNode {
    const run = e.run;
    const status = run?.status ?? 'unknown';
    const node = new WorktreeNode(e.branch, vscode.TreeItemCollapsibleState.Expanded);
    node.iconPath =
      status === 'running'
        ? new vscode.ThemeIcon('sync~spin')
        : status === 'succeeded'
          ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
          : status === 'failed'
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
            : status === 'interrupted' || status === 'cancelled'
              ? new vscode.ThemeIcon('circle-slash')
              : new vscode.ThemeIcon('git-branch');
    node.description = run
      ? `#ADO-${run.workItemId} · ${run.agent} · ${status}`
      : `${e.runId} · no run record`;
    node.tooltip = e.path;
    node.contextValue = 'worktreeNode';
    node.meta = { runId: e.runId, path: e.path, branch: e.branch };

    const children: WorktreeNode[] = [];

    if (run) {
      const started = new Date(run.startedAt).toLocaleTimeString();
      const duration = run.finishedAt ? fmtDuration(run.startedAt, run.finishedAt) : 'running';
      children.push(
        new WorktreeNode(
          `Run: ${run.agent} · ${status} · started ${started} · ${duration}`,
          vscode.TreeItemCollapsibleState.None,
          'hubot'
        )
      );
    }

    children.push(
      new WorktreeNode(
        e.dirty ? `Files: ${e.changedFiles} changed (dirty)` : 'Files: clean',
        vscode.TreeItemCollapsibleState.None,
        e.dirty ? 'warning' : 'check'
      )
    );
    children.push(
      new WorktreeNode(
        e.lastCommit ? `Last commit: ${e.lastCommit}` : 'Last commit: (none yet)',
        vscode.TreeItemCollapsibleState.None,
        'git-commit'
      )
    );
    children.push(
      new WorktreeNode(
        `Branch: ahead ${e.ahead} · behind ${e.behind}`,
        vscode.TreeItemCollapsibleState.None,
        'git-compare'
      )
    );
    children.push(new WorktreeNode(`Path: ${e.path}`, vscode.TreeItemCollapsibleState.None, 'folder'));

    node.children = children;
    return node;
  }

  getTreeItem(element: WorktreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorktreeNode): WorktreeNode[] {
    if (!element) return [this.rootNode];
    return element.children ?? [];
  }
}

export class WorktreeNode extends vscode.TreeItem {
  children?: WorktreeNode[];
  /** Extra metadata carried for context-menu commands. */
  meta?: Record<string, any>;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    icon?: string
  ) {
    super(label, collapsibleState);
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Human-readable duration between two ISO timestamps (e.g. "3m", "1h 5m"). */
function fmtDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '…';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

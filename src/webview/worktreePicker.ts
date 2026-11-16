import * as vscode from 'vscode';
import type { Services } from '../services';
import type { AgentRunner } from '../agents/AgentRunner';
import { logger } from '../services/logger';

/**
 * Worktree picker used by the Worktrees view-title bulk actions.
 *
 * The per-worktree context menu knows which worktree it was invoked on; the
 * view-title buttons do not, so they ask first. The QuickPick item shape is
 * built by a pure function and the VS Code window calls are injectable, so the
 * whole flow stays unit-testable without a VS Code host.
 */

export type WorktreeReviewAction = 'accept' | 'reject';

/** Minimal worktree facts needed to render one picker row. */
export interface WorktreePickSource {
  path: string;
  branch: string;
  runId: string;
  /** ADO work item title of the run that owns the worktree, when known. */
  runTitle?: string;
  /** Number of changed files the run carries (0 = nothing to review). */
  changeCount: number;
  /** How many of those this workspace already holds (accepted already). */
  appliedCount?: number;
}

export interface WorktreePickItem extends vscode.QuickPickItem {
  worktreePath: string;
  changeCount: number;
}

/** VS Code window calls, overridable in tests. */
export interface WorktreePickerDeps {
  showQuickPick?: (
    items: WorktreePickItem[],
    options?: vscode.QuickPickOptions
  ) => Thenable<WorktreePickItem | undefined>;
  showInformationMessage?: (message: string) => Thenable<unknown>;
  showErrorMessage?: (message: string) => Thenable<unknown>;
}

/** Last path segment, tolerating both separators (worktree paths are absolute). */
function baseName(p: string): string {
  const parts = (p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : (p || '');
}

/**
 * Build the picker rows: worktrees with changes first (most changes first),
 * then the empty ones alphabetically, so the interesting target is on Enter.
 */
export function buildWorktreePickItems(sources: WorktreePickSource[]): WorktreePickItem[] {
  const labelOf = (s: WorktreePickSource): string =>
    (s.runTitle ?? '').trim() || (s.branch ?? '').trim() || baseName(s.path);

  return [...sources]
    .sort((a, b) => {
      if (a.changeCount !== b.changeCount) return b.changeCount - a.changeCount;
      return labelOf(a).localeCompare(labelOf(b));
    })
    .map((s) => ({
      label: labelOf(s),
      description:
        s.changeCount === 0
          ? 'no changes'
          : `${s.changeCount} change${s.changeCount === 1 ? '' : 's'}` +
            ((s.appliedCount ?? 0) > 0 ? ` · ${s.appliedCount} applied` : ''),
      detail: s.path,
      worktreePath: s.path,
      changeCount: s.changeCount,
    }));
}

/**
 * Ask which worktree the bulk action applies to.
 *
 * Returns the absolute worktree path, or undefined when the user cancelled or
 * there is nothing to pick. Failures are surfaced to the user, never thrown.
 */
export async function pickWorktreeForReview(
  services: Services,
  agentRunner: Pick<AgentRunner, 'listRuns'> | undefined,
  action: WorktreeReviewAction,
  deps: WorktreePickerDeps = {}
): Promise<string | undefined> {
  const showQuickPick = deps.showQuickPick ?? vscode.window.showQuickPick;
  const showInfo = deps.showInformationMessage ?? vscode.window.showInformationMessage;
  const showError = deps.showErrorMessage ?? vscode.window.showErrorMessage;

  let worktrees: Array<{ runId: string; path: string; branch: string }>;
  try {
    worktrees = await services.git.listWorktrees();
  } catch (err) {
    void showError(
      `ADO Code: could not list worktrees — ${err instanceof Error ? err.message : err}`
    );
    return undefined;
  }

  if (worktrees.length === 0) {
    void showInfo('ADO Code: there are no agent worktrees to review.');
    return undefined;
  }

  const runs = agentRunner?.listRuns() ?? [];
  const sources = await Promise.all(
    worktrees.map(async (wt): Promise<WorktreePickSource> => {
      let changeCount = 0;
      let appliedCount = 0;
      try {
        const set = await services.git.listWorktreeChanges(wt.path);
        changeCount = set.changes.length;
        appliedCount = set.changes.filter((c) => c.applied).length;
      } catch (err) {
        // A worktree mid-cleanup can refuse `git status` — keep the row, just
        // without a count, instead of failing the whole picker.
        logger.error(`Worktrees: could not read changes for ${wt.path}`, err);
      }
      return {
        path: wt.path,
        branch: wt.branch,
        runId: wt.runId,
        runTitle: runs.find((r) => r.id === wt.runId)?.title,
        changeCount,
        appliedCount,
      };
    })
  );

  const picked = await showQuickPick(buildWorktreePickItems(sources), {
    title:
      action === 'accept'
        ? 'Accept all changes — pick a worktree'
        : 'Reject all changes — pick a worktree',
    placeHolder:
      action === 'accept'
        ? 'Files copied from the selected worktree into this workspace'
        : 'Files discarded inside the selected worktree',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.worktreePath;
}

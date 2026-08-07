import * as path from 'path';

/**
 * Post-merge cleanup for agent worktrees (vscode-free, fast-testable).
 *
 * Round-2 guardrail Task 3: when the PR for an agent run's branch has been
 * COMPLETED and MERGED (ADO pull request `status === 'completed'` and
 * `mergeStatus === 'succeeded'`), the worktree and its local branch are no
 * longer needed — remove the worktree and delete the now-merged branch.
 */

export interface MergeCleanupDeps {
  git: {
    workspaceRoot: string;
    removeWorktree(runId: string): Promise<void>;
    deleteBranchIfMerged(branch: string): Promise<boolean>;
  };
  ado: {
    getPullRequestsBySourceBranch(
      project: string,
      repo: string,
      branch: string
    ): Promise<Array<{ pullRequestId: number; status: string; mergeStatus: string; url?: string }>>;
  };
  /** Run lookup — lets the caller inject AgentRunner.listRuns().find(). */
  getRun(runId: string): { id: string; branch?: string } | undefined;
}

/** True when the branch has at least one completed + successfully-merged PR. */
export async function hasMergedPullRequest(
  run: { id: string; branch?: string } | undefined,
  project: string,
  deps: MergeCleanupDeps
): Promise<boolean> {
  if (!run?.branch) return false;
  const repo = path.basename(deps.git.workspaceRoot) || 'repo';
  const prs = await deps.ado.getPullRequestsBySourceBranch(project, repo, run.branch);
  return prs.some(p => p.status === 'completed' && p.mergeStatus === 'succeeded');
}

/**
 * Remove the run's worktree and delete its branch when the PR merged.
 * No-op (with a reason) when the run is missing, has no branch, or its PR
 * hasn't merged yet. Never throws — callers surface the reason.
 */
export async function cleanupMergedRun(
  runId: string,
  project: string,
  deps: MergeCleanupDeps
): Promise<{ cleaned: boolean; reason?: string; branchDeleted?: boolean }> {
  const run = deps.getRun(runId);
  if (!run) return { cleaned: false, reason: `run '${runId}' not found` };
  if (!run.branch) return { cleaned: false, reason: `run '${runId}' has no branch` };
  const merged = await hasMergedPullRequest(run, project, deps);
  if (!merged) {
    return { cleaned: false, reason: `PR for '${run.branch}' not completed+merged yet` };
  }
  await deps.git.removeWorktree(run.id);
  const branchDeleted = await deps.git.deleteBranchIfMerged(run.branch);
  return { cleaned: true, branchDeleted };
}

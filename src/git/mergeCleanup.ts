import * as path from 'path';

/**
 * Post-merge cleanup for agent worktrees (vscode-free, fast-testable).
 *
 * Round-2 guardrail Task 3: when the PR for an agent run's branch has been
 * COMPLETED and MERGED (ADO pull request `status === 'completed'` and
 * `mergeStatus === 'succeeded'`), the worktree and its local branch are no
 * longer needed — remove the worktree and delete the now-merged branch.
 *
 * The ADO PR lookup is ADVISORY: the action itself is pure local git, so a
 * failing lookup — 401 from a missing or expired PAT, 404 for a repo the active
 * organisation does not host, a timeout, or a run that was never tied to a work
 * item — must not abort it. On failure the verdict falls back to the LOCAL
 * merged state (`git branch --merged`), which is exactly what
 * deleteBranchIfMerged enforces anyway.
 */

export interface MergeCleanupDeps {
  git: {
    workspaceRoot: string;
    removeWorktree(runId: string): Promise<void>;
    deleteBranchIfMerged(branch: string): Promise<boolean>;
    /** Local fallback when ADO cannot be asked (absent in lightweight fakes). */
    isBranchMerged?(branch: string): Promise<boolean>;
    /** Unconditional `git branch -D`; only the forced (unverified) cleanup uses it. */
    forceDeleteBranch?(branch: string): Promise<boolean>;
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

/** How the "may this branch be cleaned up?" question was answered. */
export interface MergeVerdict {
  /** Merged PR, or — when ADO could not be asked — a locally merged branch. */
  merged: boolean;
  /** Set when the ADO PR lookup itself failed; `merged` then comes from git. */
  prCheckError?: string;
  /** True when ADO could not answer and the local merged state decided. */
  localFallback?: boolean;
}

/** Turn an ADO lookup failure into something the user can act on. */
export function describePrCheckError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b401\b/.test(msg)) {
    return `ADO rejected the credentials (401) — check adoCode.adoPat / adoCode.adoOrganization: ${msg}`;
  }
  if (/\b403\b/.test(msg)) {
    return `ADO denied access (403) — the PAT needs Code (Read) scope: ${msg}`;
  }
  if (/\b404\b/.test(msg)) {
    return `ADO has no such project or repo (404) — check adoCode.adoProject: ${msg}`;
  }
  return msg;
}

/**
 * Resolve the merge state of the run's branch. Never throws: when the ADO PR
 * search fails, the verdict falls back to the local merged state so an
 * unrelated auth or configuration problem cannot block a local git cleanup.
 */
export async function probeMergeState(
  run: { id: string; branch?: string } | undefined,
  project: string,
  deps: MergeCleanupDeps
): Promise<MergeVerdict> {
  if (!run?.branch) return { merged: false };
  const repo = path.basename(deps.git.workspaceRoot) || 'repo';
  try {
    const prs = await deps.ado.getPullRequestsBySourceBranch(project, repo, run.branch);
    return { merged: prs.some(pr => pr.status === 'completed' && pr.mergeStatus === 'succeeded') };
  } catch (err) {
    const prCheckError = describePrCheckError(err);
    let localMerged = false;
    try {
      localMerged = deps.git.isBranchMerged ? await deps.git.isBranchMerged(run.branch) : false;
    } catch {
      localMerged = false;
    }
    return { merged: localMerged, prCheckError, localFallback: true };
  }
}

/**
 * True when the branch may be cleaned up: a completed + merged PR, or — when
 * ADO could not be asked — a branch already merged into the base branch.
 */
export async function hasMergedPullRequest(
  run: { id: string; branch?: string } | undefined,
  project: string,
  deps: MergeCleanupDeps
): Promise<boolean> {
  return (await probeMergeState(run, project, deps)).merged;
}

/** Options for {@link cleanupMergedRun}. */
export interface CleanupOptions {
  /**
   * Skip the merge guard. Honoured ONLY when the guard could not be evaluated
   * because the ADO lookup failed — an explicit "not merged" answer stands.
   */
  force?: boolean;
}

/**
 * Remove the run's worktree and delete its merged branch. Never throws —
 * callers surface the reason. An ADO outage degrades to the local merge check
 * instead of failing the whole action; `opts.force` then lets the user discard
 * a worktree whose merge state cannot be verified (branch force-deleted).
 */
export async function cleanupMergedRun(
  runId: string,
  project: string,
  deps: MergeCleanupDeps,
  opts?: CleanupOptions
): Promise<{
  cleaned: boolean;
  reason?: string;
  branchDeleted?: boolean;
  prCheckError?: string;
  localFallback?: boolean;
  /** True when the merge guard was skipped because the merge state was unverifiable. */
  forced?: boolean;
}> {
  const run = deps.getRun(runId);
  if (!run) return { cleaned: false, reason: `run '${runId}' not found` };
  if (!run.branch) return { cleaned: false, reason: `run '${runId}' has no branch` };
  const verdict = await probeMergeState(run, project, deps);
  // Forcing is honoured ONLY when ADO could not answer: an explicit
  // "not merged" verdict means the work is genuinely unmerged — refuse.
  const forced = !verdict.merged && !!opts?.force && !!verdict.prCheckError;
  if (!verdict.merged && !forced) {
    return {
      cleaned: false,
      prCheckError: verdict.prCheckError,
      localFallback: verdict.localFallback,
      reason: verdict.prCheckError
        ? `PR lookup failed (${verdict.prCheckError}) and '${run.branch}' is not merged into the base branch`
        : `PR for '${run.branch}' is not completed+merged yet`,
    };
  }
  await deps.git.removeWorktree(run.id);
  const branchDeleted = forced
    ? deps.git.forceDeleteBranch
      ? await deps.git.forceDeleteBranch(run.branch)
      : false
    : await deps.git.deleteBranchIfMerged(run.branch);
  return {
    cleaned: true,
    branchDeleted,
    prCheckError: verdict.prCheckError,
    localFallback: verdict.localFallback,
    forced: forced || undefined,
  };
}

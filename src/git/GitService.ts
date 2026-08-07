import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const execFile = promisify(cp.execFile);

/** Worktree directory name prefix under .ado-code/worktrees/. */
const WORKTREE_PREFIX = 'run-';

/** Per-worktree git details (see GitService.getWorktreeInfo). */
export interface WorktreeInfo {
  dirty: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
  lastCommit: string | null;
}

export class GitService {
  // public readonly so ChatViewProvider's offerPushAndPr (Task 11) can pass
  // the cwd to git push / gh pr create.
  constructor(public readonly workspaceRoot: string) {}

  /** Verify the workspace is inside a git repository. */
  async isGitRepo(): Promise<boolean> {
    if (!this.workspaceRoot) return false;
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Get the current branch name. */
  async getCurrentBranch(): Promise<string | null> {
    try {
      const { stdout } = await execFile('git', ['branch', '--show-current'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Create a feature branch for a work item: feature/ADO-1234-fix-login-bug
   * Returns the branch name, or null if the branch already exists.
   */
  async createTaskBranch(workItemId: number, title: string): Promise<string | null> {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const branchName = `feature/ADO-${workItemId}-${slug}`;

    // Exists-check for unborn branches: in a repo with NO commits, the branch
    // is "unborn" — `git branch --list` shows nothing and `git checkout -b`
    // on the same name SUCCEEDS (git treats it as re-choosing the unborn ref).
    // The reliable signal is `git branch --show-current` matching the target.
    const current = await this.getCurrentBranch();
    if (current === branchName) {
      return null; // already on this (possibly unborn) branch
    }
    try {
      const { stdout } = await execFile('git', ['branch', '--list', branchName], {
        cwd: this.workspaceRoot,
      });
      if (stdout.trim().length > 0) {
        return null; // branch already exists
      }
    } catch {
      // fall through and try to create
    }

    try {
      await execFile('git', ['checkout', '-b', branchName], { cwd: this.workspaceRoot });
      return branchName;
    } catch (err) {
      // Belt-and-braces: if checkout reports it already exists, treat as exists.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) return null;
      throw err;
    }
  }

  /** Check for uncommitted changes that would block a clean branch switch. */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const { stdout } = await execFile('git', ['status', '--porcelain'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim().length > 0;
    } catch {
      return true; // assume dirty if we can't check
    }
  }

  /** Q6: short commit hash of HEAD (for changelog entries). */
  async getShortCommitHash(): Promise<string | null> {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Stage and commit the changelog update with a work-item reference. */
  async commitChangelog(filePath: string, workItemId: number, title: string): Promise<void> {
    const message = `docs: update changelog for ADO-${workItemId} (${title})`;
    // SECURITY: use execFile with arg arrays — never interpolate the work-item
    // title into a shell string (title is attacker-controllable ADO data).
    // Also commit with a pathspec so pre-staged unrelated files aren't swept in.
    await execFile('git', ['add', filePath], {
      cwd: this.workspaceRoot,
    });
    await execFile('git', ['commit', '-m', message, '--', filePath], {
      cwd: this.workspaceRoot,
    });
  }

  /** Task 24: porcelain status (agent work verification). */
  async getStatusPorcelain(): Promise<string> {
    try {
      const { stdout } = await execFile('git', ['status', '--porcelain'], {
        cwd: this.workspaceRoot,
      });
      return stdout;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  /** Task 24: diff stat (bounded by the caller). */
  async getDiffStat(): Promise<string> {
    try {
      const { stdout } = await execFile('git', ['diff', '--stat'], {
        cwd: this.workspaceRoot,
      });
      return stdout;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  /** Get the staged diff for commit message generation. */
  async getStagedDiff(): Promise<string> {
    try {
      const { stdout } = await execFile('git', ['diff', '--cached', '--stat'], {
        cwd: this.workspaceRoot,
      });
      if (!stdout.trim()) return '';

      const { stdout: diff } = await execFile('git', ['diff', '--cached'], {
        cwd: this.workspaceRoot,
      });
      return diff;
    } catch {
      return '';
    }
  }

  /** Check if there are staged changes. */
  async hasStagedChanges(): Promise<boolean> {
    try {
      const { stdout } = await execFile('git', ['diff', '--cached', '--name-only'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  // ── Worktree management (concurrent agent isolation) ─────────────

  /** Get the base directory for agent worktrees. */
  private worktreeBase(): string {
    return path.join(this.workspaceRoot, '.ado-code', 'worktrees');
  }

  /**
   * Directory name for an agent worktree: the run id itself when it already
   * carries the `run-` prefix (AgentRunner ids are `run-<ts>-<workItemId>`),
   * otherwise prefixed. This prevents the old `run-run-…` double prefix.
   */
  private worktreeDirName(runId: string): string {
    return runId.startsWith(WORKTREE_PREFIX) ? runId : `${WORKTREE_PREFIX}${runId}`;
  }

  /**
   * Create an isolated git worktree for an agent run.
   * Returns the absolute path to the new working directory.
   * Creates the branch from HEAD if it doesn't exist yet.
   */
  async createWorktree(runId: string, branchName: string): Promise<string> {
    const base = this.worktreeBase();
    const wtDir = path.join(base, this.worktreeDirName(runId));

    // Ensure base directory exists
    await execFile('mkdir', ['-p', base], { cwd: this.workspaceRoot });

    // Check if branch exists; if not, create it from HEAD
    try {
      const { stdout } = await execFile('git', ['branch', '--list', branchName], {
        cwd: this.workspaceRoot,
      });
      if (stdout.trim().length === 0) {
        // Branch doesn't exist — create it from HEAD
        await execFile('git', ['branch', branchName], { cwd: this.workspaceRoot });
      }
    } catch {
      // If we can't check, just try to create the worktree — it will fail
      // with a clear error if the branch doesn't exist.
    }

    // Create the worktree
    await execFile('git', ['worktree', 'add', wtDir, branchName], {
      cwd: this.workspaceRoot,
    });

    return wtDir;
  }

  /**
   * Remove a worktree and its directory.
   * If the worktree has uncommitted changes, they are discarded.
   */
  async removeWorktree(runId: string): Promise<void> {
    const base = this.worktreeBase();
    // New worktrees live at the run id directly; legacy ones carry the extra
    // `run-` prefix (run-run-…). Try both so old worktrees still clean up.
    const candidates = [
      path.join(base, runId),
      path.join(base, `${WORKTREE_PREFIX}${runId}`),
    ];
    for (const wtDir of candidates) {
      try {
        // Force remove — discards uncommitted changes
        await execFile('git', ['worktree', 'remove', '--force', wtDir], {
          cwd: this.workspaceRoot,
        });
        return;
      } catch {
        // Try the next candidate / fall through to manual cleanup.
      }
    }
    // If git worktree remove failed for every candidate, try manual cleanup.
    for (const wtDir of candidates) {
      try {
        await execFile('rm', ['-rf', wtDir], { cwd: this.workspaceRoot });
      } catch {
        // Best effort — directory may already be gone
      }
    }
  }

  /**
   * List all agent worktrees under .ado-code/worktrees/.
   * Returns array of { runId, path, branch } objects.
   */
  async listWorktrees(): Promise<Array<{ runId: string; path: string; branch: string }>> {
    const base = this.worktreeBase();
    try {
      // Get worktree list in parseable format
      const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], {
        cwd: this.workspaceRoot,
      });

      const worktrees: Array<{ runId: string; path: string; branch: string }> = [];
      const blocks = stdout.split('\n\n').filter(b => b.trim());

      for (const block of blocks) {
        const lines = Object.fromEntries(
          block.split('\n').map(l => {
            const idx = l.indexOf(' ');
            return idx > 0 ? [l.substring(0, idx), l.substring(idx + 1)] : [l, ''];
          })
        );

        const wtPath = lines['worktree'] ?? '';
        // `--porcelain` puts the branch on a `branch` line (HEAD is the bare
        // commit hash). Reading HEAD here would label worktrees with hashes.
        const branch = (lines['branch'] ?? lines['HEAD'] ?? '').replace('refs/heads/', '');

        // Only include our agent worktrees (under .ado-code/worktrees/run-*)
        if (wtPath.startsWith(base) && wtPath.includes(`${WORKTREE_PREFIX}`)) {
          const dirName = path.basename(wtPath);
          // Legacy dirs were created as `run-` + runId (double prefix, e.g.
          // run-run-1785…); new dirs are exactly the run id (run-1785…).
          // Normalize both to the canonical run id (which starts with 'run-').
          const runId = dirName.startsWith('run-run-') ? dirName.slice('run-'.length) : dirName;
          worktrees.push({ runId, path: wtPath, branch });
        }
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  /** Absolute path of a run's worktree directory (whether or not it exists yet). */
  public getWorktreePath(runId: string): string {
    return path.join(this.worktreeBase(), this.worktreeDirName(runId));
  }

  /**
   * Resolve the EXISTING worktree dir for a run id, honoring both layouts:
   * new dirs are the run id verbatim (run-<ts>-<id>), legacy dirs carry an
   * extra `run-` prefix (run-run-<ts>-<id>). listWorktrees() normalizes both
   * to the canonical run id, so commit/push/status MUST try both candidates
   * or they compute a cwd that does not exist — which Node reports as
   * "spawn git ENOENT" (the same misleading error as a missing git binary).
   * Falls back to the primary candidate when neither exists yet (fresh run).
   */
  public resolveWorktreePath(runId: string): string {
    const base = this.worktreeBase();
    const primary = path.join(base, this.worktreeDirName(runId));
    const legacy = path.join(base, `${WORKTREE_PREFIX}${runId}`);
    return fs.existsSync(primary) ? primary : fs.existsSync(legacy) ? legacy : primary;
  }

  /** Worktree status for a run id (dirty/changed/ahead/behind/lastCommit). */
  public async getWorktreeInfoForRun(runId: string): Promise<WorktreeInfo> {
    return this.getWorktreeInfo(this.resolveWorktreePath(runId));
  }

  /**
   * Commit ALL changes in the run's worktree. Never force-pushes, never
   * touches main. Returns { committed: false, reason } when there is
   * nothing to commit, and the commit hash on success.
   */
  public async commitWorktreeChanges(
    runId: string,
    message: string
  ): Promise<{ committed: boolean; reason?: string; hash?: string }> {
    const wtDir = this.resolveWorktreePath(runId);
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: wtDir });
    if (!stdout.trim()) {
      return { committed: false, reason: 'nothing-to-commit' };
    }
    await execFile('git', ['add', '-A'], { cwd: wtDir });
    const commit = await execFile('git', ['commit', '-m', message], { cwd: wtDir });
    const hashMatch = commit.stdout.match(/^\[[^\]]+ ([0-9a-f]{7,40})\]/m);
    return { committed: true, hash: hashMatch ? hashMatch[1] : undefined };
  }

  /**
   * Push the run's worktree branch to origin (set upstream). Guarded: never
   * force-push, never pushes main/master. Returns the pushed branch name.
   */
  public async pushWorktreeBranch(runId: string): Promise<{ pushed: boolean; branch?: string; reason?: string }> {
    const wtDir = this.resolveWorktreePath(runId);
    const branch = (await this.getBranchNameIn(wtDir)).trim();
    if (!branch) return { pushed: false, reason: 'no-branch' };
    if (branch === 'main' || branch === 'master') {
      return { pushed: false, reason: `refusing to push protected branch '${branch}'` };
    }
    await execFile('git', ['push', '-u', 'origin', branch], { cwd: wtDir });
    return { pushed: true, branch };
  }

  /** Branch name checked out in an arbitrary directory ('' when detached/none). */
  private async getBranchNameIn(dir: string): Promise<string> {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /** Current branch of the MAIN repo (the base for agent branches). */
  public async getBaseBranch(): Promise<string> {
    const branch = await this.getBranchNameIn(this.workspaceRoot);
    if (branch) return branch;
    // Detached HEAD or fresh repo — fall back to the remote default.
    try {
      const { stdout } = await execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: this.workspaceRoot });
      return stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    } catch {
      return 'main';
    }
  }

  /** Does a local branch with this name exist? */
  public async branchExists(branch: string): Promise<boolean> {
    try {
      const { stdout } = await execFile('git', ['branch', '--list', branch], { cwd: this.workspaceRoot });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Stale-base guardrail: true when the base branch has advanced beyond the
   * given branch (i.e. the branch does NOT contain the base's HEAD — an
   * agent run would be working from outdated code).
   */
  public async isBranchUpToDate(branch: string): Promise<boolean> {
    try {
      const base = await this.getBaseBranch();
      if (branch === base) return true;
      await execFile('git', ['merge-base', '--is-ancestor', base, branch], { cwd: this.workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Post-merge cleanup guardrail: delete a local branch ONLY when it is
   * fully merged into the base branch (safe — no commits lost).
   */
  public async deleteBranchIfMerged(branch: string): Promise<boolean> {
    if (!(await this.branchExists(branch))) return false;
    const base = await this.getBaseBranch();
    try {
      const { stdout } = await execFile('git', ['branch', '--merged', base], { cwd: this.workspaceRoot });
      if (!stdout.split('\n').some(l => l.trim().replace(/^\*/, '').trim() === branch)) return false;
      await execFile('git', ['branch', '-d', branch], { cwd: this.workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the branch name for a work item based on title.
   * Same logic as createTaskBranch but without creating the branch.
   */
  getBranchName(workItemId: number, title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `feature/ADO-${workItemId}-${slug}`;
  }

  /**
   * Run a git command against a specific working directory (worktree).
   * Used by verifyWork to get accurate per-agent change tracking.
   */
  async gitInWorktree(worktreePath: string, args: string[]): Promise<string> {
    const { stdout } = await execFile('git', args, { cwd: worktreePath });
    return stdout;
  }

  /**
   * Per-worktree git details for the Worktrees view: dirty state, changed
   * file count, ahead/behind vs upstream, and the last commit (short form).
   * Never throws — returns an all-default shape on any git failure.
   */
  async getWorktreeInfo(worktreePath: string): Promise<WorktreeInfo> {
    const empty: WorktreeInfo = { dirty: false, changedFiles: 0, ahead: 0, behind: 0, lastCommit: null };
    try {
      // `-b` with porcelain emits a `## branch...upstream [ahead N, behind M]`
      // header line, followed by one line per changed file.
      const status = await this.gitInWorktree(worktreePath, ['status', '-sb', '--porcelain']);
      const lines = status.split('\n').filter(l => l.trim().length > 0);
      let ahead = 0;
      let behind = 0;
      const header = lines.find(l => l.startsWith('## '));
      const m = header?.match(/\[ahead (\d+)(?:, behind (\d+))?\]/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2] ?? 0);
      }
      const changedFiles = lines.filter(l => !l.startsWith('## ')).length;

      let lastCommit: string | null = null;
      try {
        const log = (await this.gitInWorktree(worktreePath, ['log', '-1', '--oneline'])).trim();
        lastCommit = log || null; // unborn branch → empty output
      } catch {
        lastCommit = null; // no commits yet
      }

      return { dirty: changedFiles > 0, changedFiles, ahead, behind, lastCommit };
    } catch {
      return empty;
    }
  }
}

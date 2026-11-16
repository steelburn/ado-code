import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { delegationBranchName } from '../shared/delegationPlan';
import {
  WorktreeChange,
  isApplied,
  isDeletion,
  isNewFile,
  mergeWorktreeChanges,
  parseNameStatus,
  parsePorcelain,
} from '../shared/worktreeChanges';

const execFile = promisify(cp.execFile);

/** Worktree directory name prefix under .ado-code/worktrees/. */
const WORKTREE_PREFIX = 'run-';

/** Changed files of one worktree (see GitService.listWorktreeChanges). */
export interface WorktreeChangeSet {
  /** Merge base the change list was computed against ('' when unknown). */
  base: string;
  changes: WorktreeChange[];
}

/** Outcome of a bulk accept/reject run. */
export interface WorktreeApplyResult {
  applied: string[];
  failed: { path: string; error: string }[];
}

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
  async createTaskBranch(workItemId: number | undefined, title: string): Promise<string | null> {
    const branchName = delegationBranchName(workItemId, title);

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

  /** Origin remote URL (repo understanding facts). Null when absent/unset. */
  async getRemoteOriginUrl(): Promise<string | null> {
    if (!this.workspaceRoot) return null;
    try {
      const { stdout } = await execFile('git', ['config', '--get', 'remote.origin.url'], {
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

  /** Is `dir` a worktree git still knows about? (stale dirs are not) */
  private async isRegisteredWorktree(dir: string): Promise<boolean> {
    const registered = await this.worktreeListByPath();
    return registered.some(p => p === path.resolve(dir).toLowerCase());
  }

  /** Path of the worktree that has `branch` checked out, if any. */
  private async worktreeHoldingBranch(branch: string): Promise<string | null> {
    try {
      const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], {
        cwd: this.workspaceRoot,
      });
      let current = '';
      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
        else if (line === `branch refs/heads/${branch}`) return current;
      }
    } catch {
      // let `git worktree add` report the real failure instead
    }
    return null;
  }

  /** Resolved (lower-cased) paths of every registered worktree. */
  private async worktreeListByPath(): Promise<string[]> {
    try {
      const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], {
        cwd: this.workspaceRoot,
      });
      return stdout.split('\n')
        .filter(l => l.startsWith('worktree '))
        .map(l => path.resolve(l.slice('worktree '.length).trim()).toLowerCase());
    } catch {
      return [];
    }
  }

  /**
   * Create an isolated git worktree for an agent run.
   * Returns the absolute path to the new working directory.
   * Creates the branch from HEAD if it doesn't exist yet.
   */
  async createWorktree(runId: string, branchName: string): Promise<string> {
    const base = this.worktreeBase();
    const wtDir = path.join(base, this.worktreeDirName(runId));

    // Ensure the base directory exists. Use fs.mkdir(recursive) rather than
    // the `mkdir` binary with `-p`: Windows has no mkdir executable and `-p`
    // is not a valid flag, so spawning it fails with ENOENT and worktree
    // creation breaks entirely on Windows.
    await fs.promises.mkdir(base, { recursive: true });
    // AD-07: `git worktree add` fails on a directory left behind by a crashed
    // run, and on a branch another worktree still holds — and that failure used
    // to drop the run back into the shared main repo. Drop genuinely dead
    // registrations, reuse this run's own worktree, and name the other worktree
    // when the branch really is taken.
    try {
      await execFile('git', ['worktree', 'prune'], { cwd: this.workspaceRoot });
    } catch {
      // best effort — a prune failure must not block worktree creation
    }
    if (fs.existsSync(wtDir)) {
      // A retry of the same run can keep what it already prepared; a directory
      // git no longer knows about is debris and must go before `worktree add`.
      if (await this.isRegisteredWorktree(wtDir)) return wtDir;
      await fs.promises.rm(wtDir, { recursive: true, force: true });
    }
    const holder = await this.worktreeHoldingBranch(branchName);
    if (holder && path.resolve(holder) !== path.resolve(wtDir)) {
      throw new Error(
        `branch '${branchName}' is already checked out at '${holder}' — ` +
        `another delegation run owns it`,
      );
    }

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

        // Only include our agent worktrees (under .ado-code/worktrees/run-*).
        // git emits forward-slash paths (D:/repo/…) while `base` is a native
        // path (D:\repo\…), so compare in resolved/normalized form — a raw
        // startsWith() is always false on Windows.
        const relToBase = path.relative(path.resolve(base), path.resolve(wtPath));
        const underBase =
          relToBase !== '' && !relToBase.startsWith('..') && !path.isAbsolute(relToBase);
        if (underBase && wtPath.includes(`${WORKTREE_PREFIX}`)) {
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
   * True when the local branch exists and is fully merged into the base branch.
   * The local counterpart of a merged PR: post-merge cleanup uses it when ADO
   * cannot be asked (missing/expired PAT, an org that does not host this repo).
   */
  public async isBranchMerged(branch: string): Promise<boolean> {
    if (!(await this.branchExists(branch))) return false;
    const base = await this.getBaseBranch();
    if (branch === base) return false;
    try {
      const { stdout } = await execFile('git', ['branch', '--merged', base], { cwd: this.workspaceRoot });
      return stdout.split('\n').some(l => l.trim().replace(/^\*/, '').trim() === branch);
    } catch {
      return false;
    }
  }

  /**
   * Post-merge cleanup guardrail: delete a local branch ONLY when it is
   * fully merged into the base branch (safe — no commits lost).
   */
  public async deleteBranchIfMerged(branch: string): Promise<boolean> {
    if (!(await this.isBranchMerged(branch))) return false;
    try {
      await execFile('git', ['branch', '-d', branch], { cwd: this.workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove a local branch UNCONDITIONALLY (`git branch -D`). Only the forced
   * post-merge cleanup calls this: the merge state could not be verified (ADO
   * unreachable, branch not locally merged) and the user explicitly accepted
   * losing commits that exist nowhere else.
   */
  public async forceDeleteBranch(branch: string): Promise<boolean> {
    if (!(await this.branchExists(branch))) return false;
    try {
      await execFile('git', ['branch', '-D', branch], { cwd: this.workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the branch name for a work item based on title.
   * Same logic as createTaskBranch but without creating the branch.
   */
  getBranchName(workItemId: number | undefined, title: string, runId?: string): string {
    return delegationBranchName(workItemId, title, runId);
  }

  /**
   * Run a git command against a specific working directory (worktree).
   * Used by verifyWork to get accurate per-agent change tracking.
   */
  async gitInWorktree(worktreePath: string, args: string[]): Promise<string> {
    const { stdout } = await execFile('git', args, {
      cwd: worktreePath,
      maxBuffer: 32 * 1024 * 1024,
    });
    return String(stdout);
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

  // --- Worktree change review -----------------------------------------------

  /**
   * Record per change whether this workspace already holds the worktree s
   * copy (WorktreeChange.applied). Byte comparison, not a git call: an
   * earlier Accept nobody touched since is a no-op, not an overwrite.
   */
  private async annotateApplied(
    worktreePath: string,
    changes: WorktreeChange[]
  ): Promise<WorktreeChange[]> {
    return changes.map((change) => {
      const workspaceContent = readFileMaybe(
        this.resolveInsideRoot(this.workspaceRoot, change.path)
      );
      const worktreeContent = readFileMaybe(
        this.resolveInsideRoot(worktreePath, change.path)
      );
      return {
        ...change,
        applied: isApplied(change.status, workspaceContent, worktreeContent),
      };
    });
  }

  /**
   * Repo-relative paths this workspace s own `git status` reports — the set
   * an Accept from a worktree would overwrite.
   */
  async listWorkspaceDirtyPaths(): Promise<string[]> {
    try {
      // -z on purpose: parsePorcelain splits on NUL records, while
      // getStatusPorcelain() is newline-separated (and would collapse to one
      // bogus path). --no-renames keeps a rename as two plain paths.
      const { stdout } = await execFile(
        'git',
        ['status', '--porcelain', '-z', '-uall', '--no-renames'],
        { cwd: this.workspaceRoot }
      );
      return parsePorcelain(stdout).map((c) => c.path);
    } catch {
      return [];
    }
  }

  /**
   * Resolve `relPath` under `root`, returning null when it escapes the root
   * (absolute path, `..` traversal or NUL byte). Every read/accept/reject goes
   * through here: the paths come from git output, but a node can be clicked
   * with any meta attached.
   */
  private resolveInsideRoot(root: string, relPath: string): string | null {
    const rel = (relPath || '').replace(/\\/g, '/');
    if (!rel || rel.includes('\u0000') || path.isAbsolute(rel)) return null;
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    return abs;
  }

  /** Merge base of the worktree HEAD and the workspace HEAD ('' when unknown). */
  async getWorktreeBaseRef(worktreePath: string): Promise<string> {
    try {
      const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: this.workspaceRoot });
      const workspaceHead = String(stdout).trim();
      if (!workspaceHead) return '';
      const out = await execFile('git', ['merge-base', 'HEAD', workspaceHead], { cwd: worktreePath });
      return String(out.stdout).trim();
    } catch {
      return '';
    }
  }

  /**
   * Changed files of a worktree against its base: what the run branch already
   * committed plus what is still uncommitted. Never throws — an unreadable
   * worktree yields an empty list so the tree stays usable.
   */
  async listWorktreeChanges(worktreePath: string): Promise<WorktreeChangeSet> {
    const base = await this.getWorktreeBaseRef(worktreePath);
    const committed: WorktreeChange[] = [];
    const pending: WorktreeChange[] = [];
    if (base) {
      try {
        const out = await this.gitInWorktree(worktreePath, [
          'diff', '--name-status', '-z', '--no-renames', base,
        ]);
        committed.push(...parseNameStatus(out));
      } catch {
        // Base ref unreadable — fall back to the pending list only.
      }
    }
    try {
      const out = await this.gitInWorktree(worktreePath, [
        'status', '--porcelain', '-z', '-uall', '--no-renames',
      ]);
      pending.push(...parsePorcelain(out));
    } catch {
      // Ignore — the committed list still renders.
    }
    return {
      base,
      changes: await this.annotateApplied(
        worktreePath,
        mergeWorktreeChanges(committed, pending)
      ),
    };
  }

  /** Content of `relPath` at `ref` inside the worktree ('' when absent). */
  async readWorktreeFileAtRef(worktreePath: string, ref: string, relPath: string): Promise<string> {
    const rel = (relPath || '').replace(/\\/g, '/');
    if (!rel || !ref || rel.includes('\u0000') || ref.includes('\u0000')) return '';
    try {
      const { stdout } = await execFile('git', ['show', `${ref}:${rel}`], {
        cwd: worktreePath,
        maxBuffer: 32 * 1024 * 1024,
      });
      return String(stdout);
    } catch {
      return '';
    }
  }

  /** On-disk content of a worktree file ('' when missing or out of tree). */
  async readWorktreeWorkingFile(worktreePath: string, relPath: string): Promise<string> {
    const abs = this.resolveInsideRoot(worktreePath, relPath);
    if (!abs) return '';
    try {
      return await fs.promises.readFile(abs, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Accept one change: apply the worktree version of the file onto the main
   * workspace. A file the worktree deleted is deleted in the workspace too.
   */
  async acceptWorktreeFile(worktreePath: string, change: WorktreeChange): Promise<void> {
    const src = this.resolveInsideRoot(worktreePath, change.path);
    const dest = this.resolveInsideRoot(this.workspaceRoot, change.path);
    if (!src || !dest) throw new Error(`refusing out-of-tree path: ${change.path}`);
    if (isDeletion(change.status)) {
      await fs.promises.rm(dest, { force: true });
      return;
    }
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
  }

  /** Accept every change; a failure is reported per file instead of aborting. */
  async acceptWorktreeChanges(
    worktreePath: string,
    changes: WorktreeChange[]
  ): Promise<WorktreeApplyResult> {
    const result: WorktreeApplyResult = { applied: [], failed: [] };
    for (const change of changes) {
      try {
        await this.acceptWorktreeFile(worktreePath, change);
        result.applied.push(change.path);
      } catch (err) {
        result.failed.push({ path: change.path, error: errorText(err) });
      }
    }
    return result;
  }

  /**
   * Reject one change: discard it inside the worktree by restoring the file
   * from the base (or deleting it when the change added it). When the run
   * branch already committed the change, the revert is committed as well so a
   * pull request cannot carry the rejected file into main.
   */
  async rejectWorktreeFile(
    worktreePath: string,
    change: WorktreeChange,
    base: string
  ): Promise<void> {
    const rel = change.path.replace(/\\/g, '/');
    let restored = false;
    if (base && !isNewFile(change.status)) {
      try {
        await this.gitInWorktree(worktreePath, ['checkout', base, '--', rel]);
        restored = true;
      } catch {
        restored = false;
      }
    }
    if (!restored) {
      const abs = this.resolveInsideRoot(worktreePath, rel);
      if (!abs) throw new Error(`refusing out-of-tree path: ${rel}`);
      await fs.promises.rm(abs, { force: true });
    }
    await this.commitWorktreeRevert(worktreePath, base, rel);
  }

  /** Reject every change, collecting per-file failures. */
  async rejectWorktreeChanges(
    worktreePath: string,
    changes: WorktreeChange[],
    base: string
  ): Promise<WorktreeApplyResult> {
    const result: WorktreeApplyResult = { applied: [], failed: [] };
    for (const change of changes) {
      try {
        await this.rejectWorktreeFile(worktreePath, change, base);
        result.applied.push(change.path);
      } catch (err) {
        result.failed.push({ path: change.path, error: errorText(err) });
      }
    }
    return result;
  }

  /**
   * Record a path-limited revert commit when the run branch already carried
   * the change; only that path is staged, so unrelated pending work in the
   * worktree is left untouched.
   */
  private async commitWorktreeRevert(
    worktreePath: string,
    base: string,
    relPath: string
  ): Promise<void> {
    if (!base) return;
    try {
      const diff = await this.gitInWorktree(worktreePath, [
        'diff', '--name-only', base, 'HEAD', '--', relPath,
      ]);
      if (!diff.trim()) return;
      await this.gitInWorktree(worktreePath, ['add', '-A', '--', relPath]);
      await this.gitInWorktree(worktreePath, [
        'commit', '-q', '--no-verify', '-m', `reject: ${relPath}`, '--', relPath,
      ]);
    } catch {
      // Nothing staged for that path — the working-tree revert stands.
    }
  }
}

/** Message text for an unknown thrown value. */
/** Raw bytes of a file, or undefined when it cannot be read. */
function readFileMaybe(absPath: string | null): Buffer | undefined {
  if (!absPath) return undefined;
  try {
    return fs.readFileSync(absPath);
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

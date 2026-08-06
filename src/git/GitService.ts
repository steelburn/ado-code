import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const execFile = promisify(cp.execFile);

/** Worktree directory name prefix under .ado-code/worktrees/. */
const WORKTREE_PREFIX = 'run-';

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
   * Create an isolated git worktree for an agent run.
   * Returns the absolute path to the new working directory.
   * Creates the branch from HEAD if it doesn't exist yet.
   */
  async createWorktree(runId: string, branchName: string): Promise<string> {
    const base = this.worktreeBase();
    const wtDir = path.join(base, `${WORKTREE_PREFIX}${runId}`);

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
    const wtDir = path.join(this.worktreeBase(), `${WORKTREE_PREFIX}${runId}`);
    try {
      // Force remove — discards uncommitted changes
      await execFile('git', ['worktree', 'remove', '--force', wtDir], {
        cwd: this.workspaceRoot,
      });
    } catch {
      // If git worktree remove fails, try manual cleanup
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
        const branch = (lines['HEAD'] ?? '').replace('refs/heads/', '');

        // Only include our agent worktrees (under .ado-code/worktrees/run-*)
        if (wtPath.startsWith(base) && wtPath.includes(`${WORKTREE_PREFIX}`)) {
          const dirName = path.basename(wtPath);
          const runId = dirName.replace(/^run-/, '');
          worktrees.push({ runId, path: wtPath, branch });
        }
      }

      return worktrees;
    } catch {
      return [];
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
}

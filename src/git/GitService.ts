import * as cp from 'child_process';
import { promisify } from 'util';

const execFile = promisify(cp.execFile);

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
}

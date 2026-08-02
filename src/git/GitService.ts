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

    try {
      await execFile('git', ['rev-parse', '--verify', '--quiet', branchName], {
        cwd: this.workspaceRoot,
      });
      return null; // branch already exists
    } catch {
      // branch does not exist — create it
      await execFile('git', ['checkout', '-b', branchName], { cwd: this.workspaceRoot });
      return branchName;
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
}

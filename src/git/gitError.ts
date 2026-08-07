import * as fs from 'fs';

/**
 * Turn a git spawn error into an actionable message. Node reports
 * "spawn git ENOENT" for TWO different causes, and the raw text is
 * misleading: (1) the git binary is not on the extension host's PATH,
 * or (2) the `cwd` passed to execFile does not exist (a bad worktree
 * path looks identical). Distinguish them for the user.
 */
export function gitErrorMessage(err: unknown, cwd?: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    if (cwd && !fs.existsSync(cwd)) {
      return `git failed: working directory does not exist (${cwd}) — the worktree may have been removed; refresh the Worktrees view`;
    }
    return `git executable not found on the VS Code process PATH — install git or add it to PATH (or set the 'git.path' setting)`;
  }
  return err instanceof Error ? err.message : String(err);
}

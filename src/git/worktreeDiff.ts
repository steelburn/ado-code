import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';

/**
 * Read-only virtual documents that feed the Worktrees view's diff editor: one
 * side is a file at a git ref inside the agent worktree (the merge base, or the
 * worktree working tree for files that no longer exist on disk), so added and
 * deleted files diff as well as modified ones.
 *
 * The ref spec travels in the URI itself (query params) instead of a registry,
 * so a diff editor restored after a window reload still resolves.
 */
export const WORKTREE_DIFF_SCHEME = 'adocode-worktree';

/** Pseudo-ref meaning "read the file from the worktree working tree". */
export const WORKTREE_WORKING_REF = 'WORKTREE';

interface WorktreeRefSpec {
  /** Absolute worktree path. */
  wt: string;
  /** Git ref, or WORKTREE_WORKING_REF. */
  ref: string;
  /** Path relative to the worktree root. */
  path: string;
}

/** Encode `relPath` (whole string) into a query value. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

function readQuery(uri: vscode.Uri): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (uri.query || '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    try {
      out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}

/** Build the virtual URI for one side of a worktree diff. */
export function worktreeRefUri(wtPath: string, ref: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: WORKTREE_DIFF_SCHEME,
    // Only used for the editor label; the real path rides in the query.
    path: '/' + path.basename(relPath.replace(/\\/g, '/')),
    query: `wt=${encodeQueryValue(wtPath)}&ref=${encodeQueryValue(ref)}&p=${encodeQueryValue(relPath)}`,
  });
}

/** Inverse of worktreeRefUri; null when the URI is not one of ours. */
export function parseWorktreeRefUri(uri: vscode.Uri): WorktreeRefSpec | null {
  if (!uri || uri.scheme !== WORKTREE_DIFF_SCHEME) return null;
  const q = readQuery(uri);
  if (!q.wt || !q.ref || !q.p) return null;
  return { wt: q.wt, ref: q.ref, path: q.p };
}

export class WorktreeDiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: GitService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const spec = parseWorktreeRefUri(uri);
    if (!spec) return '';
    if (spec.ref === WORKTREE_WORKING_REF) {
      return this.git.readWorktreeWorkingFile(spec.wt, spec.path);
    }
    return this.git.readWorktreeFileAtRef(spec.wt, spec.ref, spec.path);
  }
}

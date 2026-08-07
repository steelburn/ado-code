import * as cp from 'child_process';
import { promisify } from 'util';

const execFile = promisify(cp.execFile);

/**
 * PR conflict surfacing (round-2 guardrail Task 4) — vscode-free, fast-testable.
 *
 * Uses `git merge-tree <base^{tree}> <base> <feature>` (the OLD form, which is
 * what git < 2.38 ships — the modern `--write-tree` form needs 2.38+) to find
 * files changed on BOTH sides. Old merge-tree marks every such file with
 * `<<<<<<<` conflict markers (it over-reports: non-overlapping edits to the
 * same file still show markers). That is fine here: the LLM receives the
 * base/our/their blob CONTENTS and decides the resolution itself.
 *
 * NOTE: git 2.34's old merge-tree prints "changed in both"/"added in both"
 * sections with `base/our/their 100644 <sha> <path>` lines — no shell needed,
 * `^{tree}` is resolved by git itself when passed as a plain execFile arg.
 */

export interface ConflictFile {
  path: string;
  baseSha?: string;
  ourSha?: string;
  theirSha?: string;
  /** Blob contents (capped) for the LLM to resolve with. */
  base?: string;
  ours?: string;
  theirs?: string;
  /** True when a content fetch was truncated to MAX_CONTENT_LINES. */
  truncated?: boolean;
}

/** Cap per-side content so a big conflict dump can't blow the LLM context. */
const MAX_CONTENT_LINES = 300;

/**
 * Parse the raw `git merge-tree <base> <a> <b>` stdout into conflicted files.
 * Sections start with "changed in both" / "added in both" / "removed in both";
 * each carries `base`/`our`/`their` lines: `  <name> 100644 <sha> <path>`.
 */
export function parseMergeTreeOutput(stdout: string): ConflictFile[] {
  const conflicts: ConflictFile[] = [];
  let current: ConflictFile | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const header = line.match(/^(changed|added|removed) in both$/);
    if (header) {
      if (current) conflicts.push(current);
      current = { path: '' };
      continue;
    }
    if (!current) continue;
    // Blank line or a diff hunk header ends the section's metadata (the hunk
    // body with conflict markers follows — we don't need to parse it).
    if (line.trim() === '' || line.startsWith('@@')) {
      if (line.startsWith('@@')) conflicts.push(current);
      current = null;
      continue;
    }
    const meta = line.match(/^\s+(base|our|their)\s+\d+\s+([0-9a-f]+)\s+(.+)$/);
    if (meta) {
      const [, side, sha, filePath] = meta;
      if (side === 'base') { current.baseSha = sha; current.path = filePath; }
      if (side === 'our') { current.ourSha = sha; current.path = filePath; }
      if (side === 'their') { current.theirSha = sha; current.path = filePath; }
    }
  }
  if (current) conflicts.push(current);
  // Only keep entries with a real path (a section without metadata is noise).
  return conflicts.filter(c => c.path !== '');
}

/** Cap blob content to MAX_CONTENT_LINES lines; mark truncation. */
function capContent(content: string): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  if (lines.length <= MAX_CONTENT_LINES) return { text: content, truncated: false };
  return { text: lines.slice(0, MAX_CONTENT_LINES).join('\n'), truncated: true };
}

/**
 * Find files conflicting between `baseBranch` and `featureBranch` and fetch
 * their base/our/their contents (capped). Both branches must be resolvable
 * from `workspaceRoot` (the feature branch may be checked out in a worktree —
 * refs are shared repo-wide). Returns [] when merge-tree reports nothing.
 */
export async function getMergeConflicts(
  workspaceRoot: string,
  baseBranch: string,
  featureBranch: string
): Promise<ConflictFile[]> {
  let stdout = '';
  try {
    // The FIRST merge-tree arg is the BASE TREE — the tree of the merge-base
    // commit, NOT the base branch's own tree (passing the branch tree makes
    // the merge degenerate: branch1 === base, so nothing shows as conflicting).
    const { stdout: mergeBase } = await execFile('git', ['merge-base', baseBranch, featureBranch], {
      cwd: workspaceRoot,
    });
    const baseTree = `${mergeBase.trim()}^{tree}`;
    const res = await execFile('git', ['merge-tree', baseTree, baseBranch, featureBranch], {
      cwd: workspaceRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch {
    // merge-tree can fail (e.g. base tree unresolvable) — treat as no info.
    return [];
  }

  const conflicts = parseMergeTreeOutput(stdout);
  for (const c of conflicts) {
    for (const side of ['base', 'ours', 'theirs'] as const) {
      const sha = side === 'ours' ? c.ourSha : side === 'theirs' ? c.theirSha : c.baseSha;
      if (!sha) continue;
      try {
        const { stdout: content } = await execFile('git', ['show', sha], { cwd: workspaceRoot });
        const { text, truncated } = capContent(content);
        c[side] = text;
        if (truncated) c.truncated = true;
      } catch {
        // Blob missing — leave the side undefined; the LLM still gets the paths.
      }
    }
  }
  return conflicts;
}

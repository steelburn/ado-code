/**
 * Pure helpers for the Worktrees view's per-file change list.
 *
 * A worktree's review surface is what the run branch carries against its merge
 * base (committed by the agent) PLUS everything still uncommitted in the
 * worktree's working tree. Both are read from git and merged here so the tree
 * knows, per changed file, what kind of change it is and whether it is still
 * pending — no `vscode`/`child_process` imports, so the parsing stays
 * unit-testable.
 */

/** Coarse change kind shown in the tree (git's finer codes map onto these). */
export type WorktreeChangeStatus = 'A' | 'M' | 'D' | 'U';

export interface WorktreeChange {
  /** Path relative to the worktree root, with forward slashes. */
  path: string;
  /** Added, Modified, Deleted or Untracked. */
  status: WorktreeChangeStatus;
  /** True when the change is not committed yet inside the worktree. */
  pending: boolean;
  /**
   * True when this workspace already holds exactly what the worktree
   * carries for this path. Set by GitService from a byte comparison, so an
   * Accept nobody built on stays a no-op instead of an overwrite.
   */
  applied?: boolean;
}

const STATUS_LABELS: Record<WorktreeChangeStatus, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  U: 'Untracked',
};

const STATUS_ICONS: Record<WorktreeChangeStatus, string> = {
  A: 'diff-added',
  M: 'diff-modified',
  D: 'diff-removed',
  U: 'diff-added',
};

/** Human label for a change kind, e.g. `Modified`. */
export function changeLabel(status: WorktreeChangeStatus): string {
  return STATUS_LABELS[status] ?? 'Changed';
}

/** Theme icon id for a change kind. */
export function changeIconId(status: WorktreeChangeStatus): string {
  return STATUS_ICONS[status] ?? 'file';
}

/**
 * Normalize git's single-letter status codes onto the coarse set: renames,
 * copies, type changes and unmerged entries all read as modifications, and an
 * unknown code is treated as a modification too (never silently dropped).
 */
export function normalizeStatus(code: string): WorktreeChangeStatus {
  const c = (code || '').trim().toUpperCase().charAt(0);
  if (c === 'A') return 'A';
  if (c === 'D') return 'D';
  if (c === '?') return 'U';
  return 'M';
}

function cleanPath(raw: string): string {
  // NUL-split records are unquoted, but a quoted porcelain path (core.quotePath)
  // can still arrive when -z was not honored; strip the wrapping quotes.
  let p = raw.split('\u0000').join('').trim();
  if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return p.replace(/\\/g, '/');
}

/**
 * Parse `git diff --name-status -z --no-renames <base>` output.
 * With -z that stream is `<STATUS>\0<path>\0` pairs (no rename entries, so no
 * second path field to skip).
 */
export function parseNameStatus(stdout: string): WorktreeChange[] {
  const parts = (stdout || '').split('\u0000');
  const out: WorktreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const filePath = cleanPath(parts[i + 1]);
    if (!status || !filePath) continue;
    out.push({ path: filePath, status: normalizeStatus(status), pending: false });
  }
  return out;
}

/**
 * Parse `git status --porcelain -z -uall --no-renames` output.
 * Each record is `XY <path>` (two status columns, one space, then the path);
 * untracked entries are `?? <path>`.
 */
export function parsePorcelain(stdout: string): WorktreeChange[] {
  const out: WorktreeChange[] = [];
  for (const record of (stdout || '').split('\u0000')) {
    if (!record || record.length < 4) continue;
    const index = record.charAt(0);
    const worktree = record.charAt(1);
    const filePath = cleanPath(record.slice(3));
    if (!filePath) continue;
    const untracked = index === '?' && worktree === '?';
    const status: WorktreeChangeStatus = untracked
      ? 'U'
      : normalizeStatus(worktree === ' ' ? index : worktree);
    out.push({ path: filePath, status, pending: true });
  }
  return out;
}

/**
 * Merge the committed (branch vs base) and pending (working tree) lists.
 * A path present in both keeps the pending status, because that is what the
 * user is looking at in the diff editor.
 */
export function mergeWorktreeChanges(
  committed: WorktreeChange[],
  pending: WorktreeChange[]
): WorktreeChange[] {
  const byPath = new Map<string, WorktreeChange>();
  for (const c of committed) byPath.set(c.path, { ...c, pending: false });
  for (const p of pending) byPath.set(p.path, { ...p, pending: true });
  return sortWorktreeChanges([...byPath.values()]);
}

/** Stable ordering: path ascending, so the tree does not jump between reloads. */
export function sortWorktreeChanges(changes: WorktreeChange[]): WorktreeChange[] {
  return [...changes].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Counts behind the "Changes" summary: how many files the run changed, how
 * many are still uncommitted in the worktree, and how many this workspace
 * already holds (accepted).
 */
export function summarizeWorktreeCounts(changes: WorktreeChange[]): {
  files: number;
  uncommitted: number;
  applied: number;
} {
  return {
    files: changes.length,
    uncommitted: changes.filter((c) => c.pending).length,
    applied: changes.filter((c) => c.applied).length,
  };
}

/**
 * Short summary used for the collapsed "Changes" node, e.g.
 * `3 files · 2 uncommitted · 1 applied`.
 *
 * The two numbers answer different questions and both are reported:
 * `uncommitted` is the git fact (the run never committed the file, so a PR may
 * still carry it) and `applied` is the review outcome (this workspace already
 * holds that exact content). Accepting therefore moves a file into `applied`
 * but never changes `uncommitted` — accept deliberately leaves the worktree
 * untouched, so the run branch keeps carrying the change for its PR.
 */
export function summarizeWorktreeChanges(changes: WorktreeChange[]): string {
  const { files, uncommitted, applied } = summarizeWorktreeCounts(changes);
  if (files === 0) return 'no changes';
  const parts = [`${files} file${files === 1 ? '' : 's'}`];
  if (uncommitted > 0) parts.push(`${uncommitted} uncommitted`);
  if (applied > 0) parts.push(`${applied} applied`);
  return parts.join(' · ');
}

/** True when the change removes the file (so accepting it deletes it). */
export function isDeletion(status: WorktreeChangeStatus): boolean {
  return status === 'D';
}

/** True when the change only exists inside the worktree (never in the base). */
export function isNewFile(status: WorktreeChangeStatus): boolean {
  return status === 'A' || status === 'U';
}

/**
 * True when the workspace file already matches what the worktree carries.
 *
 * Accepting such a change writes identical bytes, so it is a no-op rather than
 * an overwrite — the distinction keeps "Accept all" from warning about files an
 * earlier accept already applied.
 */
export function isApplied(
  status: WorktreeChangeStatus,
  workspaceContent: Buffer | undefined,
  worktreeContent: Buffer | undefined
): boolean {
  if (isDeletion(status)) return workspaceContent === undefined;
  if (workspaceContent === undefined || worktreeContent === undefined) {
    return false;
  }
  return workspaceContent.equals(worktreeContent);
}

/** Repo-relative path normalized the way the change list stores it. */
export function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Paths an Accept would clobber: already changed in this workspace (by hand, or
 * by an earlier accept from another worktree) and not byte-identical yet.
 *
 * `workspaceDirtyPaths` is this workspace's own `git status`, which is exactly
 * where a previous worktree accept left its files — so the same path coming
 * from a second run is reported instead of silently winning.
 */
export function detectWorkspaceOverwrites(
  changes: WorktreeChange[],
  workspaceDirtyPaths: Iterable<string>
): string[] {
  const dirty = new Set<string>();
  for (const p of workspaceDirtyPaths) dirty.add(normalizeRepoPath(p));
  const out: string[] = [];
  for (const change of changes) {
    if (change.applied) continue; // identical copy already on disk
    if (dirty.has(normalizeRepoPath(change.path))) out.push(change.path);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * One-line warning for the accept confirmation, or '' when nothing clashes.
 * Lists at most `limit` paths so the modal stays readable.
 */
export function describeOverwriteWarning(overwrites: string[], limit = 3): string {
  if (!overwrites.length) return '';
  const shown = overwrites.slice(0, limit).join(', ');
  const more =
    overwrites.length > limit ? ` (+${overwrites.length - limit} more)` : '';
  return (
    `${overwrites.length} file(s) already changed in this workspace will be ` +
    `overwritten: ${shown}${more}`
  );
}

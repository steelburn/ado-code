import * as fs from 'fs';
import * as path from 'path';

/**
 * Keep the extension's workspace data directory (`.ado-code/`) out of version
 * control and Docker builds. `.ado-code` holds per-user, machine-local state
 * (workspace memory, checkpoints, agent run outputs, worktree metadata) that
 * must never be committed to git or baked into a Docker image.
 *
 * Deliberately free of any `vscode` import — the helpers are pure Node fs, so
 * they can run under plain mocha (like the adapter tests) as well as inside
 * the extension-host suite.
 */

/** The workspace-local directory ADO Code writes its data into. */
export const DOT_ADO_CODE = '.ado-code';

/** Ignore files the extension offers to maintain. */
export const IGNORE_FILE_NAMES = ['.gitignore', '.dockerignore'] as const;

/** workspaceState key remembering that the user declined the offer. */
export const IGNORE_DISMISS_KEY = 'adoCode.ignoreDotAdoCodeSkipped';

/**
 * Line-based check: does `content` already ignore `entry`?
 * Accepts the common spellings (bare `.ado-code`, trailing-slash `.ado-code/`,
 * root-anchored `/.ado-code`, `/.ado-code/`). Comment lines and blank lines
 * never count — a line like `# .ado-code` does not ignore anything.
 */
export function isEntryIgnored(content: string, entry: string): boolean {
  const patterns = new Set([entry, `${entry}/`, `/${entry}`, `/${entry}/`]);
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (patterns.has(line)) return true;
  }
  return false;
}

/** Append an ignore entry behind an explanatory comment. */
export function appendIgnoreEntry(content: string, entry: string): string {
  const block = `# ADO Code workspace data (per-user, machine-local)\n${entry}\n`;
  const trimmed = content.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/**
 * Ensure `entry` is listed in the ignore file at `filePath`, creating the
 * file when it does not exist yet. Returns true when it wrote, false when
 * the entry was already present (idempotent).
 */
export function ensureEntryInIgnoreFile(filePath: string, entry: string): boolean {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
    if (isEntryIgnored(content, entry)) return false;
  }
  fs.writeFileSync(filePath, appendIgnoreEntry(content, entry), 'utf8');
  return true;
}

/**
 * Which ignore files (among those that EXIST in `root`) are missing `entry`?
 * Absent files are NOT synthesized here — callers decide whether to create
 * one (e.g. a git repo with no .gitignore yet).
 */
export function missingIgnoreTargets(root: string, entry: string): string[] {
  return IGNORE_FILE_NAMES.filter((name) => {
    const filePath = path.join(root, name);
    return fs.existsSync(filePath) && !isEntryIgnored(fs.readFileSync(filePath, 'utf8'), entry);
  });
}

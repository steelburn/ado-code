// Host-side diff collection for the review gate (AI-engineering roadmap #3).
//
// The gate itself (src/llm/reviewGate.ts) is pure and knows nothing about git:
// the agentic loop asks for "the diff of these files" through an injected
// function, so its tests hand it a string and the extension host decides how a
// diff is produced. This module is that production implementation — deliberately
// free of `vscode`, so the caller passes the repository root and the tests can
// point it at a throwaway repo.
//
// Three properties matter more than completeness:
//
//  1. IT IS SCOPED TO THE TURN. Only the paths the turn itself mutated are
//     diffed, so unrelated uncommitted work in the same repo never reaches the
//     review (and is never blamed on the model). The one leak left is a foreign
//     edit inside a file the turn also touched; that is the price of not
//     snapshotting the whole tree at turn start.
//  2. IT NEVER THROWS. Not a git repo, no commits yet, git not installed, a
//     binary or unreadable new file — every one of those yields "no diff", and
//     the gate then accepts the finish. A review is an optimisation, so its
//     input collection must not be able to fail a turn.
//  3. IT IS BOUNDED. Path count, per-file size and git runtime all have caps, so
//     a huge turn cannot turn the review into an unbounded read.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

/** At most this many mutated paths are diffed. */
export const MAX_DIFF_PATHS = 20;

/** New (untracked) files are inlined up to this many lines. */
export const MAX_UNTRACKED_LINES = 200;

/** Larger untracked files are skipped rather than inlined. */
const MAX_UNTRACKED_BYTES = 512 * 1024;

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

function runGit(rootPath: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', rootPath, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
      },
    );
  });
}

/**
 * Reduce the turn's touched paths to workspace-relative POSIX paths that are
 * genuinely inside the root (the path confinement rule applies here too — a
 * `../` path is dropped, not resolved).
 */
export function normalizeDiffPaths(rootPath: string, paths: readonly string[]): string[] {
  const root = path.resolve(rootPath);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const abs = path.resolve(root, trimmed);
    const rel = path.relative(root, abs);
    if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    const posix = rel.split(path.sep).join('/');
    if (seen.has(posix)) {
      continue;
    }
    seen.add(posix);
    out.push(posix);
    if (out.length >= MAX_DIFF_PATHS) {
      break;
    }
  }
  return out;
}

/** `git diff` of tracked changes against HEAD, or '' when git says no. */
async function trackedDiff(rootPath: string, paths: string[]): Promise<string> {
  const diff = await runGit(rootPath, ['diff', '--no-color', '--unified=3', 'HEAD', '--', ...paths]);
  if (diff.ok) {
    return diff.stdout;
  }
  // A repo with no commits has no HEAD; fall back to the working-tree diff so a
  // brand-new project still gets reviewed.
  const fallback = await runGit(rootPath, ['diff', '--no-color', '--unified=3', '--', ...paths]);
  return fallback.ok ? fallback.stdout : '';
}

/** Untracked files among the touched paths (a new file never shows in `git diff`). */
async function untrackedPaths(rootPath: string, paths: string[]): Promise<string[]> {
  const res = await runGit(rootPath, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]);
  if (!res.ok || res.stdout.length === 0) {
    return [];
  }
  return res.stdout.split('\0').filter((p) => p.trim().length > 0);
}

/**
 * Render a new file as an all-added diff.
 *
 * `git diff` cannot see untracked files, and `--no-index` against /dev/null is
 * not portable, so the block is built by hand. It is the shape the reviewer is
 * told to expect (a `diff --git` header plus `+` lines), which is all that
 * matters here.
 */
export async function newFileDiff(rootPath: string, relPath: string): Promise<string> {
  const abs = path.resolve(rootPath, relPath);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) {
      return '';
    }
    const content = await fs.readFile(abs, 'utf8');
    if (content.includes('\0')) {
      return '';
    }
    const lines = content.split(/\r?\n/);
    const capped = lines.slice(0, MAX_UNTRACKED_LINES);
    const more = lines.length > capped.length ? `\n…[${lines.length - capped.length} more lines not shown]…` : '';
    return [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${capped.length} @@`,
      ...capped.map((line) => `+${line}`),
    ].join('\n') + more;
  } catch {
    return '';
  }
}

/**
 * The diff of everything this turn changed, as a single patch-shaped string.
 *
 * Returns '' when there is nothing to review — the caller treats that as "no
 * review needed" (see `reviewChange` in src/llm/agentic.ts).
 */
export async function collectTurnDiff(rootPath: string, touchedPaths: readonly string[]): Promise<string> {
  const paths = normalizeDiffPaths(rootPath, touchedPaths);
  if (paths.length === 0) {
    return '';
  }
  const [tracked, untracked] = await Promise.all([trackedDiff(rootPath, paths), untrackedPaths(rootPath, paths)]);
  const blocks: string[] = [];
  if (tracked.trim().length > 0) {
    blocks.push(tracked.trimEnd());
  }
  for (const rel of untracked) {
    const block = await newFileDiff(rootPath, rel);
    if (block.trim().length > 0) {
      blocks.push(block);
    }
  }
  return blocks.join('\n');
}

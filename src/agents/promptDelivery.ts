/**
 * AD-07 — how a delegation prompt reaches an agent CLI.
 *
 * The prompt used to travel as an argv argument, always. On Windows that
 * breaks: a `.cmd` shim is spawned through cmd.exe (see resolveBin), whose
 * command line caps out at ~8191 characters (CreateProcess itself at ~32767),
 * and a real delegation died with "The command line is too long." before the
 * agent ever started.
 *
 * Delegation prompts are large (work item + AGENTS.md + repository
 * understanding easily reach 10-30 kB), so the fallback has to work for EVERY
 * agent. stdin is not it: pi's TUI owns stdin (an open pipe makes it hang) and
 * one-shot stdin support differs per CLI. Instead an oversized prompt is
 * spilled to a file inside the run's own working directory — `.ado-code` is
 * gitignored — and argv carries a short pointer at it. Every agent we support
 * is a coding agent that can read a file.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Windows: cmd.exe caps the whole command line at ~8191 characters. */
export const PROMPT_ARGV_BUDGET = 4000;

/** POSIX: ARG_MAX is ~128 kB, but stay well below it. */
export const PROMPT_ARGV_BUDGET_POSIX = 100_000;

/** Prompt file, relative to the run's working directory. */
export const PROMPT_FILE_REL = path.join('.ado-code', 'delegation-prompt.md');

/** argv budget for the platform this extension is running on. */
export function promptArgvBudget(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? PROMPT_ARGV_BUDGET : PROMPT_ARGV_BUDGET_POSIX;
}

/** Absolute path of the spilled prompt for a run working directory. */
export function promptFilePath(cwd: string): string {
  return path.join(cwd, PROMPT_FILE_REL);
}

/** What replaces an oversized prompt on the command line. */
export function promptPointerText(file: string): string {
  return [
    `Your task instructions are too long to pass on a command line, so they were written to:`,
    file,
    `Read that file in full before doing anything else, then follow it exactly.`,
  ].join('\n');
}

/**
 * The argv value that carries `prompt` to an agent spawned in `cwd`: the prompt
 * itself while it fits, otherwise a pointer to the spilled prompt file. A file
 * left by an earlier oversized run is removed as soon as a prompt fits again,
 * so `.ado-code` does not keep a finished run's instructions around.
 */
export function deliverPromptArg(prompt: string, cwd?: string, budget = promptArgvBudget()): string {
  const text = typeof prompt === 'string' ? prompt : '';
  const file = cwd ? promptFilePath(cwd) : null;
  if (!file || text.length <= budget) {
    if (file) clearPromptFile(cwd as string);
    return text;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch {
    // Unwritable working directory: keep the prompt on argv rather than lose
    // it entirely — the spawn error is then the one we already understand.
    return text;
  }
  return promptPointerText(file);
}

/** Remove a spilled prompt for `cwd`. Best effort — never throws. */
export function clearPromptFile(cwd: string | undefined | null): void {
  if (!cwd) return;
  try {
    fs.rmSync(promptFilePath(cwd), { force: true });
  } catch {
    // already gone, or not removable — nothing left to clean up
  }
}

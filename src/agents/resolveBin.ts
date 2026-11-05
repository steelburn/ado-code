import * as cp from 'child_process';
import { currentShellEnv, findOnPath } from '../shared/shellEnv';

/**
 * Executable candidates to probe (and later spawn) for an agent CLI.
 *
 * - win32: npm-installed CLIs ship as `.cmd` shims (M12); native installers
 *   ship `.exe`; the bare name is tried last (cmd's own PATHEXT resolution).
 * - every other platform: the bare name, as always.
 */
export function agentBinCandidates(name: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
}

/** True for Windows command shims (.cmd/.bat), which only run through cmd.exe. */
export function isCmdShim(bin: string): boolean {
  return /\.(cmd|bat)$/i.test(bin);
}

/**
 * cmd.exe argument quoting: always wrap in double quotes and double embedded
 * quotes (cmd's escape inside a quoted string). Quoting EVERY argument — not
 * just ones containing spaces — keeps cmd metacharacters (& | < > ^ …) inert
 * inside the quotes.
 */
export function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Build the full command line for a shim in cmd grammar, wrapped in an extra
 * outer quote pair. cmd's /s quote handling strips the FIRST and LAST quote
 * character of the /c string when it starts with a quote — the outer pair is
 * what gets stripped, leaving the inner quoted command intact.
 */
export function cmdLineForShim(bin: string, args: string[]): string {
  return `"${[bin, ...args].map(quoteCmdArg).join(' ')}"`;
}

export interface ResolvedSpawn {
  bin: string;
  args: string[];
  /** Extra spawn options (currently: windowsVerbatimArguments on the cmd.exe path). */
  opts?: cp.SpawnOptions;
}

/**
 * Decide what to actually spawn for `bin` + `args`.
 *
 * `env` defaults to the freshly resolved shell environment (see shared/shellEnv):
 * the binary is then looked up in THAT PATH and the child inherits it, so an
 * agent CLI installed while VS Code was running is launched without a reload.
 * `null` = keep the inherited block (old behaviour, and what tests use).
 *
 * - Non-win32 / non-shim: pass through unchanged (direct spawn, no shell).
 * - win32 `.cmd`/`.bat` shim: Node's spawn refuses these without a shell.
 *   The safe route is spawning `cmd.exe` with the whole command line passed
 *   VERBATIM (windowsVerbatimArguments — Node then performs no MSVCRT
 *   re-quoting) as a single /c argument in cmd grammar, so quoted prompts
 *   (which routinely contain double quotes) reach the shim intact.
 *   Residual hazard, documented: cmd still expands %VAR% inside double
 *   quotes, so a prompt containing literal % sequences is the one case the
 *   shim path mangles — the .exe / bare / POSIX paths never touch a shell.
 */
export function resolveSpawn(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? process.env.comspec ?? 'cmd.exe',
  env: NodeJS.ProcessEnv | null = currentShellEnv() ?? null,
): ResolvedSpawn {
  // Spawn the FILE the freshly resolved PATH points at rather than a bare name
  // the host's inherited PATH has to resolve: a toolchain installed after VS
  // Code started is missing from the inherited block, and on Windows
  // CreateProcess searches the PARENT path, not the env block we hand it.
  const resolved = env ? findOnPath(env, bin, platform) ?? bin : bin;
  const childEnv: cp.SpawnOptions = env ? { env } : {};
  if (platform === 'win32' && isCmdShim(resolved)) {
    return {
      bin: comspec,
      args: ['/d', '/s', '/c', cmdLineForShim(resolved, args)],
      opts: { windowsVerbatimArguments: true, ...childEnv },
    };
  }
  return env ? { bin: resolved, args, opts: childEnv } : { bin: resolved, args };
}

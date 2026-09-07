import * as cp from 'child_process';

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
): ResolvedSpawn {
  if (platform === 'win32' && isCmdShim(bin)) {
    return {
      bin: comspec,
      args: ['/d', '/s', '/c', cmdLineForShim(bin, args)],
      opts: { windowsVerbatimArguments: true },
    };
  }
  return { bin, args };
}

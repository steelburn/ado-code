/**
 * Fresh-PATH resolution for anything that has to find an external tool: the
 * /new-project dependency probes, the remote tunnel probe and the agent-CLI
 * detection sweep.
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension host inherits the environment block VS Code was launched with.
 * A toolchain installed afterwards lands in a directory that only a *newly
 * started* process sees, so the wizard's Dependencies step reported "missing"
 * until VS Code itself was restarted — while the integrated terminal found the
 * same tool, because the terminal resolves its shell environment by itself.
 *
 * `resolveShellEnv()` asks a freshly spawned shell (or, on Windows, the
 * persisted registry values) for the PATH a new process would start with and
 * merges it into `process.env`, so the probes and the autonomous installs spawn
 * with the PATH of a new terminal. One lookup per round, never per spec.
 *
 * Never throws: a failed or slow lookup returns `undefined` and the caller
 * keeps today's behaviour (the inherited block).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const LOOKUP_TIMEOUT_MS = 5000;

/**
 * Markers around the value, because a login/interactive shell may print its own
 * banner to stdout (nvm notices, "no job control", motd) before we get a word.
 */
const MARKER_START = '__ADO_PATH__';
const MARKER_END = '__ADO_END__';

/** Injectable so the tests never spawn a process. */
export type EnvLookupRunner = (cmd: string, args: string[]) => Promise<string>;

function defaultRunner(cmd: string, args: string[]): Promise<string> {
  return new Promise<string>(resolve => {
    try {
      execFile(
        cmd,
        args,
        { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024, shell: false },
        (err, stdout) => resolve(err ? '' : String(stdout || '')),
      );
    } catch {
      resolve('');
    }
  });
}

/**
 * The command whose stdout carries the PATH of a *new* process.
 *
 * win32: the persisted registry values (Machine + User) — that is literally the
 * block Explorer builds for a freshly started `cmd.exe`, and it does not depend
 * on the stale block we inherited. Linux/macOS: a login + interactive shell,
 * which re-reads the profile files where a new toolchain (or an nvm/asdf shim
 * directory) appends itself — this also fixes the famously minimal macOS GUI
 * PATH.
 */
export function lookupCommand(
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } | undefined {
  if (platform === 'win32') {
    const script =
      `Write-Output ('${MARKER_START}' + ` +
      `[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + ` +
      `[Environment]::GetEnvironmentVariable('Path','User') + '${MARKER_END}')`;
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    };
  }
  const shell = typeof env.SHELL === 'string' && env.SHELL.trim() ? env.SHELL.trim() : '/bin/sh';
  return { cmd: shell, args: ['-l', '-i', '-c', `printf '${MARKER_START}%s${MARKER_END}' "$PATH"`] };
}

/**
 * The value between the LAST marker pair, or undefined when the lookup printed
 * none. Last — not first — because a shell running with `set -x` echoes the
 * command line before running it, and that echo contains the marker literals.
 */
export function extractPath(output: string): string | undefined {
  const end = output.lastIndexOf(MARKER_END);
  if (end === -1) return undefined;
  const start = output.lastIndexOf(MARKER_START, end);
  if (start === -1) return undefined;
  const value = output.slice(start + MARKER_START.length, end).trim();
  return value ? value : undefined;
}

/** `%NAME%` tokens a registry PATH may still carry (a fresh process expands them). */
function expandWindowsRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole: string, name: string) => {
    const hit = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
    return hit ? String(env[hit] ?? '') : whole;
  });
}

function splitPath(value: string, platform: string): string[] {
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map(part => part.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter(part => part.length > 0);
}

/**
 * Fresh entries first — that is the order a new process would resolve them in —
 * then whatever the host already had, so nothing inherited (VS Code's own CLI
 * directory, an injected toolchain) is lost. Deduped case-insensitively on
 * win32, where the filesystem is.
 */
export function mergePathValues(fresh: string, inherited: string, platform: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of [...splitPath(fresh, platform), ...splitPath(inherited, platform)]) {
    const key = platform === 'win32' ? part.toLowerCase() : part;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.join(platform === 'win32' ? ';' : ':');
}

/** `base` with every PATH-ish key collapsed into one, holding `pathValue`. */
export function withPath(
  base: NodeJS.ProcessEnv,
  pathValue: string,
  platform: string,
): NodeJS.ProcessEnv {
  const keys = Object.keys(base);
  const existing = keys.find(key => /^path$/i.test(key));
  // Windows treats the block case-insensitively but rejects two keys that only
  // differ in case, so reuse the casing we inherited (usually `Path`).
  const targetKey = existing ?? (platform === 'win32' ? 'Path' : 'PATH');
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (/^path$/i.test(key)) continue;
    out[key] = base[key];
  }
  out[targetKey] = pathValue;
  return out;
}

export interface ShellEnvOptions {
  platform?: string;
  /** Base environment (defaults to `process.env`). */
  base?: NodeJS.ProcessEnv;
  /** Spawn stub for tests; defaults to a real `execFile`. */
  run?: EnvLookupRunner;
}

/**
 * `process.env` with a freshly resolved PATH, or undefined when the lookup
 * failed — the caller then spawns with the inherited block (old behaviour).
 */
export async function resolveShellEnv(opts: ShellEnvOptions = {}): Promise<NodeJS.ProcessEnv | undefined> {
  try {
    const platform = opts.platform ?? process.platform;
    const base = opts.base ?? process.env;
    const command = lookupCommand(platform, base);
    if (!command) return undefined;

    const output = await (opts.run ?? defaultRunner)(command.cmd, command.args);
    const fresh = extractPath(output);
    if (!fresh) return undefined;

    const inheritedKey = Object.keys(base).find(key => /^path$/i.test(key));
    const inherited = inheritedKey ? String(base[inheritedKey] ?? '') : '';
    const expanded = platform === 'win32' ? expandWindowsRefs(fresh, base) : fresh;
    return withPath(base, mergePathValues(expanded, inherited, platform), platform);
  } catch {
    return undefined;
  }
}

/** The PATH string inside `env` (case-insensitive key match), or undefined. */
export function pathValueOf(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find(candidate => /^path$/i.test(candidate));
  const value = key ? String(env[key] ?? '') : '';
  return value.trim().length > 0 ? value : undefined;
}

/**
 * Absolute path of `bin` inside `env`'s PATH, or undefined when it is not
 * there — the same lookup the wizard's probes use, but returning the file it
 * found, so a caller can spawn that exact path instead of trusting the *host*'s
 * (possibly stale) PATH to resolve a bare name.
 */
export function findOnPath(
  env: NodeJS.ProcessEnv,
  bin: string,
  platform: string = process.platform,
): string | undefined {
  const value = pathValueOf(env);
  if (!value) {
    return undefined;
  }
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of splitPath(value, platform)) {
    for (const ext of exts) {
      try {
        const found = path.join(dir, bin + ext);
        if (fs.existsSync(found)) {
          return found;
        }
      } catch {
        // unreadable PATH entry — keep looking
      }
    }
  }
  return undefined;
}

/**
 * True when `bin` resolves to an existing file inside `env`'s PATH — the
 * no-spawn probe behind the remote tunnel's availability check, using the same
 * candidate list the wizard's probes use.
 */
export function isOnPath(
  env: NodeJS.ProcessEnv,
  bin: string,
  platform: string = process.platform,
): boolean {
  return findOnPath(env, bin, platform) !== undefined;
}

export interface ShellEnvCacheOptions extends ShellEnvOptions {
  /** How long a resolved PATH stays trusted (default 15 s). */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface ShellEnvCache {
  /** Fresh env, resolved at most once per TTL; concurrent callers share one lookup. */
  get(): Promise<NodeJS.ProcessEnv | undefined>;
  /** Last resolved env, synchronously (undefined before the first lookup settles). */
  peek(): NodeJS.ProcessEnv | undefined;
  /** Forget the cached value so the next get() looks again. */
  clear(): void;
}

/**
 * Memoised `resolveShellEnv` for callers that ask repeatedly in a burst — the
 * remote control plane probes at start and again on every provider change, and
 * the tunnel launch wants the same block the probe just used. The short TTL is
 * what keeps a binary installed *after* VS Code started discoverable: the
 * environment a new process would get is re-read every 15 s, not once per window.
 */
export function createShellEnvCache(opts: ShellEnvCacheOptions = {}): ShellEnvCache {
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  let value: NodeJS.ProcessEnv | undefined;
  let at = Number.NEGATIVE_INFINITY;
  let inflight: Promise<NodeJS.ProcessEnv | undefined> | undefined;
  return {
    peek: () => value,
    clear: () => {
      value = undefined;
      at = Number.NEGATIVE_INFINITY;
      inflight = undefined;
    },
    get: () => {
      if (inflight) {
        return inflight;
      }
      if (now() - at < ttlMs) {
        return Promise.resolve(value);
      }
      inflight = resolveShellEnv(opts)
        .catch(() => undefined)
        .then(resolved => {
          inflight = undefined;
          if (!resolved) {
            // A failed or timed-out lookup is not a success: leave the old
            // stamp in place so the next ask looks again (the install the
            // user just ran may only now have finished).
            return undefined;
          }
          value = resolved;
          at = now();
          return resolved;
        });
      return inflight;
    },
  };
}

/**
 * One resolver for the whole extension host: the wizard's probes, the tunnel
 * probe/launch and the agent-CLI detection sweep all ask the same question
 * within seconds of each other, and a login-shell/PowerShell lookup is not free.
 */
export const sharedShellEnv = createShellEnvCache();

/**
 * Last freshly resolved environment, synchronously — `undefined` until the first
 * successful lookup. Synchronous spawn sites (agent CLIs) use it and fall back to
 * the inherited block — the old behaviour — when no lookup has succeeded yet.
 */
export function currentShellEnv(): NodeJS.ProcessEnv | undefined {
  return sharedShellEnv.peek();
}

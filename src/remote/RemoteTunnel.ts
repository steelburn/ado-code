import { execFile, spawn as nodeSpawn } from 'child_process';

import { resolveSpawn } from '../agents/resolveBin';

/**
 * Optional public tunnel for the remote console (R-P1-05).
 *
 * Phase 1 only needs a URL a phone can reach; the tunnel binary is the user's
 * (cloudflared or anything they template through `adoCode.remote.tunnelCommand`)
 * so the extension ships no networking of its own and no extra dependency.
 *
 * Invariants that matter operationally:
 *  - the URL is scraped from **stdout and stderr** (cloudflared prints the
 *    banner on stderr, most custom tools on stdout) and reported ONCE,
 *  - a missing binary reports `onError` and never throws — the console still
 *    works locally,
 *  - `dispose()` is idempotent and kills the whole process tree, because
 *    cloudflared spawns/re-execs on Windows and an orphan keeps the tunnel open.
 */

export type TunnelProvider = 'none' | 'cloudflared' | 'custom';

/** The child-process surface this module uses (kept narrow so tests can fake it). */
export interface TunnelChild {
  pid?: number;
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface RemoteTunnelOptions {
  provider: TunnelProvider;
  port: number;
  /** Custom command template; `{port}` is substituted. */
  customCommand?: string;
  /** Custom URL pattern (regular expression source) used to scrape the tunnel URL. */
  urlPattern?: string;
  spawnFn?: (bin: string, args: string[], opts?: object) => TunnelChild;
  resolveSpawnFn?: (bin: string, args: string[]) => { bin: string; args: string[]; opts?: object };
  killTreeFn?: (pid: number | undefined, child: TunnelChild) => void;
  onUrl?: (url: string) => void;
  onError?: (message: string) => void;
  onExit?: (code: number | null) => void;
}

const CLOUDFLARED_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const GENERIC_URL = /https?:\/\/[^\s"'<>\\]+/i;

/** Split a command template into argv, honouring double quotes. */
export function splitCommandTemplate(template: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of template.trim()) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    out.push(current);
  }
  return out;
}

/** Resolve the argv for a provider, substituting `{port}`. */
export function buildTunnelCommand(
  provider: TunnelProvider,
  port: number,
  customCommand?: string
): { bin: string; args: string[] } | null {
  if (provider === 'none') {
    return null;
  }
  if (provider === 'cloudflared') {
    return { bin: 'cloudflared', args: ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'] };
  }
  const template = (customCommand ?? '').trim();
  if (!template) {
    return null;
  }
  const argv = splitCommandTemplate(template.replace(/\{port\}/g, String(port)));
  if (argv.length === 0) {
    return null;
  }
  return { bin: argv[0]!, args: argv.slice(1) };
}

export class RemoteTunnel {
  private child: TunnelChild | null = null;
  private urlValue: string | undefined;
  private emitted = false;
  private disposed = false;

  constructor(private readonly options: RemoteTunnelOptions) {}

  /** The public URL, once the provider has printed it. */
  get url(): string | undefined {
    return this.urlValue;
  }

  /** True while a child process is alive. */
  get running(): boolean {
    return this.child !== null;
  }

  /** Start the tunnel. Returns the resolved argv, or null when nothing to start. */
  start(): { bin: string; args: string[] } | null {
    if (this.child || this.disposed) {
      return null;
    }
    const command = buildTunnelCommand(this.options.provider, this.options.port, this.options.customCommand);
    if (!command) {
      if (this.options.provider === 'custom') {
        this.fail('Remote Access: adoCode.remote.tunnelCommand is empty — nothing to start.');
      }
      return null;
    }

    const resolveSpawnFn = this.options.resolveSpawnFn ?? ((bin, args) => resolveSpawn(bin, args));
    const spawnFn =
      this.options.spawnFn ??
      ((bin: string, args: string[], opts?: object) =>
        nodeSpawn(bin, args, { ...(opts ?? {}), stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as TunnelChild);

    let resolved: ReturnType<NonNullable<RemoteTunnelOptions['resolveSpawnFn']>>;
    try {
      resolved = resolveSpawnFn(command.bin, command.args);
    } catch (error) {
      this.fail(`Remote Access: could not resolve ${command.bin} — ${errorText(error)}`);
      return null;
    }

    let child: TunnelChild;
    try {
      child = spawnFn(resolved.bin, resolved.args, resolved.opts);
    } catch (error) {
      this.fail(this.spawnFailure(command.bin, error));
      return null;
    }

    this.child = child;
    const scrape = (chunk: unknown): void => this.scrape(chunk);
    child.stdout?.on('data', scrape);
    child.stderr?.on('data', scrape);
    child.on('error', (error: Error) => {
      this.child = null;
      this.fail(this.spawnFailure(command.bin, error));
    });
    child.on('exit', (code: number | null) => {
      this.child = null;
      this.options.onExit?.(code);
    });

    return { bin: resolved.bin, args: resolved.args };
  }

  /** Kill the tunnel (idempotent). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }
    try {
      const killTree =
        this.options.killTreeFn ??
        ((pid: number | undefined, target: TunnelChild) => {
          if (process.platform === 'win32' && pid) {
            execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
            return;
          }
          target.kill();
        });
      killTree(child.pid, child);
    } catch {
      // Killing a dead child is not an error worth surfacing.
    }
  }

  private scrape(chunk: unknown): void {
    if (this.emitted) {
      return;
    }
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (!text) {
      return;
    }
    const pattern = this.compiledPattern();
    const match = pattern.exec(text);
    if (!match) {
      return;
    }
    this.emitted = true;
    this.urlValue = match[0].replace(/[.,;)]+$/, '');
    this.options.onUrl?.(this.urlValue);
  }

  private compiledPattern(): RegExp {
    const custom = this.options.urlPattern?.trim();
    if (custom) {
      try {
        return new RegExp(custom, 'i');
      } catch {
        // A malformed user pattern must not kill the tunnel — fall back to generic.
        return GENERIC_URL;
      }
    }
    return this.options.provider === 'cloudflared' ? CLOUDFLARED_URL : GENERIC_URL;
  }

  private spawnFailure(bin: string, error: unknown): string {
    const detail = errorText(error);
    const hint = /ENOENT|not found/i.test(detail)
      ? ` install it (\`${bin}\`) or point adoCode.remote.tunnelCommand at your own tunnel.`
      : '';
    return `Remote Access: ${bin} failed to start — ${detail}.${hint}`;
  }

  private fail(message: string): void {
    this.options.onError?.(message);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

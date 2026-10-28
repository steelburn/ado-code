/**
 * Remote URL resolution + classification (R-P1-04).
 *
 * The console has to be reachable from a phone, and "reachable" is not one thing:
 *
 *   external    VS Code already port-forwarded us (Codespaces, Remote-SSH,
 *               dev tunnels) — `asExternalUri` came back with a public host.
 *   tunnel      the user started cloudflared / a custom tunnel; the public URL
 *               wins over the loopback one.
 *   local       plain desktop: loopback, or the LAN address when bound to all.
 *   unavailable VS Code Web / vscode.dev cannot be forwarded — Remote Access
 *               stays off with an explanatory message.
 *
 * Everything is injected so this file is vscode-free and headless-testable, and
 * `resolveRemoteUrl` never throws: a forwarding failure must degrade to
 * "local only", not break activation.
 */

export type RemoteUrlKind = 'external' | 'tunnel' | 'local' | 'unavailable';

export interface RemoteUrlResolution {
  kind: RemoteUrlKind;
  /** Console URL including the `#t=<token>` fragment, when there is one. */
  url: string | null;
  /** The raw loopback URL (no token) — used for the port-forward call and logs. */
  loopbackUrl: string;
  /** Human-readable one-liner for the status bar tooltip / QR panel banner. */
  message: string;
}

export interface RemoteUrlDeps {
  /** `vscode.UIKind.Desktop` is 1, `vscode.UIKind.Web` is 2. */
  uiKind: number;
  /** `vscode.env.asExternalUri` equivalent; rejection is tolerated. */
  asExternalUri?: (url: string) => Promise<string>;
  /** `vscode.env.remoteName` — messaging only, never used for gating. */
  remoteName?: string | undefined;
  /** Active tunnel URL, if a tunnel is running. */
  tunnelUrl?: string | undefined;
  /** `adoCode.remote.bind`. */
  bind?: 'loopback' | 'all';
  /** LAN host to advertise when `bind === 'all'`. */
  lanAddress?: string | undefined;
}

/** `vscode.UIKind.Desktop` */
export const UI_KIND_DESKTOP = 1;

/** Hosts that mean "still on this machine". */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '::'
  );
}

/** Loopback base URL for a port. */
export function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** Append the token as a URL fragment (fragments are never sent to the server). */
export function withTokenFragment(url: string, token: string): string {
  const base = url.endsWith('/') ? url : `${url}/`;
  return `${base}#t=${token}`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Best-effort port recovery from a forwarded URL — VS Code's tunnels and
 * Codespaces both encode the port either explicitly (`:41234`) or as a host
 * label (`big-space-yonder-41234.github.dev`).
 */
export function getPortFromExternalUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const explicit = Number(parsed.port);
      return Number.isInteger(explicit) && explicit > 0 && explicit < 65536 ? explicit : null;
    }
    const match = /(?:^|[.-])(\d{2,5})(?:[.-]|$)/.exec(parsed.hostname);
    if (!match) {
      return null;
    }
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the best console URL for this session.
 *
 * Order (see the plan): uiKind gate → `asExternalUri` classification → tunnel
 * override → loopback/LAN fallback.
 */
export async function resolveRemoteUrl(
  port: number,
  token: string,
  deps: RemoteUrlDeps
): Promise<RemoteUrlResolution> {
  const loopback = loopbackUrl(port);

  if (deps.uiKind !== UI_KIND_DESKTOP) {
    return {
      kind: 'unavailable',
      url: null,
      loopbackUrl: loopback,
      message: 'Remote Access needs VS Code Desktop — the web client cannot forward a local port.',
    };
  }

  // Forwarding: a rejection means "no forward available", not an error state.
  let external: string | null = null;
  if (deps.asExternalUri) {
    try {
      const forwarded = await deps.asExternalUri(loopback);
      if (typeof forwarded === 'string' && forwarded) {
        external = forwarded;
      }
    } catch {
      external = null;
    }
  }

  const remoteLabel = deps.remoteName ? ` (${deps.remoteName})` : '';

  if (external) {
    const host = hostOf(external);
    if (host && !isLoopbackHost(host)) {
      return {
        kind: 'external',
        url: withTokenFragment(external, token),
        loopbackUrl: loopback,
        message: `Reachable through the forwarded port${remoteLabel}.`,
      };
    }
  }

  // Local-only forwarding (or none): a running tunnel is the only public route.
  if (deps.tunnelUrl) {
    return {
      kind: 'tunnel',
      url: withTokenFragment(deps.tunnelUrl, token),
      loopbackUrl: loopback,
      message: `Reachable through the tunnel${remoteLabel}.`,
    };
  }

  if (deps.bind === 'all' && deps.lanAddress) {
    const lan = `http://${deps.lanAddress}:${port}/`;
    return {
      kind: 'local',
      url: withTokenFragment(lan, token),
      loopbackUrl: loopback,
      message: `Local only — scanning works from your LAN via ${deps.lanAddress}${remoteLabel}.`,
    };
  }

  return {
    kind: 'local',
    url: withTokenFragment(loopback, token),
    loopbackUrl: loopback,
    message: `Local only — no public URL. This QR only works on this machine${remoteLabel}.`,
  };
}

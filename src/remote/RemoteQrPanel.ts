/**
 * Remote access QR panel (R-P1-10).
 *
 * The panel is a single webview that shows the console URL as a scannable QR
 * code plus a banner explaining *how* that URL is reachable — the distinction
 * matters, because a loopback URL scanned on a phone cannot work and the user
 * must be told so instead of silently getting a QR that does nothing.
 *
 * Three things are deliberate:
 *
 *   - No script. The panel is static markup: the QR is inline SVG, the styles
 *     are inline, and the only interactive element is a `command:` link that
 *     VS Code handles (`enableCommandUris` on the host panel).
 *   - No remote resources. The webview must render with no network access, so
 *     there is nothing to fail or to leak.
 *   - The QR encodes the *resolved* URL (public/tunnel) rather than the
 *     loopback one, and the loopback URL is never printed when a public URL
 *     exists — a stale loopback string is what makes users scan the wrong code.
 *
 * `renderQrHtml` is pure, so the whole banner matrix is unit-testable without a
 * VS Code host; `RemoteQrPanel` only owns panel lifetime.
 */

import { toSvg } from '../shared/qrcode';
import type { RemoteUrlResolution } from './remoteUrl';

export interface RemoteQrPanelPayload {
  /** Console URL including the token fragment (empty string when there is none). */
  url: string;
  /** Where that URL came from — drives the banner and the call to action. */
  resolution: RemoteUrlResolution;
  /** Public tunnel URL, when a tunnel is running. */
  tunnelUrl?: string;
  /** Connected mobile clients, shown as a hint that someone is watching. */
  deviceCount: number;
}

/**
 * Minimal surface of `vscode.WebviewPanel` used by the controller. Keeping it
 * structural is what lets the panel be tested without an extension host.
 */
export interface QrPanelHost {
  readonly webview: { html: string };
  onDidDispose(listener: () => void): void;
  reveal(): void;
  dispose(): void;
}

export interface RemoteQrPanelDeps {
  createPanel: () => QrPanelHost;
  /** Called once per open (a re-render of an open panel must not fire again). */
  onShown?: () => void;
}

/** Command invoked by the "expose through a tunnel" link in the panel. */
export const TUNNEL_START_COMMAND = 'adoCode.remote.tunnel.start';

export const QR_PANEL_TITLE = 'Remote Access';

interface Banner {
  tone: 'ok' | 'warn';
  title: string;
  detail: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bannerFor(resolution: RemoteUrlResolution): Banner {
  switch (resolution.kind) {
    case 'external':
      return {
        tone: 'ok',
        title: 'Port forwarding active',
        detail: 'Provided by VS Code port forwarding — reachable from your phone.',
      };
    case 'tunnel':
      return {
        tone: 'ok',
        title: 'Tunnel active',
        detail: 'Reachable from any device while the tunnel keeps running.',
      };
    case 'unavailable':
      return { tone: 'warn', title: 'Remote access is off', detail: resolution.message };
    case 'local':
    default:
      return {
        tone: 'warn',
        title: 'Local only',
        detail:
          resolution.message ||
          'No public URL — this QR only works on this machine. Start a tunnel to use it from a phone.',
      };
  }
}

function renderQr(target: string): string {
  if (!target) {
    return '<p class="qr-missing">No URL yet — start remote access first.</p>';
  }
  try {
    const svg = toSvg(target, { ecc: 'M', scale: 6, border: 4 });
    return `<div class="qr">${svg}</div>`;
  } catch {
    // A URL too long for the encoder must not break the panel.
    return '<p class="qr-missing">QR code unavailable for this URL — copy the link below.</p>';
  }
}

function deviceLabel(count: number): string {
  if (count <= 0) {
    return 'No devices connected yet';
  }
  return count === 1 ? '1 device connected' : `${count} devices connected`;
}

/**
 * Render the whole panel body. Pure and host-free: given a payload it always
 * returns the same self-contained HTML document.
 */
export function renderQrHtml(payload: RemoteQrPanelPayload): string {
  const { resolution, deviceCount, tunnelUrl } = payload;
  const target = resolution.url ?? '';
  const banner = bannerFor(resolution);
  const showTunnelLine = Boolean(tunnelUrl) && tunnelUrl !== target;
  const showTunnelCta = resolution.kind === 'local' || resolution.kind === 'unavailable';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;" />
<title>Remote Access</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 20px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  h1 { font-size: 1.1em; font-weight: 600; margin: 0 0 4px; }
  .device-count { margin: 0 0 16px; opacity: 0.75; font-size: 0.9em; }
  .banner {
    display: block;
    padding: 10px 12px;
    margin-bottom: 16px;
    border-radius: 4px;
    border-left: 3px solid transparent;
  }
  .banner--ok {
    background: var(--vscode-inputValidation-infoBackground, rgba(0, 120, 212, 0.12));
    border-left-color: var(--vscode-inputValidation-infoBorder, #0078d4);
  }
  .banner--warn {
    background: var(--vscode-inputValidation-warningBackground, rgba(255, 204, 0, 0.12));
    border-left-color: var(--vscode-inputValidation-warningBorder, #ffcc00);
  }
  .banner strong { display: block; margin-bottom: 2px; }
  .banner span { display: block; opacity: 0.85; }
  .qr {
    display: flex;
    justify-content: center;
    padding: 12px;
    background: #ffffff;
    border-radius: 4px;
    width: fit-content;
    margin: 0 auto 16px;
  }
  .qr svg { display: block; width: 240px; height: 240px; }
  .qr-missing { text-align: center; opacity: 0.8; }
  .url {
    margin-bottom: 12px;
    padding: 8px 10px;
    background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
    border-radius: 4px;
    overflow-wrap: anywhere;
  }
  code { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
  .tunnel, .hint, .cta { margin: 0 0 8px; }
  .hint { opacity: 0.75; font-size: 0.9em; }
  a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
  <h1>Remote Access</h1>
  <p class="device-count">${escapeHtml(deviceLabel(deviceCount))}</p>
  <section class="banner banner--${banner.tone}">
    <strong>${escapeHtml(banner.title)}</strong>
    <span>${escapeHtml(banner.detail)}</span>
  </section>
  ${renderQr(target)}
  <div class="url"><code>${escapeHtml(target || '(no URL)')}</code></div>
  ${showTunnelLine ? `<p class="tunnel">Tunnel: <code>${escapeHtml(tunnelUrl!)}</code></p>` : ''}
  ${
    showTunnelCta
      ? `<p class="cta"><a href="command:${TUNNEL_START_COMMAND}">Expose this console through a tunnel…</a></p>`
      : ''
  }
  <p class="hint">Scan the code with the camera on your phone. Remote access stays on until you turn it off.</p>
</body>
</html>`;
}

/**
 * Owns the panel lifetime: one panel at most, re-rendered in place when the URL
 * changes, and reopened on demand after the user closes it.
 */
export class RemoteQrPanel {
  private panel: QrPanelHost | undefined;
  private payload: RemoteQrPanelPayload | undefined;

  constructor(private readonly deps: RemoteQrPanelDeps) {}

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Show `payload`, reusing an already-open panel instead of opening a second. */
  show(payload: RemoteQrPanelPayload): void {
    const existing = this.panel;
    if (existing) {
      this.render(payload);
      existing.reveal();
      return;
    }
    const panel = this.deps.createPanel();
    this.panel = panel;
    panel.onDidDispose(() => {
      // Only clear our reference if it is still the current panel: a
      // `dispose()` of a stale panel must not orphan a newer one.
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.render(payload);
    panel.reveal();
    this.deps.onShown?.();
  }

  /**
   * Update only the URL of an open panel. A no-op when no panel is open — the
   * panel is never opened implicitly by a URL change.
   */
  setUrl(url: string, resolution?: RemoteUrlResolution): void {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    const previous = this.payload;
    const base: RemoteUrlResolution = resolution ??
      previous?.resolution ?? {
        kind: 'local',
        url,
        loopbackUrl: url,
        message: 'Local only — this QR only works on this machine.',
      };
    this.render({
      url,
      resolution: { ...base, url },
      tunnelUrl: previous?.tunnelUrl,
      deviceCount: previous?.deviceCount ?? 0,
    });
    panel.reveal();
  }

  /** Close the panel; later updates are ignored. */
  dispose(): void {
    const panel = this.panel;
    this.panel = undefined;
    this.payload = undefined;
    panel?.dispose();
  }

  private render(payload: RemoteQrPanelPayload): void {
    this.payload = payload;
    if (this.panel) {
      this.panel.webview.html = renderQrHtml(payload);
    }
  }
}

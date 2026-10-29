import type { RemoteDownstreamEvent } from '../shared/remoteProtocol';
import { RemoteTokenStore } from './remoteToken';
import { withTokenFragment, type RemoteUrlResolution } from './remoteUrl';
import type { RemoteQrPanelPayload } from './RemoteQrPanel';

/**
 * Remote Access control plane (R-P1-08).
 *
 * One class owns every side effect of the feature — status bar, commands,
 * server, tunnel, QR panel — because "who is currently listening" has to have
 * exactly one answer. `adoCode.remote.enabled` is the single source of truth:
 * commands write the setting, the configuration listener reconciles, and
 * `reconcile()` is idempotent and serialized so a toggle can never interleave
 * two start/stop cycles.
 *
 * Every VS Code surface is injected (status bar factory, config listener,
 * quick pick, clipboard, notifications) so the headless suites drive the whole
 * state machine without an extension host.
 */

export interface RemoteSettings {
  enabled: boolean;
  bind: 'loopback' | 'all';
  port: number;
  tunnel: 'none' | 'cloudflared' | 'custom';
  tunnelCommand: string;
  tunnelUrlPattern: string;
}

/** The shape of the status bar entry this class drives. */
export interface StatusBarLike {
  text: string;
  tooltip?: unknown;
  command?: string;
  backgroundColor?: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** The server surface RemoteControl needs (`RemoteServer` in production). */
export interface RemoteServerLike {
  readonly port: number;
  readonly viewerCount: number;
  start(): Promise<number>;
  broadcast(event: RemoteDownstreamEvent): void;
  /** Admit the public host of the tunnel now running (see RemoteServer). */
  allowHost(url: string): void;
  clearAllowedHosts(): void;
  dispose(): Promise<void>;
}

/** The tunnel surface RemoteControl needs (`RemoteTunnel` in production). */
export interface RemoteTunnelLike {
  readonly url: string | undefined;
  readonly running: boolean;
  start(): unknown;
  dispose(): void;
}

export interface RemoteControlDeps {
  tokens: RemoteTokenStore;
  /** Current settings, read fresh from the workspace configuration. */
  readSettings: () => RemoteSettings;
  /** Write one setting at `ConfigurationTarget.Global`. */
  writeEnabled: (enabled: boolean) => Promise<void>;
  onDidChangeConfiguration: (listener: () => void) => { dispose(): void };
  createStatusBarItem: () => StatusBarLike;
  registerCommand: (id: string, handler: (...args: never[]) => unknown) => { dispose(): void };
  setContext: (key: string, value: unknown) => Promise<void> | void;
  resolveUrl: (port: number, token: string, tunnelUrl?: string) => Promise<RemoteUrlResolution>;
  serverFactory: (options: { verifyToken: (candidate: string) => boolean | Promise<boolean> }) => RemoteServerLike;
  tunnelFactory: (handlers: {
    onUrl: (url: string) => void;
    onError: (message: string) => void;
    onExit: (code: number | null) => void;
  }) => RemoteTunnelLike;
  /** True when the configured tunnel provider's binary is available. */
  tunnelAvailable: (provider: RemoteSettings['tunnel']) => boolean;
  showQuickPick: (
    items: Array<{ label: string; description?: string; provider: RemoteSettings['tunnel'] }>,
    options: { placeHolder: string; activeItem?: { label: string } }
  ) => Promise<{ label: string; provider: RemoteSettings['tunnel'] } | undefined>;
  showQrPanel: (payload: RemoteQrPanelPayload) => void;
  hideQrPanel: () => void;
  copyToClipboard: (text: string) => Promise<void>;
  notify: (message: string, kind?: 'info' | 'warn' | 'error') => void;
  createTooltip?: (markdown: string) => unknown;
  logger?: { warn(message: string): void };
}

/**
 * The payload shape lives with the panel (`RemoteQrPanel.ts`) so the two cannot
 * drift; re-exported here for the control plane's dependency contract.
 */
export type { RemoteQrPanelPayload } from './RemoteQrPanel';

export type RemoteControlState = 'off' | 'starting' | 'on' | 'error';

const STATUS_BAR_PRIORITY = 98;

export class RemoteControl {
  private readonly statusItem: StatusBarLike;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private server: RemoteServerLike | null = null;
  private tunnel: RemoteTunnelLike | null = null;
  private state: RemoteControlState = 'off';
  private lastError: string | undefined;
  private reconciliation: Promise<void> = Promise.resolve();
  private offeredTunnelThisSession = false;
  private tunnelOfferInFlight = false;
  private disposed = false;

  constructor(private readonly deps: RemoteControlDeps) {
    this.statusItem = deps.createStatusBarItem();
    this.statusItem.command = 'adoCode.remote.showQr';
    this.statusItem.show();
  }

  /** Wire the configuration listener and the five commands. */
  activate(): void {
    // Render the idle state synchronously: the first reconciliation is async,
    // and a blank status bar (plus unset context keys) is not an acceptable
    // intermediate state.
    void this.setState('off');
    this.disposables.push(
      this.deps.onDidChangeConfiguration(() => {
        void this.reconcile();
      })
    );
    const commands: Array<[string, (...args: never[]) => unknown]> = [
      ['adoCode.remote.toggle', () => this.toggle()],
      ['adoCode.remote.showQr', () => this.showQr()],
      ['adoCode.remote.copyUrl', () => this.copyUrl()],
      ['adoCode.remote.rotateToken', () => this.rotateToken()],
      ['adoCode.remote.tunnel.start', () => this.startTunnel()],
      ['adoCode.remote.stop', () => this.stop()],
    ];
    for (const [id, handler] of commands) {
      this.disposables.push(this.deps.registerCommand(id, handler));
    }
    void this.reconcile();
  }

  /** Current state (exported for tests and the STATUS tree node). */
  get currentState(): RemoteControlState {
    return this.state;
  }

  /** Connected console count. */
  get deviceCount(): number {
    return this.server?.viewerCount ?? 0;
  }

  /** Public console URL, when running. */
  async currentUrl(): Promise<RemoteUrlResolution | null> {
    if (!this.server) {
      return null;
    }
    const token = await this.deps.tokens.ensure();
    return this.deps.resolveUrl(this.server.port, token, this.tunnel?.url);
  }

  /** Fan a chat message out to connected consoles (no-op when off). */
  broadcast(event: RemoteDownstreamEvent): void {
    this.server?.broadcast(event);
  }

  /** Flip the setting; the listener performs the actual reconcile. */
  async toggle(): Promise<void> {
    const desired = !this.deps.readSettings().enabled;
    await this.deps.writeEnabled(desired);
    await this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.deps.readSettings().enabled) {
      await this.deps.writeEnabled(false);
    }
    await this.reconcile();
  }

  /** Show the QR panel, starting the stack first when it is off. */
  async showQr(): Promise<void> {
    const settings = this.deps.readSettings();
    if (!settings.enabled) {
      await this.deps.writeEnabled(true);
      await this.reconcile();
    }
    const resolution = await this.currentUrl();
    if (!resolution || !this.server) {
      this.deps.notify('Remote Access is not running.', 'warn');
      return;
    }
    this.deps.showQrPanel({
      url: resolution.url ?? '',
      resolution,
      tunnelUrl: this.tunnel?.url,
      deviceCount: this.deviceCount,
    });
  }

  async copyUrl(): Promise<void> {
    const resolution = await this.currentUrl();
    if (!resolution?.url) {
      this.deps.notify(resolution?.message ?? 'Remote Access is not running.', 'warn');
      return;
    }
    await this.deps.copyToClipboard(resolution.url);
    this.deps.notify('Remote console URL copied to the clipboard.');
  }

  /** Rotate the token: every open console is signed out on its next request. */
  async rotateToken(): Promise<void> {
    const token = await this.deps.tokens.rotate();
    if (!this.server) {
      this.deps.notify('Remote Access: a new token was generated and stored.');
      return;
    }
    const resolution = await this.deps.resolveUrl(this.server.port, token, this.tunnel?.url);
    this.deps.showQrPanel({
      url: resolution.url ?? '',
      resolution,
      tunnelUrl: this.tunnel?.url,
      deviceCount: this.deviceCount,
    });
    this.deps.notify('Remote Access: token rotated — rescan the QR code.');
  }

  /**
   * Offer the tunnel QuickPick. Guarded twice: once per session (don't nag) and
   * once per in-flight picker (the QR panel can reopen while it is open).
   */
  async offerTunnelIfNeeded(): Promise<void> {
    const settings = this.deps.readSettings();
    if (!settings.enabled || settings.tunnel !== 'none' || this.tunnel || settings.tunnelUrlPattern === '__never__') {
      return;
    }
    if (this.offeredTunnelThisSession || this.tunnelOfferInFlight) {
      return;
    }
    this.offeredTunnelThisSession = true;
    this.tunnelOfferInFlight = true;
    try {
      await this.pickAndStartTunnel();
    } finally {
      this.tunnelOfferInFlight = false;
    }
  }

  async startTunnel(): Promise<void> {
    this.offeredTunnelThisSession = true;
    await this.pickAndStartTunnel();
  }

  /** Serialized, idempotent reconcile of server + tunnel + status bar against settings. */
  async reconcile(): Promise<void> {
    const next = this.reconciliation.then(() => this.reconcileNow());
    // Keep the chain alive even if one pass throws.
    this.reconciliation = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.server?.dispose();
    this.server = null;
    this.tunnel?.dispose();
    this.tunnel = null;
    for (const disposable of this.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // ignore
      }
    }
    this.statusItem.dispose();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async reconcileNow(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const settings = this.deps.readSettings();
    try {
      if (!settings.enabled) {
        await this.teardown();
        this.setState('off');
        return;
      }

      await this.deps.tokens.ensure();
      if (!this.server) {
        this.setState('starting');
        const server = this.deps.serverFactory({
          verifyToken: (candidate) => this.deps.tokens.verify(candidate),
        });
        // The token is stored in SecretStorage, so an existing cookie from a
        // previous session keeps working until the token is rotated.
        await server.start();
        this.server = server;
      }

      if (settings.tunnel !== 'none' && !this.tunnel) {
        if (!this.deps.tunnelAvailable(settings.tunnel)) {
          this.deps.notify(
            `Remote Access: ${settings.tunnel} was not found — the console stays local-only.`,
            'warn'
          );
        } else {
          this.tunnel = this.createTunnel();
          this.tunnel.start();
        }
      }

      this.setState('on');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn(`remote access: ${this.lastError}`);
      this.setState('error');
      this.deps.notify(`Remote Access failed to start: ${this.lastError}`, 'error');
    }
  }

  private async teardown(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await server.dispose();
    }
    this.tunnel?.dispose();
    this.tunnel = null;
    this.lastError = undefined;
  }

  private createTunnel(): RemoteTunnelLike {
    return this.deps.tunnelFactory({
      onUrl: (url) => this.handleTunnelUrl(url),
      onError: (message) => {
        this.deps.notify(message, 'error');
        void this.setState(this.server ? 'on' : 'error');
      },
      onExit: () => {
        this.tunnel = null;
        this.server?.clearAllowedHosts();
        void this.setState(this.server ? 'on' : 'off');
      },
    });
  }

  /**
   * Every tunnel URL reaches the panel through here. The console reads its token
   * out of the `#t=` fragment (see consolePage.ts), so a QR drawn from the bare
   * tunnel URL authenticates nobody — the fragment is not optional, exactly as
   * `resolveUrl` does it on the non-eager path.
   */
  private handleTunnelUrl(url: string): void {
    // The tunnel forwards its own public Host header, which the rebinding guard
    // would otherwise reject as `forbidden host`.
    this.server?.allowHost(url);
    void this.setState('on');
    void this.showTunnelPanel(url).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.notify(`Remote Access could not show the tunnel URL: ${this.lastError}`, 'error');
    });
  }

  /** Render the tunnel URL with its token fragment — the phone needs both. */
  private async showTunnelPanel(url: string): Promise<void> {
    const token = await this.deps.tokens.ensure();
    const publicUrl = withTokenFragment(url, token);
    this.deps.showQrPanel({
      url: publicUrl,
      resolution: {
        kind: 'tunnel',
        url: publicUrl,
        loopbackUrl: `http://127.0.0.1:${this.server?.port ?? 0}/`,
        message: 'Reachable through the tunnel.',
      },
      deviceCount: this.deviceCount,
    });
  }

  private async pickAndStartTunnel(): Promise<void> {
    const settings = this.deps.readSettings();
    const items: Array<{ label: string; description?: string; provider: RemoteSettings['tunnel'] }> = [
      { label: 'cloudflared', description: 'Quick tunnel — install cloudflared first', provider: 'cloudflared' },
      { label: 'custom command', description: 'Use adoCode.remote.tunnelCommand', provider: 'custom' },
      { label: 'not now', description: 'Stay local-only', provider: 'none' },
    ];
    const picked = await this.deps.showQuickPick(items, {
      placeHolder: 'Expose the remote console with a tunnel?',
      activeItem: items[0],
    });
    if (!picked || picked.provider === 'none') {
      return;
    }
    if (!this.deps.tunnelAvailable(picked.provider)) {
      this.deps.notify(`Remote Access: ${picked.label} is not available on this machine.`, 'warn');
      return;
    }
    if (!this.server) {
      await this.reconcile();
      if (!this.server) {
        this.deps.notify('Remote Access must be on before starting a tunnel.', 'warn');
        return;
      }
    }
    // Start the chosen provider directly so the offer never depends on the
    // setting having been persisted first.
    this.tunnel?.dispose();
    const tunnel = this.deps.tunnelFactory({
      onUrl: (url) => this.handleTunnelUrl(url),
      onError: (message) => {
        this.deps.notify(message, 'error');
        this.tunnel = null;
        void this.setState(this.server ? 'on' : 'error');
      },
      onExit: () => {
        this.tunnel = null;
        void this.setState(this.server ? 'on' : 'off');
      },
    });
    this.tunnel = tunnel;
    tunnel.start();
    if (settings.tunnel !== picked.provider) {
      this.deps.notify(
        `${picked.label} tunnel starting — set adoCode.remote.tunnel to "${picked.provider}" to keep it across reloads.`
      );
    }
  }

  private async setState(state: RemoteControlState): Promise<void> {
    this.state = state;
    const settings = this.deps.readSettings();
    const tooltipMarkdown = [
      `**ADO Code — Remote Access**`,
      state === 'on'
        ? `Listening on \`${settings.bind === 'all' ? 'all interfaces' : '127.0.0.1'}:${this.server?.port ?? 0}\` · ${this.deviceCount} console(s)`
        : state === 'error'
          ? `Error: ${this.lastError ?? 'unknown'}`
          : 'Off — the console is not listening.',
      '',
      '[Show QR](command:adoCode.remote.showQr) · [Copy URL](command:adoCode.remote.copyUrl) · [Rotate token](command:adoCode.remote.rotateToken) · [Stop](command:adoCode.remote.stop)',
    ].join('\n');

    switch (state) {
      case 'on': {
        const count = this.deviceCount;
        this.statusItem.text = count > 0 ? `$(broadcast) Remote ${count}` : '$(broadcast) Remote';
        this.statusItem.backgroundColor = undefined;
        break;
      }
      case 'starting':
        this.statusItem.text = '$(radio-tower) Remote';
        this.statusItem.backgroundColor = undefined;
        break;
      case 'error':
        this.statusItem.text = '$(error) Remote';
        // `warningBackground` keeps the failure visible without claiming a hard error state.
        this.statusItem.backgroundColor = 'warningBackground';
        break;
      default:
        this.statusItem.text = '$(radio-tower) Remote';
        this.statusItem.backgroundColor = undefined;
        break;
    }
    this.statusItem.tooltip = this.deps.createTooltip
      ? this.deps.createTooltip(tooltipMarkdown)
      : tooltipMarkdown;
    this.statusItem.show();
    void this.deps.setContext('adoCode.remoteActive', state === 'on');
    void this.deps.setContext('adoCode.remoteState', state);
    void this.deps.setContext('adoCode.remoteViewers', this.deviceCount);
  }
}

/** Status bar priority used by the wiring layer. */
export const REMOTE_STATUS_BAR_PRIORITY = STATUS_BAR_PRIORITY;

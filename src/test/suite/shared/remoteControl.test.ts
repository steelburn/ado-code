import * as assert from 'assert';

import {
    RemoteControl,
    type RemoteControlDeps,
    type RemoteServerLike,
    type RemoteSettings,
    type RemoteTunnelLike,
    type StatusBarLike,
} from '../../../remote/RemoteControl';
import { RemoteTokenStore, type SecretStorageLike } from '../../../remote/remoteToken';
import type { RemoteDownstreamEvent } from '../../../shared/remoteProtocol';

class FakeSecrets implements SecretStorageLike {
    readonly map = new Map<string, string>();
    async get(key: string): Promise<string | undefined> {
        return this.map.get(key);
    }
    async store(key: string, value: string): Promise<void> {
        this.map.set(key, value);
    }
    async delete(key: string): Promise<void> {
        this.map.delete(key);
    }
}

class FakeStatusBar implements StatusBarLike {
    text = '';
    tooltip: unknown;
    command: string | undefined;
    backgroundColor: unknown;
    shown = 0;
    hidden = 0;
    disposed = false;
    show(): void {
        this.shown++;
    }
    hide(): void {
        this.hidden++;
    }
    dispose(): void {
        this.disposed = true;
    }
}

class FakeServer implements RemoteServerLike {
    port = 41234;
    viewerCount = 0;
    starts = 0;
    disposals = 0;
    broadcasts: RemoteDownstreamEvent[] = [];
    async start(): Promise<number> {
        this.starts++;
        return this.port;
    }
    broadcast(event: RemoteDownstreamEvent): void {
        this.broadcasts.push(event);
    }
    async dispose(): Promise<void> {
        this.disposals++;
    }
}

class FakeTunnel implements RemoteTunnelLike {
    url: string | undefined;
    running = false;
    starts = 0;
    disposals = 0;
    start(): unknown {
        this.starts++;
        this.running = true;
        return null;
    }
    dispose(): void {
        this.disposals++;
        this.running = false;
    }
}

interface Rig {
    control: RemoteControl;
    status: FakeStatusBar;
    servers: FakeServer[];
    tunnels: FakeTunnel[];
    settings: RemoteSettings;
    contexts: Record<string, unknown>;
    notifications: Array<{ message: string; kind?: string }>;
    clipboard: string[];
    writes: boolean[];
    fireConfigChange: () => void;
    quickPickCalls: Array<{ items: Array<{ label: string }>; activeItem?: { label: string } }>;
    commandHandlers: Map<string, (...args: never[]) => unknown>;
    panelCalls: () => number;
    lastPanelUrl: () => string | undefined;
    overrideServerFactory: (factory: () => RemoteServerLike) => void;
}

function createRig(
    options: { settings?: Partial<RemoteSettings>; tunnelAvailable?: boolean; secrets?: FakeSecrets } = {}
): Rig {
    const settings: RemoteSettings = {
        enabled: false,
        bind: 'loopback',
        port: 0,
        tunnel: 'none',
        tunnelCommand: '',
        tunnelUrlPattern: '',
        ...options.settings,
    };
    const status = new FakeStatusBar();
    const servers: FakeServer[] = [];
    const tunnels: FakeTunnel[] = [];
    const contexts: Record<string, unknown> = {};
    const notifications: Array<{ message: string; kind?: string }> = [];
    const clipboard: string[] = [];
    const writes: boolean[] = [];
    const quickPickCalls: Array<{ items: Array<{ label: string }>; activeItem?: { label: string } }> = [];
    const commandHandlers = new Map<string, (...args: never[]) => unknown>();
    let panelCalls = 0;
    let lastPanelUrl: string | undefined;
    let listener: (() => void) | undefined;
    let serverFactoryOverride: (() => RemoteServerLike) | undefined;

    const deps: RemoteControlDeps = {
        tokens: new RemoteTokenStore(options.secrets ?? new FakeSecrets()),
        readSettings: () => settings,
        writeEnabled: async (enabled) => {
            writes.push(enabled);
            settings.enabled = enabled;
            // Real VS Code also fires onDidChangeConfiguration here.
            listener?.();
        },
        onDidChangeConfiguration: (fn) => {
            listener = fn;
            return { dispose: () => (listener = undefined) };
        },
        createStatusBarItem: () => status,
        registerCommand: (id, handler) => {
            commandHandlers.set(id, handler);
            return { dispose: () => commandHandlers.delete(id) };
        },
        setContext: (key, value) => {
            contexts[key] = value;
        },
        resolveUrl: async (port, token, tunnelUrl) => ({
            kind: tunnelUrl ? 'tunnel' : 'local',
            url: tunnelUrl ?? `http://127.0.0.1:${port}/#t=${token}`,
            loopbackUrl: `http://127.0.0.1:${port}/`,
            message: 'test',
        }),
        serverFactory: () => {
            if (serverFactoryOverride) {
                return serverFactoryOverride();
            }
            const server = new FakeServer();
            servers.push(server);
            return server;
        },
        tunnelFactory: () => {
            const tunnel = new FakeTunnel();
            tunnels.push(tunnel);
            return tunnel;
        },
        tunnelAvailable: () => options.tunnelAvailable !== false,
        showQuickPick: async (items, pickOptions) => {
            quickPickCalls.push({ items, activeItem: pickOptions.activeItem });
            const first = items[0];
            return first ? { label: first.label, provider: first.provider } : undefined;
        },
        showQrPanel: (payload) => {
            panelCalls++;
            lastPanelUrl = payload.url;
        },
        hideQrPanel: () => undefined,
        copyToClipboard: async (text) => {
            clipboard.push(text);
        },
        notify: (message, kind) => notifications.push({ message, kind }),
    };

    const control = new RemoteControl(deps);
    return {
        control,
        status,
        servers,
        tunnels,
        settings,
        contexts,
        notifications,
        clipboard,
        writes,
        quickPickCalls,
        commandHandlers,
        fireConfigChange: () => listener?.(),
        panelCalls: () => panelCalls,
        lastPanelUrl: () => lastPanelUrl,
        overrideServerFactory: (factory) => {
            serverFactoryOverride = factory;
        },
    };
}

suite('remote/RemoteControl', () => {
    test('enabling starts one server, flips the context key and shows the device count', async () => {
        const rig = createRig();
        rig.control.activate();
        assert.strictEqual(rig.status.text, '$(radio-tower) Remote');
        assert.strictEqual(rig.contexts['adoCode.remoteActive'], false);

        await rig.control.toggle();

        assert.deepStrictEqual(rig.writes, [true]);
        assert.strictEqual(rig.servers.length, 1);
        assert.strictEqual(rig.servers[0]!.starts, 1);
        assert.strictEqual(rig.control.currentState, 'on');
        assert.strictEqual(rig.status.text, '$(broadcast) Remote');
        assert.strictEqual(rig.contexts['adoCode.remoteActive'], true);
        assert.strictEqual(rig.contexts['adoCode.remoteState'], 'on');
    });

    test('the toggle reconciles exactly once even though the write fires the listener', async () => {
        const rig = createRig();
        rig.control.activate();
        await rig.control.toggle();
        assert.strictEqual(rig.servers.length, 1, 'a single server instance must be created');
        assert.strictEqual(rig.servers[0]!.starts, 1, 'start() must not run twice');
    });

    test('the configuration listener is idempotent', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.control.activate();
        await rig.control.reconcile();
        rig.fireConfigChange();
        rig.fireConfigChange();
        await rig.control.reconcile();

        assert.strictEqual(rig.servers.length, 1);
        assert.strictEqual(rig.servers[0]!.starts, 1, 'no second start() on repeated reconciliation');
    });

    test('disabling tears the server down and returns the status bar to Off', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.control.activate();
        await rig.control.reconcile();
        assert.strictEqual(rig.control.currentState, 'on');

        await rig.control.toggle();

        assert.deepStrictEqual(rig.writes, [false]);
        assert.strictEqual(rig.servers[0]!.disposals, 1);
        assert.strictEqual(rig.control.currentState, 'off');
        assert.strictEqual(rig.status.text, '$(radio-tower) Remote');
        assert.strictEqual(rig.contexts['adoCode.remoteActive'], false);
    });

    test('a failing start reports the error state with warningBackground', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.overrideServerFactory(() => ({
            port: 0,
            viewerCount: 0,
            start: async () => {
                throw new Error('EADDRINUSE');
            },
            broadcast: () => undefined,
            dispose: async () => undefined,
        }));
        rig.control.activate();
        await rig.control.reconcile();

        assert.strictEqual(rig.control.currentState, 'error');
        assert.strictEqual(rig.status.backgroundColor, 'warningBackground');
        assert.match(rig.status.text, /\$\(error\)/);
        assert.ok(rig.notifications.some((n) => /EADDRINUSE/.test(n.message)));
    });

    test('the status bar tooltip carries command links', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.control.activate();
        await rig.control.reconcile();
        const tooltip = String(rig.status.tooltip);
        for (const command of ['showQr', 'copyUrl', 'rotateToken', 'stop']) {
            assert.ok(tooltip.includes(`command:adoCode.remote.${command}`), `tooltip missing ${command}`);
        }
    });

    test('the tunnel QuickPick offers cloudflared first as the active item', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.control.activate();
        await rig.control.reconcile();
        await rig.control.startTunnel();

        assert.strictEqual(rig.quickPickCalls.length, 1);
        const pick = rig.quickPickCalls[0]!;
        assert.strictEqual(pick.items[0]!.label, 'cloudflared');
        assert.strictEqual(pick.activeItem?.label, 'cloudflared');
        assert.strictEqual(rig.tunnels.length, 1);
        assert.strictEqual(rig.tunnels[0]!.starts, 1);
    });

    test('a missing cloudflared neither spawns nor throws', async () => {
        const rig = createRig({ settings: { enabled: true }, tunnelAvailable: false });
        rig.control.activate();
        await rig.control.reconcile();
        await rig.control.startTunnel();

        assert.strictEqual(rig.tunnels.length, 0, 'no tunnel process may be created');
        assert.ok(rig.notifications.some((n) => /not available/.test(n.message)));
    });

    test('the tunnel offer is raised once per session', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.control.activate();
        await rig.control.reconcile();

        await rig.control.offerTunnelIfNeeded();
        await rig.control.offerTunnelIfNeeded();

        assert.strictEqual(rig.quickPickCalls.length, 1, 'the offer must not nag');
    });

    test('no tunnel offer when a tunnel is already configured', async () => {
        const rig = createRig({ settings: { enabled: true, tunnel: 'cloudflared' } });
        rig.control.activate();
        await rig.control.reconcile();
        await rig.control.offerTunnelIfNeeded();
        assert.strictEqual(rig.quickPickCalls.length, 0);
    });

    test('showQr starts the stack, resolves the URL and opens the panel', async () => {
        const rig = createRig();
        rig.control.activate();
        await rig.control.showQr();

        assert.deepStrictEqual(rig.writes, [true]);
        assert.strictEqual(rig.panelCalls(), 1);
        assert.match(rig.lastPanelUrl()!, /^http:\/\/127\.0\.0\.1:41234\/#t=/);
    });

    test('copyUrl writes the resolved console URL to the clipboard', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.control.activate();
        await rig.control.reconcile();
        await rig.control.copyUrl();
        assert.strictEqual(rig.clipboard.length, 1);
        assert.match(rig.clipboard[0]!, /^http:\/\/127\.0\.0\.1:41234\/#t=/);
    });

    test('rotateToken replaces the stored token and re-shows the QR', async () => {
        const secrets = new FakeSecrets();
        const rig = createRig({ settings: { enabled: true }, secrets });
        rig.control.activate();
        await rig.control.reconcile();
        const before = secrets.map.get('adoCode.remote.token');
        assert.ok(before, 'the token must be persisted when Remote Access starts');

        await rig.control.rotateToken();

        assert.notStrictEqual(secrets.map.get('adoCode.remote.token'), before);
        assert.strictEqual(rig.panelCalls(), 1);
        assert.ok(rig.notifications.some((n) => /rotated/.test(n.message)));
    });

    test('broadcast reaches the server only while it is running', async () => {
        const rig = createRig({ settings: { enabled: true } });
        rig.control.activate();
        await rig.control.reconcile();
        rig.control.broadcast({ type: 'viewerCount', count: 3 });
        assert.deepStrictEqual(rig.servers[0]!.broadcasts, [{ type: 'viewerCount', count: 3 }]);

        await rig.control.toggle();
        rig.control.broadcast({ type: 'viewerCount', count: 9 });
        assert.strictEqual(rig.servers[0]!.broadcasts.length, 1, 'a stopped server must not receive events');
    });

    test('dispose tears down the server, the tunnel, the listener and the status bar', async () => {
        const rig = createRig({ settings: { enabled: true, tunnel: 'cloudflared' } });
        rig.control.activate();
        await rig.control.reconcile();
        rig.control.dispose();

        assert.strictEqual(rig.servers[0]!.disposals, 1);
        assert.strictEqual(rig.tunnels[0]!.disposals, 1);
        assert.strictEqual(rig.status.disposed, true);
        assert.strictEqual(rig.commandHandlers.size, 0, 'every command must be unregistered');

        // A late configuration change must not resurrect anything.
        rig.fireConfigChange();
        await rig.control.reconcile();
        assert.strictEqual(rig.servers.length, 1);
    });

    test('registers the five public commands', () => {
        const rig = createRig();
        rig.control.activate();
        for (const id of [
            'adoCode.remote.toggle',
            'adoCode.remote.showQr',
            'adoCode.remote.copyUrl',
            'adoCode.remote.rotateToken',
            'adoCode.remote.tunnel.start',
        ]) {
            assert.ok(rig.commandHandlers.has(id), `missing command ${id}`);
        }
    });
});

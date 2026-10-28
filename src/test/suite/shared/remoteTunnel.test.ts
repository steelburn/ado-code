import * as assert from 'assert';
import { EventEmitter } from 'events';

import {
    RemoteTunnel,
    buildTunnelCommand,
    splitCommandTemplate,
    type TunnelChild,
} from '../../../remote/RemoteTunnel';

/** Fake child process: tests push stdout/stderr chunks into it. */
class FakeChild extends EventEmitter implements TunnelChild {
    pid = 4242;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed: NodeJS.Signals[] = [];

    kill(signal?: NodeJS.Signals): boolean {
        this.killed.push(signal ?? 'SIGTERM');
        return true;
    }

    emitData(chunk: string): void {
        this.stderr.emit('data', Buffer.from(chunk));
    }

    emitStdout(chunk: string): void {
        this.stdout.emit('data', Buffer.from(chunk));
    }
}

suite('remote/RemoteTunnel', () => {
    test('cloudflared argv targets the console port without autoupdate', () => {
        const command = buildTunnelCommand('cloudflared', 41234);
        assert.deepStrictEqual(command, {
            bin: 'cloudflared',
            args: ['tunnel', '--url', 'http://127.0.0.1:41234', '--no-autoupdate'],
        });
        assert.strictEqual(buildTunnelCommand('none', 41234), null);
    });

    test('custom templates substitute {port} and honour quoting', () => {
        assert.deepStrictEqual(splitCommandTemplate('ngrok http {port} '), ['ngrok', 'http', '{port}']);
        assert.deepStrictEqual(splitCommandTemplate('ssh -R "0:localhost:{port}" serveo.net'), [
            'ssh',
            '-R',
            '0:localhost:{port}',
            'serveo.net',
        ]);
        assert.deepStrictEqual(buildTunnelCommand('custom', 5000, 'ngrok http {port}'), {
            bin: 'ngrok',
            args: ['http', '5000'],
        });
        assert.strictEqual(buildTunnelCommand('custom', 5000, '   '), null);
    });

    test('scrapes a cloudflared URL off stderr exactly once', () => {
        const urls: string[] = [];
        const child = new FakeChild();
        const tunnel = new RemoteTunnel({
            provider: 'cloudflared',
            port: 41234,
            spawnFn: () => child,
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            onUrl: (url) => urls.push(url),
        });

        assert.ok(tunnel.start());
        child.emitData('INF Requesting new quick Tunnel on trycloudflare.com...\n');
        child.emitData('INF |  https://tidy-otter-glances.trycloudflare.com  |\n');
        child.emitData('INF |  https://second-should-be-ignored.trycloudflare.com  |\n');

        assert.deepStrictEqual(urls, ['https://tidy-otter-glances.trycloudflare.com']);
        assert.strictEqual(tunnel.url, 'https://tidy-otter-glances.trycloudflare.com');
    });

    test('non-URL lines are ignored and stdout is scraped too', () => {
        const urls: string[] = [];
        const child = new FakeChild();
        const tunnel = new RemoteTunnel({
            provider: 'cloudflared',
            port: 41234,
            spawnFn: () => child,
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            onUrl: (url) => urls.push(url),
        });
        tunnel.start();
        child.emitData('INF Registered tunnel connection connIndex=0\n');
        assert.deepStrictEqual(urls, []);
        child.emitStdout('your url is https://brave-lamp-waves.trycloudflare.com\n');
        assert.deepStrictEqual(urls, ['https://brave-lamp-waves.trycloudflare.com']);
    });

    test('a custom urlPattern is honoured and a bad one falls back', () => {
        const urls: string[] = [];
        const child = new FakeChild();
        const tunnel = new RemoteTunnel({
            provider: 'custom',
            port: 5000,
            customCommand: 'my-tunnel {port}',
            urlPattern: 'https://[a-z.]*example\\.dev',
            spawnFn: () => child,
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            onUrl: (url) => urls.push(url),
        });
        tunnel.start();
        child.emitData('noise https://ignored.test/path noise\n');
        child.emitData('open https://abc.example.dev now\n');
        assert.deepStrictEqual(urls, ['https://abc.example.dev']);

        const fallbackUrls: string[] = [];
        const child2 = new FakeChild();
        const fallback = new RemoteTunnel({
            provider: 'custom',
            port: 5000,
            customCommand: 'my-tunnel {port}',
            urlPattern: '([unclosed',
            spawnFn: () => child2,
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            onUrl: (url) => fallbackUrls.push(url),
        });
        fallback.start();
        child2.emitData('open http://127.0.0.1:5000/ now\n');
        assert.deepStrictEqual(fallbackUrls, ['http://127.0.0.1:5000/']);
    });

    test('a missing binary reports an actionable error and does not throw', () => {
        const errors: string[] = [];
        const child = new FakeChild();
        const tunnel = new RemoteTunnel({
            provider: 'cloudflared',
            port: 41234,
            spawnFn: () => child,
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            onError: (message) => errors.push(message),
        });
        tunnel.start();
        const enoent = new Error('spawn cloudflared ENOENT') as Error & { code?: string };
        enoent.code = 'ENOENT';
        child.emit('error', enoent);

        assert.strictEqual(errors.length, 1);
        assert.match(errors[0]!, /cloudflared/);
        assert.match(errors[0]!, /install it/);
        assert.strictEqual(tunnel.running, false);
    });

    test('spawn throwing synchronously is reported, not raised', () => {
        const errors: string[] = [];
        const tunnel = new RemoteTunnel({
            provider: 'cloudflared',
            port: 41234,
            spawnFn: () => {
                throw new Error('EACCES');
            },
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            onError: (message) => errors.push(message),
        });
        const started = tunnel.start();
        assert.strictEqual(started, null);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0]!, /EACCES/);
    });

    test('an empty custom command reports one error instead of spawning', () => {
        const errors: string[] = [];
        let spawned = false;
        const tunnel = new RemoteTunnel({
            provider: 'custom',
            port: 41234,
            spawnFn: () => {
                spawned = true;
                return new FakeChild();
            },
            onError: (message) => errors.push(message),
        });
        assert.strictEqual(tunnel.start(), null);
        assert.strictEqual(spawned, false);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0]!, /tunnelCommand is empty/);
    });

    test('start is not re-entrant and does not spawn twice', () => {
        let spawns = 0;
        const tunnel = new RemoteTunnel({
            provider: 'cloudflared',
            port: 41234,
            spawnFn: () => {
                spawns++;
                return new FakeChild();
            },
            resolveSpawnFn: (bin, args) => ({ bin, args }),
        });
        tunnel.start();
        tunnel.start();
        assert.strictEqual(spawns, 1);
    });

    test('dispose kills the process tree once and is idempotent', () => {
        const child = new FakeChild();
        const killed: Array<number | undefined> = [];
        const tunnel = new RemoteTunnel({
            provider: 'cloudflared',
            port: 41234,
            spawnFn: () => child,
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            killTreeFn: (pid) => {
                killed.push(pid);
            },
        });
        tunnel.start();
        tunnel.dispose();
        tunnel.dispose();
        assert.deepStrictEqual(killed, [4242]);
        assert.strictEqual(tunnel.running, false);
        assert.strictEqual(tunnel.start(), null, 'a disposed tunnel must not restart');
    });

    test('exit clears the running flag and reports the code', () => {
        const exits: Array<number | null> = [];
        const child = new FakeChild();
        const tunnel = new RemoteTunnel({
            provider: 'cloudflared',
            port: 41234,
            spawnFn: () => child,
            resolveSpawnFn: (bin, args) => ({ bin, args }),
            onExit: (code) => exits.push(code),
        });
        tunnel.start();
        child.emit('exit', 1);
        assert.deepStrictEqual(exits, [1]);
        assert.strictEqual(tunnel.running, false);
        // A restart after an unexpected exit is allowed.
        assert.ok(tunnel.start());
    });
});

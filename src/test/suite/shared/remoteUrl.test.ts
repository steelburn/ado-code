import * as assert from 'assert';

import {
    getPortFromExternalUrl,
    resolveRemoteUrl,
    type RemoteUrlDeps,
} from '../../../remote/remoteUrl';

const TOKEN = 'tok3n-tok3n-tok3n';
const deps = (overrides: Partial<RemoteUrlDeps> = {}): RemoteUrlDeps => ({
    uiKind: 1, // Desktop
    asExternalUri: async (url) => url, // desktop default: unchanged
    bind: 'loopback',
    ...overrides,
});

// Classification decides whether the QR code is scannable at all, so every
// branch is pinned here: a wrong kind ships a dead QR to a phone.
suite('remote/remoteUrl', () => {
    test('plain desktop is local-only, loopback URL, no public host', async () => {
        const resolved = await resolveRemoteUrl(41234, TOKEN, deps());
        assert.strictEqual(resolved.kind, 'local');
        assert.strictEqual(resolved.url, `http://127.0.0.1:41234/#t=${TOKEN}`);
        assert.strictEqual(resolved.loopbackUrl, 'http://127.0.0.1:41234/');
        assert.match(resolved.message, /Local only/);
    });

    test('a forwarded non-loopback host is external', async () => {
        const resolved = await resolveRemoteUrl(
            41234,
            TOKEN,
            deps({
                asExternalUri: async () => 'https://big-space-yonder-8080.github.dev/',
                remoteName: 'codespaces',
            })
        );
        assert.strictEqual(resolved.kind, 'external');
        assert.strictEqual(resolved.url, `https://big-space-yonder-8080.github.dev/#t=${TOKEN}`);
        assert.match(resolved.message, /forwarded/);
    });

    test('a forwarded loopback host stays local-only', async () => {
        const resolved = await resolveRemoteUrl(
            41234,
            TOKEN,
            deps({ asExternalUri: async (url) => url.replace('127.0.0.1', 'localhost') })
        );
        assert.strictEqual(resolved.kind, 'local');
        // A loopback forward adds nothing, so the canonical loopback URL is used.
        assert.strictEqual(resolved.url, `http://127.0.0.1:41234/#t=${TOKEN}`);
    });

    test('a running tunnel wins over local-only forwarding', async () => {
        const resolved = await resolveRemoteUrl(
            41234,
            TOKEN,
            deps({ tunnelUrl: 'https://tidy-otter-glances.trycloudflare.com' })
        );
        assert.strictEqual(resolved.kind, 'tunnel');
        assert.strictEqual(resolved.url, `https://tidy-otter-glances.trycloudflare.com/#t=${TOKEN}`);
        assert.match(resolved.message, /tunnel/);
    });

    test('an external forward outranks a tunnel (the forward is not ours to replace)', async () => {
        const resolved = await resolveRemoteUrl(
            41234,
            TOKEN,
            deps({
                asExternalUri: async () => 'https://forwarded.example.com/',
                tunnelUrl: 'https://tidy-otter-glances.trycloudflare.com',
            })
        );
        assert.strictEqual(resolved.kind, 'external');
        assert.strictEqual(resolved.url, `https://forwarded.example.com/#t=${TOKEN}`);
    });

    test('VS Code Web is unavailable and explains why', async () => {
        const resolved = await resolveRemoteUrl(41234, TOKEN, deps({ uiKind: 2 }));
        assert.strictEqual(resolved.kind, 'unavailable');
        assert.strictEqual(resolved.url, null);
        assert.match(resolved.message, /Desktop/);
    });

    test('a rejecting asExternalUri degrades to local instead of throwing', async () => {
        const resolved = await resolveRemoteUrl(
            41234,
            TOKEN,
            deps({
                asExternalUri: async () => {
                    throw new Error('no tunnel available');
                },
            })
        );
        assert.strictEqual(resolved.kind, 'local');
        assert.ok(resolved.url);
    });

    test('bind=all advertises the LAN address', async () => {
        const resolved = await resolveRemoteUrl(41234, TOKEN, deps({ bind: 'all', lanAddress: '192.168.1.7' }));
        assert.strictEqual(resolved.kind, 'local');
        assert.strictEqual(resolved.url, `http://192.168.1.7:41234/#t=${TOKEN}`);
        assert.match(resolved.message, /192\.168\.1\.7/);
    });

    test('bind=all without a LAN address falls back to loopback', async () => {
        const resolved = await resolveRemoteUrl(41234, TOKEN, deps({ bind: 'all' }));
        assert.strictEqual(resolved.kind, 'local');
        assert.match(resolved.url!, /127\.0\.0\.1/);
    });

    test('remoteName never changes the kind — it is messaging only', async () => {
        const resolved = await resolveRemoteUrl(41234, TOKEN, deps({ remoteName: 'wsl' }));
        assert.strictEqual(resolved.kind, 'local');
        assert.match(resolved.message, /wsl/);
    });

    test('the port is recovered from a forwarded URL for the tunnel command', () => {
        assert.strictEqual(getPortFromExternalUrl('https://foo-41234.github.dev/'), 41234);
        assert.strictEqual(getPortFromExternalUrl('http://127.0.0.1:51234/'), 51234);
        assert.strictEqual(getPortFromExternalUrl('https://example.com/'), null);
        assert.strictEqual(getPortFromExternalUrl('not a url'), null);
    });
});

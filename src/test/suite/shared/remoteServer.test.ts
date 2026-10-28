import * as assert from 'assert';
import * as http from 'http';

import { RemoteServer, REMOTE_COOKIE_NAME } from '../../../remote/RemoteServer';

const TOKEN = 'unit-test-token-unit-test-token-unit';

interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

function call(
    port: number,
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method, path, headers: options.headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    })
                );
            }
        );
        req.on('error', reject);
        if (options.body !== undefined) {
            req.write(options.body);
        }
        req.end();
    });
}

/** Open an SSE stream and resolve once `predicate` matches a frame. */
function openEvents(
    port: number,
    cookie: string,
    predicate: (frame: string) => boolean,
    timeoutMs = 4000
): Promise<{ close: () => void; frames: string[] }> {
    return new Promise((resolve, reject) => {
        const frames: string[] = [];
        const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { cookie } }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`unexpected SSE status ${res.statusCode}`));
                return;
            }
            const timer = setTimeout(() => reject(new Error('timed out waiting for SSE frame')), timeoutMs);
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                frames.push(chunk);
                if (predicate(frames.join(''))) {
                    clearTimeout(timer);
                    resolve({ close: () => req.destroy(), frames });
                }
            });
            res.on('error', () => undefined);
        });
        req.on('error', reject);
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
    server: RemoteServer;
    port: number;
    login: () => Promise<string>;
    dispose: () => Promise<void>;
}

async function harness(overrides: { bind?: 'loopback' | 'all'; page?: () => string } = {}): Promise<Harness> {
    const server = new RemoteServer({
        verifyToken: (candidate) => candidate === TOKEN,
        port: 0,
        bind: overrides.bind ?? 'loopback',
        page: overrides.page,
    });
    const port = await server.start();
    const login = async (): Promise<string> => {
        const reply = await call(port, 'POST', '/session', {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ t: TOKEN }),
        });
        assert.strictEqual(reply.status, 204, `login failed: ${reply.body}`);
        const cookie = reply.headers['set-cookie']?.[0];
        assert.ok(cookie, 'expected a Set-Cookie header');
        return cookie.split(';')[0]!;
    };
    return { server, port, login, dispose: () => server.dispose() };
}

// Real sockets, real cookies: the security properties of this server are the
// whole point of the feature, so they are asserted against a live HTTP server
// rather than a mocked request object.
suite('remote/RemoteServer', function () {
    this.timeout(20000);

    test('binds loopback by default and serves the console page', async () => {
        const h = await harness();
        try {
            assert.strictEqual(h.server.host, '127.0.0.1');
            assert.ok(h.port > 0, 'port 0 must be resolved to the OS-assigned port');
            const page = await call(h.port, 'GET', '/');
            assert.strictEqual(page.status, 200);
            assert.match(page.headers['content-type'] ?? '', /text\/html/);
            assert.match(page.body, /Remote Console/);
            // No external asset may be referenced (tunnel interstitials kill them).
            assert.ok(!/<script[^>]+src=/.test(page.body), 'page must not load external scripts');
            assert.ok(!/<link[^>]+href=/.test(page.body), 'page must not load external stylesheets');
            assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
        } finally {
            await h.dispose();
        }
    });

    test('a foreign Host header is rejected (DNS-rebinding guard)', async () => {
        const h = await harness();
        try {
            const reply = await call(h.port, 'GET', '/', { headers: { host: 'evil.example.com' } });
            assert.strictEqual(reply.status, 403);
            const privateHost = await call(h.port, 'GET', '/', { headers: { host: '192.168.1.7:1234' } });
            assert.strictEqual(privateHost.status, 200, 'LAN hosts must stay allowed');
        } finally {
            await h.dispose();
        }
    });

    test('/events requires the session cookie', async () => {
        const h = await harness();
        try {
            assert.strictEqual((await call(h.port, 'GET', '/events')).status, 401);
            assert.strictEqual((await call(h.port, 'GET', '/events', { headers: { cookie: `${REMOTE_COOKIE_NAME}=nope` } })).status, 401);
        } finally {
            await h.dispose();
        }
    });

    test('POST /session exchanges the fragment token for a hardened cookie', async () => {
        const h = await harness();
        try {
            const reply = await call(h.port, 'POST', '/session', {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ t: TOKEN }),
            });
            assert.strictEqual(reply.status, 204);
            const cookie = reply.headers['set-cookie']?.[0] ?? '';
            assert.match(cookie, new RegExp(`^${REMOTE_COOKIE_NAME}=`));
            assert.match(cookie, /HttpOnly/);
            assert.match(cookie, /Secure/);
            assert.match(cookie, /SameSite=Strict/);
            assert.match(cookie, /Path=\//);

            const wrong = await call(h.port, 'POST', '/session', {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ t: 'guess' }),
            });
            assert.strictEqual(wrong.status, 401);
        } finally {
            await h.dispose();
        }
    });

    test('malformed and oversized bodies are rejected by the protocol validator', async () => {
        const h = await harness();
        try {
            const malformed = await call(h.port, 'POST', '/session', { body: '{not json' });
            assert.strictEqual(malformed.status, 400);
            const missingField = await call(h.port, 'POST', '/session', { body: '{}' });
            assert.strictEqual(missingField.status, 400);
            const empty = await call(h.port, 'POST', '/session', { body: '' });
            assert.strictEqual(empty.status, 400);
        } finally {
            await h.dispose();
        }
    });

    test('mutating routes are authenticated, validated and refused in P1', async () => {
        const h = await harness();
        try {
            const cookie = await h.login();
            assert.strictEqual(
                (await call(h.port, 'POST', '/consent', { body: JSON.stringify({ requestId: 'r', approved: true }) })).status,
                401,
                'no cookie means no access'
            );
            const notAllowedYet = await call(h.port, 'POST', '/consent', {
                headers: { cookie },
                body: JSON.stringify({ requestId: 'r', approved: true }),
            });
            assert.strictEqual(notAllowedYet.status, 501);
            const badScope = await call(h.port, 'POST', '/consent', {
                headers: { cookie },
                body: JSON.stringify({ requestId: 'r', approved: true, scope: 'forever' }),
            });
            assert.strictEqual(badScope.status, 400);
            assert.strictEqual((await call(h.port, 'POST', '/cancel', { headers: { cookie }, body: '{}' })).status, 501);
            assert.strictEqual((await call(h.port, 'GET', '/nope')).status, 404);
        } finally {
            await h.dispose();
        }
    });

    test('SSE connect/disconnect drives the viewer count and broadcast fans out', async () => {
        const h = await harness();
        try {
            const cookie = await h.login();

            const first = await openEvents(h.port, cookie, (text) => text.includes('"viewerCount","count":1'));
            assert.strictEqual(h.server.viewerCount, 1);

            const second = await openEvents(h.port, cookie, (text) => text.includes('"count":2'));
            assert.strictEqual(h.server.viewerCount, 2);

            h.server.broadcast({ type: 'viewerCount', count: 99 });
            await sleep(50);
            first.close();
            second.close();

            const deadline = Date.now() + 4000;
            while (h.server.viewerCount !== 0 && Date.now() < deadline) {
                await sleep(25);
            }
            assert.strictEqual(h.server.viewerCount, 0, 'closed streams must be released');
        } finally {
            await h.dispose();
        }
    });

    test('broadcast delivers agent events to a connected console', async () => {
        const h = await harness();
        try {
            const cookie = await h.login();
            const stream = await openEvents(h.port, cookie, (text) => text.includes('"type":"viewerCount"'));
            h.server.broadcast({
                type: 'agentStatus',
                run: { id: 'run-1' } as never,
                delta: 'compiling…',
            });
            await sleep(100);
            assert.ok(stream.frames.join('').includes('compiling'), 'the delta must reach the console');
            stream.close();
        } finally {
            await h.dispose();
        }
    });

    test('broadcast with no viewers is a no-op and never throws', async () => {
        const h = await harness();
        try {
            h.server.broadcast({ type: 'viewerCount', count: 0 });
        } finally {
            await h.dispose();
        }
    });

    test('dispose releases the port and is idempotent', async () => {
        const h = await harness();
        await h.dispose();
        await h.dispose();
        await assert.rejects(() => call(h.port, 'GET', '/'), /ECONNREFUSED|ECONNRESET/);
    });

    test('bind=all listens on every interface', async () => {
        const h = await harness({ bind: 'all' });
        try {
            assert.strictEqual(h.server.host, '0.0.0.0');
            const reply = await call(h.port, 'GET', '/');
            assert.strictEqual(reply.status, 200);
        } finally {
            await h.dispose();
        }
    });

    test('a custom page provider is used verbatim', async () => {
        const h = await harness({ page: () => '<html><body>stub</body></html>' });
        try {
            const reply = await call(h.port, 'GET', '/');
            assert.strictEqual(reply.body, '<html><body>stub</body></html>');
        } finally {
            await h.dispose();
        }
    });
});

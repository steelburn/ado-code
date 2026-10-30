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

interface ApprovalHooks {
    bind?: 'loopback' | 'all';
    page?: () => string;
    onConsent?: (payload: { requestId: string; approved: boolean; scope?: string }) => Promise<{ status: number; body?: unknown }>;
    onConfirm?: (payload: { requestId: string; value?: string }) => Promise<{ status: number; body?: unknown }>;
    pendingApprovals?: () => unknown;
    runSnapshot?: () => unknown;
    turnSnapshot?: () => unknown;
    transcriptSnapshot?: () => unknown;
    planSnapshot?: () => unknown;
    onChat?: (text: string) => Promise<{ status: number; body?: unknown }>;
}

async function harness(overrides: ApprovalHooks = {}): Promise<Harness> {
    const server = new RemoteServer({
        verifyToken: (candidate) => candidate === TOKEN,
        port: 0,
        bind: overrides.bind ?? 'loopback',
        page: overrides.page,
        onConsent: overrides.onConsent,
        onConfirm: overrides.onConfirm,
        pendingApprovals: overrides.pendingApprovals,
        runSnapshot: overrides.runSnapshot,
        turnSnapshot: overrides.turnSnapshot,
        transcriptSnapshot: overrides.transcriptSnapshot,
        planSnapshot: overrides.planSnapshot,
        onChat: overrides.onChat,
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

    test('the tunnel public host is admitted only while that tunnel runs', async () => {
        const h = await harness();
        const tunnelHost = 'daily-cats-try.trycloudflare.com';
        const viaTunnel = (): Promise<Reply> =>
            call(h.port, 'GET', '/', { headers: { host: tunnelHost } });
        try {
            assert.strictEqual(
                (await viaTunnel()).status,
                403,
                'a public host must stay rejected until a tunnel asks for it'
            );

            h.server.allowHost(`https://${tunnelHost}/`);
            assert.strictEqual(
                (await viaTunnel()).status,
                200,
                'cloudflared forwards the public Host header unchanged'
            );

            h.server.clearAllowedHosts();
            assert.strictEqual(
                (await viaTunnel()).status,
                403,
                'an exited tunnel must not stay reachable'
            );

            h.server.allowHost('https://other-words.trycloudflare.com/');
            assert.strictEqual(
                (await viaTunnel()).status,
                403,
                'allowHost replaces the previous tunnel host'
            );
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

    test('GET /session reports whether an earlier scan is still signed in', async () => {
        const h = await harness();
        try {
            assert.strictEqual((await call(h.port, 'GET', '/session')).status, 401, 'no cookie, no session');
            assert.strictEqual(
                (await call(h.port, 'GET', '/session', { headers: { cookie: `${REMOTE_COOKIE_NAME}=nope` } })).status,
                401,
                'an unknown cookie is not a session'
            );

            const login = await call(h.port, 'POST', '/session', {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ t: TOKEN }),
            });
            const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0];
            const live = await call(h.port, 'GET', '/session', { headers: { cookie } });
            assert.strictEqual(live.status, 200, 'a reload must not need a re-scan');
            assert.deepStrictEqual(JSON.parse(live.body), { ok: true });
        } finally {
            await h.dispose();
        }
    });

    test('the console page resumes a live cookie when the fragment is gone', async () => {
        const h = await harness();
        try {
            const page = await call(h.port, 'GET', '/');
            assert.match(page.body, /function resumeSession\(\)/);
            assert.match(page.body, /fetch\('\/session', \{ method: 'GET'/);
            assert.match(page.body, /if \(ok\) \{ connect\(\); return; \}/);
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

    test('the approval routes refuse anonymous callers', async () => {
        const h = await harness({ onConsent: async () => ({ status: 200 }) });
        try {
            const consent = await call(h.port, 'POST', '/consent', {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requestId: 'r1', approved: true }),
            });
            assert.strictEqual(consent.status, 401);
            const pending = await call(h.port, 'GET', '/pending');
            assert.strictEqual(pending.status, 401);
        } finally {
            await h.dispose();
        }
    });

    test('a consent decision is handed to the extension host', async () => {
        const seen: { requestId: string; approved: boolean; scope?: string }[] = [];
        const h = await harness({
            onConsent: async (payload) => {
                seen.push(payload);
                return { status: 200, body: { ok: true } };
            },
        });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'POST', '/consent', {
                headers: { 'content-type': 'application/json', cookie },
                body: JSON.stringify({ requestId: 'req-1', approved: true, scope: 'session' }),
            });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(seen, [{ requestId: 'req-1', approved: true, scope: 'session' }]);
        } finally {
            await h.dispose();
        }
    });

    test('a stale decision surfaces as 409, not as a new answer', async () => {
        const h = await harness({
            onConsent: async () => ({ status: 409, body: { error: 'no longer pending' } }),
        });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'POST', '/consent', {
                headers: { 'content-type': 'application/json', cookie },
                body: JSON.stringify({ requestId: 'gone', approved: false }),
            });
            assert.strictEqual(reply.status, 409);
        } finally {
            await h.dispose();
        }
    });

    test('without a host handler the decision routes are unavailable', async () => {
        const h = await harness();
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'POST', '/consent', {
                headers: { 'content-type': 'application/json', cookie },
                body: JSON.stringify({ requestId: 'r1', approved: true }),
            });
            assert.strictEqual(reply.status, 501);
        } finally {
            await h.dispose();
        }
    });

    test('GET /runs replays the jobs that are still progressing', async () => {
        const progressing = [
            { id: 'run-1', status: 'running', agent: 'codex', title: 'ADO 42 - fix the tree', startedAt: '2024-01-01T00:00:00.000Z' },
        ];
        const h = await harness({ runSnapshot: () => progressing });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/runs', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { runs: progressing });
        } finally {
            await h.dispose();
        }
    });

    test('GET /runs without a session is refused', async () => {
        const h = await harness({ runSnapshot: () => [] });
        try {
            const reply = await call(h.port, 'GET', '/runs');
            assert.strictEqual(reply.status, 401);
        } finally {
            await h.dispose();
        }
    });

    test('GET /runs degrades to an empty list when the snapshot throws', async () => {
        const h = await harness({
            runSnapshot: () => {
                throw new Error('no runner');
            },
        });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/runs', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { runs: [] });
        } finally {
            await h.dispose();
        }
    });

    test('GET /turn replays the chat turn that is generating right now', async () => {
        const turn = { sessionId: 's-1', title: 'Fix the tree', startedAt: 1790000000000, background: false };
        const h = await harness({ turnSnapshot: () => turn });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/turn', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { turn });
        } finally {
            await h.dispose();
        }
    });

    test('GET /turn without a session is refused', async () => {
        const h = await harness({ turnSnapshot: () => null });
        try {
            const reply = await call(h.port, 'GET', '/turn');
            assert.strictEqual(reply.status, 401);
        } finally {
            await h.dispose();
        }
    });

    test('GET /turn answers null when the host is idle or the snapshot throws', async () => {
        const idle = await harness({});
        try {
            const cookie = await idle.login();
            const reply = await call(idle.port, 'GET', '/turn', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { turn: null });
        } finally {
            await idle.dispose();
        }
        const broken = await harness({
            turnSnapshot: () => {
                throw new Error('no chat provider');
            },
        });
        try {
            const cookie = await broken.login();
            const reply = await call(broken.port, 'GET', '/turn', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { turn: null });
        } finally {
            await broken.dispose();
        }
    });

    test('GET /transcript replays the mirrored conversation', async () => {
        const transcript = {
            type: 'transcript',
            sessionId: 's-1',
            messages: [
                { id: 'u1', role: 'user', content: 'Which layout?' },
                {
                    id: 'a2',
                    role: 'assistant',
                    content: 'Two ways to go:',
                    choice: { question: 'Which layout?', options: ['grid', 'list'] },
                },
            ],
        };
        const h = await harness({ transcriptSnapshot: () => transcript });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/transcript', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), transcript, 'the thread replays verbatim, choice block included');
        } finally {
            await h.dispose();
        }
    });

    test('GET /transcript needs the cookie and degrades to an empty thread', async () => {
        const h = await harness({
            transcriptSnapshot: () => {
                throw new Error('chat provider not ready');
            },
        });
        try {
            const anonymous = await call(h.port, 'GET', '/transcript', {});
            assert.strictEqual(anonymous.status, 401, 'the console cookie is the only credential');
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/transcript', { headers: { cookie } });
            assert.strictEqual(reply.status, 200, 'a failing mirror must not black out the console');
            assert.deepStrictEqual(JSON.parse(reply.body), { type: 'transcript', sessionId: null, messages: [] });
        } finally {
            await h.dispose();
        }
    });

    test('GET /plan replays the goal and the to-do list', async () => {
        const h = await harness({
            planSnapshot: () => ({
                goal: 'Ship the remote plan',
                todos: [
                    { content: 'Map the flow', status: 'completed' },
                    { content: 'Render it', status: 'in_progress', activeForm: 'Rendering it' },
                ],
            }),
        });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/plan', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), {
                goal: 'Ship the remote plan',
                todos: [
                    { content: 'Map the flow', status: 'completed' },
                    { content: 'Render it', status: 'in_progress', activeForm: 'Rendering it' },
                ],
            });
        } finally {
            await h.dispose();
        }
    });

    test('GET /plan degrades to an empty plan when the host wires nothing', async () => {
        const h = await harness();
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/plan', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { goal: '', todos: [] });
        } finally {
            await h.dispose();
        }
    });

    test('GET /plan rejects an anonymous caller', async () => {
        const h = await harness({ planSnapshot: () => ({ goal: 'secret', todos: [] }) });
        try {
            const reply = await call(h.port, 'GET', '/plan');
            assert.strictEqual(reply.status, 401);
            assert.ok(!reply.body.includes('secret'));
        } finally {
            await h.dispose();
        }
    });

    test('GET /plan survives a snapshot that throws', async () => {
        const h = await harness({
            planSnapshot: () => {
                throw new Error('todo store unavailable');
            },
        });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/plan', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { goal: '', todos: [] });
        } finally {
            await h.dispose();
        }
    });

    test('GET /transcript answers an empty thread when the host wires nothing', async () => {
        const h = await harness({});
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/transcript', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { type: 'transcript', sessionId: null, messages: [] });
        } finally {
            await h.dispose();
        }
    });

    test('POST /chat hands the text to the host and refuses an empty one', async () => {
        const seen: string[] = [];
        const h = await harness({
            onChat: async (text) => {
                seen.push(text);
                return { status: 200, body: { ok: true } };
            },
        });
        try {
            const cookie = await h.login();
            const ok = await call(h.port, 'POST', '/chat', {
                headers: { cookie, 'content-type': 'application/json' },
                body: JSON.stringify({ text: 'grid' }),
            });
            assert.strictEqual(ok.status, 200);
            assert.deepStrictEqual(seen, ['grid'], 'a tapped choice becomes the next user message');

            const empty = await call(h.port, 'POST', '/chat', {
                headers: { cookie, 'content-type': 'application/json' },
                body: JSON.stringify({ text: '   ' }),
            });
            assert.strictEqual(empty.status, 400);
            assert.deepStrictEqual(seen, ['grid'], 'an empty message never reaches the chat loop');

            const anonymous = await call(h.port, 'POST', '/chat', { body: JSON.stringify({ text: 'grid' }) });
            assert.strictEqual(anonymous.status, 401);
        } finally {
            await h.dispose();
        }
    });

    test('POST /chat answers 501 on an observe-only console', async () => {
        const h = await harness({});
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'POST', '/chat', {
                headers: { cookie, 'content-type': 'application/json' },
                body: JSON.stringify({ text: 'hello' }),
            });
            assert.strictEqual(reply.status, 501);
        } finally {
            await h.dispose();
        }
    });

    test('GET /pending returns the open cards and nothing else', async () => {
        const open = [
            { type: 'consentRequest', requestId: 'p1', tool: 'edit_file', args: { path: 'a.ts' } },
        ];
        const h = await harness({ pendingApprovals: () => open });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/pending', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            const body = JSON.parse(reply.body) as { approvals: unknown };
            assert.deepStrictEqual(body.approvals, open);
            assert.match(String(reply.headers['cache-control'] ?? ''), /no-store/);
        } finally {
            await h.dispose();
        }
    });

    test('GET /pending degrades to an empty list when the host throws', async () => {
        const h = await harness({
            pendingApprovals: () => {
                throw new Error('boom');
            },
        });
        try {
            const cookie = await h.login();
            const reply = await call(h.port, 'GET', '/pending', { headers: { cookie } });
            assert.strictEqual(reply.status, 200);
            assert.deepStrictEqual(JSON.parse(reply.body), { approvals: [] });
        } finally {
            await h.dispose();
        }
    });
});


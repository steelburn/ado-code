import * as assert from 'assert';

import {
    REMOTE_TOKEN_SECRET_KEY,
    RemoteTokenStore,
    generateRemoteToken,
    verifyRemoteToken,
} from '../../../remote/remoteToken';

/** In-memory stand-in for vscode.SecretStorage (same shape, no vscode edge). */
class FakeSecrets {
    readonly map = new Map<string, string>();
    getCalls = 0;
    storeCalls = 0;

    async get(key: string): Promise<string | undefined> {
        this.getCalls++;
        return this.map.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this.storeCalls++;
        this.map.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.map.delete(key);
    }
}

// RemoteAccess on = anyone who can reach the port and knows the token can see
// run output. The token therefore has to be high-entropy, compared in constant
// time, and never derived from something guessable (port, pid, timestamp).
suite('remote/remoteToken', () => {
    test('generateRemoteToken produces high-entropy url-safe tokens', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const token = generateRemoteToken();
            assert.strictEqual(typeof token, 'string');
            assert.ok(token.length >= 32, `token too short: ${token.length}`);
            assert.match(token, /^[A-Za-z0-9_-]+$/, 'token must be url-safe base64url');
            assert.ok(!seen.has(token), 'tokens must never repeat');
            seen.add(token);
        }
    });

    test('verifyRemoteToken accepts only the exact token', () => {
        const token = generateRemoteToken();
        assert.strictEqual(verifyRemoteToken(token, token), true);
        assert.strictEqual(verifyRemoteToken(token, token.toUpperCase()), false);
        assert.strictEqual(verifyRemoteToken(token, token + 'x'), false);
        assert.strictEqual(verifyRemoteToken(token, token.slice(0, -1)), false);
        // Different-length candidates must be rejected without throwing.
        assert.strictEqual(verifyRemoteToken(token, ''), false);
        assert.strictEqual(verifyRemoteToken(token, 'x'.repeat(200)), false);
        assert.strictEqual(verifyRemoteToken('', ''), false);
    });

    test('store creates the secret once and reuses it', async () => {
        const secrets = new FakeSecrets();
        const store = new RemoteTokenStore(secrets);

        const first = await store.ensure();
        const second = await store.ensure();

        assert.strictEqual(first, second, 'ensure() must be idempotent');
        assert.strictEqual(secrets.storeCalls, 1, 'a second ensure() must not rewrite the secret');
        assert.strictEqual(secrets.map.get(REMOTE_TOKEN_SECRET_KEY), first);
    });

    test('store rotates to a fresh value and verifies against the new one', async () => {
        const secrets = new FakeSecrets();
        const store = new RemoteTokenStore(secrets);

        const before = await store.ensure();
        const after = await store.rotate();

        assert.notStrictEqual(before, after);
        assert.strictEqual(secrets.map.get(REMOTE_TOKEN_SECRET_KEY), after);
        assert.strictEqual(await store.verify(before), false, 'the old token must stop working');
        assert.strictEqual(await store.verify(after), true);
    });

    test('store honours an existing secret from an earlier session', async () => {
        const secrets = new FakeSecrets();
        secrets.map.set(REMOTE_TOKEN_SECRET_KEY, 'existing-token-value-existing-token-value');
        const store = new RemoteTokenStore(secrets);

        assert.strictEqual(await store.ensure(), 'existing-token-value-existing-token-value');
        assert.strictEqual(secrets.storeCalls, 0);
    });

    test('store refreshes a too-short legacy secret', async () => {
        const secrets = new FakeSecrets();
        secrets.map.set(REMOTE_TOKEN_SECRET_KEY, 'short');
        const store = new RemoteTokenStore(secrets);

        const token = await store.ensure();
        assert.notStrictEqual(token, 'short');
        assert.ok(token.length >= 32);
    });

    test('verify fails closed when SecretStorage throws', async () => {
        const store = new RemoteTokenStore({
            get: async () => {
                throw new Error('keyring locked');
            },
            store: async () => undefined,
            delete: async () => undefined,
        });
        assert.strictEqual(await store.verify(generateRemoteToken()), false);
    });
});

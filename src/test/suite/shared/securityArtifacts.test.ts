import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  AUTH_PATH,
  DEFAULT_ALG_ALLOWLIST,
  EDGE_SHARED_SECRET_ENV,
  EDGE_SHARED_SECRET_PREVIOUS_ENV,
  IDENTITY_HEADERS,
  PUBLIC_PATHS,
  SECRETS_PATH,
  SECURITY_ENV,
  authSource,
  planSecurityFiles,
  secretsSource,
  securityArchitectureRows,
  securityConfigEnv,
  securityConfigKeys,
  securityEnvLines,
  securitySecretKeys,
  sharedSecurityBarrelLines,
} from '../../../shared/securityArtifacts';

/**
 * CON-05 is a security claim, so the tests execute the *generated* module rather
 * than matching strings: a real RSA keypair signs a real token, and the module
 * decides. The two properties that matter most cannot be checked by inspection —
 * algorithm confusion (an HS256 token whose HMAC key is the public key must NOT
 * verify against an RS256 keyring) and rotation (a token signed by the retired
 * key stops working only when the window closes).
 */

interface AuthModule {
  AuthError: new (code: string, message: string, status?: number) => Error & {
    code: string;
    status: number;
    wwwAuthenticate: string;
  };
  DEFAULT_ALGORITHMS: string[];
  PUBLIC_PATHS: string[];
  IDENTITY_HEADERS: Record<string, string>;
  EDGE_SHARED_SECRET_ENV: string;
  EDGE_STAMP_HEADER: string;
  EDGE_STAMP_MAX_AGE_SECONDS: number;
  verifyToken(token: string, config: Record<string, unknown>): {
    subject: string;
    scopes: string[];
    issuer: string;
    expiresAt: number;
  };
  bearerToken(headers: Record<string, string | string[] | undefined>): string;
  authenticateRequest(
    headers: Record<string, string | string[] | undefined>,
    config: Record<string, unknown>
  ): { subject: string; scopes: string[] };
  isPublicPath(pathname: string): boolean;
  hasScope(principal: { scopes: readonly string[] }, scope: string): boolean;
  requireScope(principal: { scopes: readonly string[] }, scope: string): void;
  scopesFrom(payload: Record<string, unknown>): string[];
  identityHeaders(principal: Record<string, unknown>): Record<string, string>;
  identityCanonical(principal: Record<string, unknown>): string;
  stampIdentity(principal: Record<string, unknown>, secret: string, at?: number): string;
  stampedIdentityHeaders(
    principal: Record<string, unknown>,
    secret: string | undefined,
    at?: number
  ): Record<string, string>;
  verifyIdentityStamp(
    stamp: string | undefined,
    principal: Record<string, unknown>,
    secrets: readonly string[],
    maxAgeSeconds?: number,
    now?: () => number
  ): void;
  identityFromEdge(
    headers: Record<string, string | string[] | undefined>,
    env: Record<string, string | undefined>,
    now?: () => number
  ): { subject: string; scopes: string[]; issuer: string };
  keyringFromJwks(document: { keys?: Record<string, unknown>[] }): { kid: string; key: unknown }[];
  refreshKeyring(
    config: Record<string, unknown>,
    url: string,
    fetcher: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  ): Promise<Record<string, unknown>>;
  securityConfigFromEnv(env: Record<string, string | undefined>): Record<string, unknown>;
}

interface SecretsModule {
  PLACEHOLDER_MARKERS: string[];
  CREDENTIAL_HEADERS: string[];
  MissingSecretError: new (names: readonly string[]) => Error & { names: readonly string[] };
  looksLikePlaceholder(value: string): boolean;
  requireSecret(env: Record<string, string | undefined>, name: string): string;
  optionalSecret(env: Record<string, string | undefined>, name: string): string | undefined;
  assertBootSecrets(env: Record<string, string | undefined>, names: readonly string[]): void;
  describeSecrets(
    env: Record<string, string | undefined>,
    names: readonly string[]
  ): { name: string; state: string }[];
  redactValue(value: string | undefined): string;
  redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string>;
}

function load<T>(source: string, cache: { value?: T }): T {
  if (cache.value) {
    return cache.value;
  }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function('exports', 'require', 'module', js);
  factory(module.exports, require, module);
  cache.value = module.exports as unknown as T;
  return cache.value;
}

const authCache: { value?: AuthModule } = {};
const secretsCache: { value?: SecretsModule } = {};
const auth = (): AuthModule => load<AuthModule>(authSource(), authCache);
const secrets = (): SecretsModule => load<SecretsModule>(secretsSource(), secretsCache);

/* -------------------------------------------------------------------------- */
/* Token fixtures                                                             */
/* -------------------------------------------------------------------------- */

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);
const ISSUER = 'https://login.example.com/';
const AUDIENCE = 'api://orders';
const CLOCK = (): number => NOW;

const rsaCurrent = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaNext = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecCurrent = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

const pem = (pair: crypto.KeyPairKeyObjectResult): string =>
  String(pair.publicKey.export({ type: 'spki', format: 'pem' }));

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function signRsa(input: string, key: crypto.KeyObject, salt = false): Buffer {
  return crypto.sign(
    'sha256',
    Buffer.from(input, 'utf8'),
    salt
      ? {
          key,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        }
      : key
  );
}

function signEc(input: string, key: crypto.KeyObject): Buffer {
  return crypto.sign('sha256', Buffer.from(input, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
}

function signHmac(input: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(input).digest();
}

interface TokenOptions {
  readonly header: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
  readonly signer: (input: string) => Buffer;
}

function token(options: TokenOptions): string {
  const head = b64({ typ: 'JWT', ...options.header });
  const body = b64({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-1',
    scope: 'orders:read orders:write',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
    ...(options.claims ?? {}),
  });
  const input = head + '.' + body;
  return input + '.' + options.signer(input).toString('base64url');
}

const rsToken = (claims?: Record<string, unknown>, kid = 'k1'): string =>
  token({
    header: { alg: 'RS256', kid },
    claims,
    signer: (input) => signRsa(input, rsaCurrent.privateKey),
  });

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [...DEFAULT_ALG_ALLOWLIST],
    keys: [{ kid: 'k1', key: pem(rsaCurrent) }],
    now: CLOCK,
    ...overrides,
  };
}

function rejection(fn: () => unknown): { code: string; status: number } {
  try {
    fn();
  } catch (error) {
    const failure = error as { code?: string; status?: number };
    return { code: failure.code ?? 'no-code', status: failure.status ?? 0 };
  }
  throw new assert.AssertionError({ message: 'expected a rejection, none was raised' });
}

/* -------------------------------------------------------------------------- */
/* The module itself                                                          */
/* -------------------------------------------------------------------------- */

suite('Application security — generated auth module', () => {
  test('accepts a well-formed RS256 token and returns the caller', () => {
    const principal = auth().verifyToken(rsToken(), baseConfig());
    assert.strictEqual(principal.subject, 'user-1');
    assert.strictEqual(principal.issuer, ISSUER);
    assert.deepStrictEqual([...principal.scopes], ['orders:read', 'orders:write']);
    assert.strictEqual(principal.expiresAt, NOW_SECONDS + 300);
  });

  test('rejects an HS256 token signed with the public key (algorithm confusion)', () => {
    // The classic attack: sign with HMAC, using the *public* key as the shared
    // secret, and hope the verifier picks the algorithm from the token.
    const forged = token({
      header: { alg: 'HS256', kid: 'k1' },
      signer: (input) => signHmac(input, pem(rsaCurrent)),
    });
    assert.deepStrictEqual(rejection(() => auth().verifyToken(forged, baseConfig())), {
      code: 'algorithm_not_allowed',
      status: 401,
    });
  });

  test('rejects an unsecured token (alg: none) even if the allowlist names it', () => {
    const unsecured = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ sub: 'user-1' }) + '.';
    assert.strictEqual(
      rejection(() =>
        auth().verifyToken(unsecured, baseConfig({ algorithms: ['none'] }))
      ).code,
      'algorithm_not_allowed'
    );
  });

  test('verifies ES256 when the allowlist permits it, and refuses it when not', () => {
    const esToken = token({
      header: { alg: 'ES256', kid: 'ec1' },
      signer: (input) => signEc(input, ecCurrent.privateKey),
    });
    const ecKey = { kid: 'ec1', key: pem(ecCurrent) };
    const allowed = auth().verifyToken(
      esToken,
      baseConfig({ algorithms: ['RS256', 'ES256'], keys: [ecKey] })
    );
    assert.strictEqual(allowed.subject, 'user-1');

    const refused = rejection(() =>
      auth().verifyToken(esToken, baseConfig({ algorithms: ['RS256'], keys: [ecKey] }))
    );
    assert.strictEqual(refused.code, 'algorithm_not_allowed');
  });

  test('a token signed by an unknown key is refused', () => {
    const other = token({
      header: { alg: 'RS256', kid: 'k1' },
      signer: (input) => signRsa(input, rsaNext.privateKey),
    });
    assert.strictEqual(rejection(() => auth().verifyToken(other, baseConfig())).code, 'bad_signature');
  });

  test('an asymmetric token without kid is refused', () => {
    const anonymous = token({
      header: { alg: 'RS256' },
      signer: (input) => signRsa(input, rsaCurrent.privateKey),
    });
    assert.strictEqual(rejection(() => auth().verifyToken(anonymous, baseConfig())).code, 'key_not_found');
  });

  test('expiry is enforced, and the clock skew is a real window not a free pass', () => {
    assert.strictEqual(
      rejection(() => auth().verifyToken(rsToken({ exp: NOW_SECONDS - 120 }), baseConfig())).code,
      'token_expired'
    );
    // 10s expired is inside the 30s skew: accepted, so a small clock drift is not an outage.
    assert.strictEqual(
      auth().verifyToken(rsToken({ exp: NOW_SECONDS - 10 }), baseConfig()).subject,
      'user-1'
    );
    // Further out than the skew: refused.
    assert.strictEqual(
      rejection(() =>
        auth().verifyToken(rsToken({ exp: NOW_SECONDS - 31 }), baseConfig({ clockSkewSeconds: 30 }))
      ).code,
      'token_expired'
    );
  });

  test('nbf and iat are enforced', () => {
    assert.strictEqual(
      rejection(() => auth().verifyToken(rsToken({ nbf: NOW_SECONDS + 300 }), baseConfig())).code,
      'token_not_yet_valid'
    );
    assert.strictEqual(
      rejection(() => auth().verifyToken(rsToken({ iat: NOW_SECONDS + 300 }), baseConfig())).code,
      'issued_in_future'
    );
  });

  test('issuer and audience must match this API', () => {
    assert.strictEqual(
      rejection(() => auth().verifyToken(rsToken({ iss: 'https://evil.example/' }), baseConfig())).code,
      'wrong_issuer'
    );
    assert.strictEqual(
      rejection(() => auth().verifyToken(rsToken({ aud: 'api://other' }), baseConfig())).code,
      'wrong_audience'
    );
    // An audience array that contains ours is accepted.
    assert.strictEqual(
      auth().verifyToken(rsToken({ aud: ['api://other', AUDIENCE] }), baseConfig()).subject,
      'user-1'
    );
  });

  test('a token with no exp is refused', () => {
    const noExpiry = token({
      header: { alg: 'RS256', kid: 'k1' },
      claims: { exp: undefined },
      signer: (input) => signRsa(input, rsaCurrent.privateKey),
    });
    assert.strictEqual(rejection(() => auth().verifyToken(noExpiry, baseConfig())).code, 'missing_expiry');
  });
});

/* -------------------------------------------------------------------------- */
/* Rotation — crypto agility                                                  */
/* -------------------------------------------------------------------------- */

suite('Application security — key rotation without a restart', () => {
  test('a new kid from the JWKS verifies only after the keyring refreshes', async () => {
    const rotated = token({
      header: { alg: 'RS256', kid: 'k2' },
      signer: (input) => signRsa(input, rsaNext.privateKey),
    });
    assert.strictEqual(rejection(() => auth().verifyToken(rotated, baseConfig())).code, 'key_not_found');

    const jwk = {
      ...(rsaNext.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
      kid: 'k2',
    };
    const refreshed = await auth().refreshKeyring(baseConfig(), 'https://idp/jwks', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [jwk] }),
    }));
    assert.strictEqual(auth().verifyToken(rotated, refreshed).subject, 'user-1');
  });

  test('a failed JWKS fetch leaves the current keyring untouched', async () => {
    await assert.rejects(
      () =>
        auth().refreshKeyring(baseConfig(), 'https://idp/jwks', async () => ({
          ok: false,
          status: 503,
          json: async () => ({}),
        })),
      (error: { code?: string }) => error.code === 'keyring_unavailable'
    );
  });

  test('an HMAC secret rotation window accepts the previous secret, then closes', () => {
    const signWith = (secret: string): string =>
      token({
        header: { alg: 'HS256' },
        signer: (input) => signHmac(input, secret),
      });
    const rotated = signWith('old-secret-value');
    const hmac = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
      baseConfig({ algorithms: ['HS256'], keys: [], hmacSecret: 'new-secret-value', ...extra });

    assert.strictEqual(
      auth().verifyToken(rotated, hmac({ previousHmacSecret: 'old-secret-value' })).subject,
      'user-1'
    );
    assert.strictEqual(
      rejection(() => auth().verifyToken(rotated, hmac())).code,
      'bad_signature'
    );
    assert.strictEqual(
      rejection(() =>
        auth().verifyToken(signWith('never-configured'), hmac({ previousHmacSecret: 'old-secret-value' }))
      ).code,
      'bad_signature'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Edge -> service hand-off                                                   */
/* -------------------------------------------------------------------------- */

suite('Application security — edge identity hand-off', () => {
  const principal = (): Record<string, unknown> => ({
    subject: 'user-1',
    scopes: ['orders:read'],
    issuer: ISSUER,
    expiresAt: NOW_SECONDS + 300,
  });

  test('the gateway stamps an identity the service verifies', () => {
    const stamp = auth().stampIdentity(principal(), 'edge-secret', NOW_SECONDS);
    const headers = { ...auth().identityHeaders(principal()), [auth().EDGE_STAMP_HEADER]: stamp };
    const seen = auth().identityFromEdge(
      headers,
      { [EDGE_SHARED_SECRET_ENV]: 'edge-secret' },
      CLOCK
    );
    assert.strictEqual(seen.subject, 'user-1');
    assert.deepStrictEqual([...seen.scopes], ['orders:read']);
  });

  test('a tampered scope invalidates the stamp', () => {
    const stamp = auth().stampIdentity(principal(), 'edge-secret', NOW_SECONDS);
    const headers = {
      ...auth().identityHeaders(principal()),
      [IDENTITY_HEADERS.scopes]: 'orders:read orders:write admin',
      [auth().EDGE_STAMP_HEADER]: stamp,
    };
    assert.strictEqual(
      rejection(() =>
        auth().identityFromEdge(headers, { [EDGE_SHARED_SECRET_ENV]: 'edge-secret' }, CLOCK)
      ).code,
      'edge_stamp_invalid'
    );
  });

  test('a stale stamp is refused', () => {
    const stamp = auth().stampIdentity(principal(), 'edge-secret', NOW_SECONDS - 3600);
    const headers = { ...auth().identityHeaders(principal()), [auth().EDGE_STAMP_HEADER]: stamp };
    assert.strictEqual(
      rejection(() =>
        auth().identityFromEdge(headers, { [EDGE_SHARED_SECRET_ENV]: 'edge-secret' }, CLOCK)
      ).code,
      'edge_stamp_stale'
    );
  });

  test('the previous edge secret keeps working during the rollover', () => {
    const stamp = auth().stampIdentity(principal(), 'edge-secret-old', NOW_SECONDS);
    const headers = { ...auth().identityHeaders(principal()), [auth().EDGE_STAMP_HEADER]: stamp };
    assert.strictEqual(
      auth().identityFromEdge(
        headers,
        {
          [EDGE_SHARED_SECRET_ENV]: 'edge-secret-new',
          [EDGE_SHARED_SECRET_PREVIOUS_ENV]: 'edge-secret-old',
        },
        CLOCK
      ).subject,
      'user-1'
    );
  });

  test('a service with no identity headers refuses the caller (fails closed)', () => {
    assert.strictEqual(rejection(() => auth().identityFromEdge({}, {}, CLOCK)).code, 'edge_auth_missing');
    // The opt-out has to be explicit.
    assert.strictEqual(
      auth().identityFromEdge({}, { EDGE_AUTH_REQUIRED: '0' }, CLOCK).subject,
      'anonymous'
    );
  });

  test('health and metrics are reachable before a token exists', () => {
    for (const route of PUBLIC_PATHS) {
      assert.strictEqual(auth().isPublicPath(route), true, route);
      assert.strictEqual(auth().isPublicPath(route + '?probe=1'), true, route + ' with query');
    }
    assert.strictEqual(auth().isPublicPath('/api/v1/orders'), false);
  });

  test('scopes are enforced separately from authentication', () => {
    const caller = { scopes: ['orders:read'] };
    assert.strictEqual(auth().hasScope(caller, 'orders:read'), true);
    assert.strictEqual(auth().hasScope(caller, 'orders:write'), false);
    assert.strictEqual(auth().hasScope({ scopes: ['*'] }, 'anything'), true);
    const failure = rejection(() => auth().requireScope(caller, 'orders:write'));
    assert.strictEqual(failure.code, 'insufficient_scope');
    assert.strictEqual(failure.status, 403);
  });

  test('a bearer header that is not a bearer token is refused', () => {
    assert.strictEqual(rejection(() => auth().bearerToken({})).code, 'missing_credentials');
    assert.strictEqual(
      rejection(() => auth().bearerToken({ authorization: 'Basic abc' })).code,
      'unsupported_scheme'
    );
    assert.strictEqual(
      auth().bearerToken({ authorization: 'Bearer token-value' }),
      'token-value'
    );
  });

  test('scope and scp claims both collapse to one list', () => {
    assert.deepStrictEqual(auth().scopesFrom({ scope: 'a b' }), ['a', 'b']);
    assert.deepStrictEqual(auth().scopesFrom({ scp: ['a', 'b'] }), ['a', 'b']);
    assert.deepStrictEqual(auth().scopesFrom({}), []);
  });
});

/* -------------------------------------------------------------------------- */
/* Configuration from the environment                                         */
/* -------------------------------------------------------------------------- */

suite('Application security — configuration', () => {
  test('a missing issuer or audience stops the edge at boot', () => {
    assert.strictEqual(
      rejection(() => auth().securityConfigFromEnv({ JWT_AUDIENCE: AUDIENCE })).code,
      'misconfigured'
    );
    assert.strictEqual(
      rejection(() => auth().securityConfigFromEnv({ JWT_ISSUER: ISSUER })).code,
      'misconfigured'
    );
  });

  test('the allowlist can never contain none', () => {
    assert.strictEqual(
      rejection(() =>
        auth().securityConfigFromEnv({
          JWT_ISSUER: ISSUER,
          JWT_AUDIENCE: AUDIENCE,
          JWT_ALG_ALLOWLIST: 'RS256,none',
        })
      ).code,
      'misconfigured'
    );
  });

  test('a keyring is read from JWT_KEYS and the defaults stay asymmetric', () => {
    const config = auth().securityConfigFromEnv({
      JWT_ISSUER: ISSUER,
      JWT_AUDIENCE: AUDIENCE,
      JWT_KEYS: JSON.stringify([{ kid: 'k1', pem: pem(rsaCurrent) }]),
    }) as { algorithms: string[]; keys: { kid: string }[] };
    assert.deepStrictEqual(config.algorithms, [...DEFAULT_ALG_ALLOWLIST]);
    assert.strictEqual(config.keys.length, 1);
    assert.strictEqual(config.keys[0].kid, 'k1');
  });

  test('a malformed keyring is a startup failure, not a silent empty ring', () => {
    assert.strictEqual(
      rejection(() =>
        auth().securityConfigFromEnv({
          JWT_ISSUER: ISSUER,
          JWT_AUDIENCE: AUDIENCE,
          JWT_KEYS: 'not-json',
        })
      ).code,
      'misconfigured'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Secrets                                                                    */
/* -------------------------------------------------------------------------- */

suite('Application security — secrets', () => {
  test('a required secret can never fall back to a default', () => {
    assert.throws(
      () => secrets().requireSecret({}, 'JWT_HMAC_SECRET'),
      (error: { code?: string }) => error.code === 'missing_secret'
    );
    assert.strictEqual(secrets().requireSecret({ JWT_HMAC_SECRET: 'value-1' }, 'JWT_HMAC_SECRET'), 'value-1');
  });

  test('a placeholder in the environment is treated as missing', () => {
    for (const placeholder of ['<set-through-the-secret-store>', 'changeme', 'your-secret', '']) {
      assert.strictEqual(secrets().looksLikePlaceholder(placeholder), true, placeholder);
      assert.throws(
        () => secrets().requireSecret({ JWT_HMAC_SECRET: placeholder }, 'JWT_HMAC_SECRET'),
        (error: { code?: string }) => error.code === 'missing_secret',
        placeholder
      );
    }
    assert.strictEqual(secrets().looksLikePlaceholder('a-real-random-value'), false);
  });

  test('boot validation reports every missing secret at once', () => {
    try {
      secrets().assertBootSecrets({ A: 'ok-value', B: '' }, ['A', 'B', 'C']);
      throw new assert.AssertionError({ message: 'expected a failure' });
    } catch (error) {
      const failure = error as { names?: string[] };
      assert.deepStrictEqual(failure.names, ['B', 'C']);
    }
  });

  test('describeSecrets reports state, never content', () => {
    const report = secrets().describeSecrets(
      { A: 'super-secret-value', B: '', C: 'changeme' },
      ['A', 'B', 'C']
    );
    assert.deepStrictEqual(
      report.map((entry) => entry.state),
      ['set', 'missing', 'placeholder']
    );
    assert.strictEqual(JSON.stringify(report).includes('super-secret-value'), false);
  });

  test('credential-shaped headers are masked, others pass through', () => {
    const masked = secrets().redactHeaders({
      authorization: 'Bearer abc.def.ghi',
      cookie: 'sid=1',
      'x-correlation-id': 'corr-1',
      'x-auth-subject': 'user-1',
    });
    assert.strictEqual(masked.authorization, '***');
    assert.strictEqual(masked.cookie, '***');
    assert.strictEqual(masked['x-correlation-id'], 'corr-1');
    assert.strictEqual(masked['x-auth-subject'], 'user-1');
    assert.strictEqual(secrets().redactValue(undefined), '<unset>');
  });

  test('optionalSecret distinguishes absent from placeholder', () => {
    assert.strictEqual(secrets().optionalSecret({}, 'X'), undefined);
    assert.strictEqual(secrets().optionalSecret({ X: 'value-1' }, 'X'), 'value-1');
    assert.throws(
      () => secrets().optionalSecret({ X: 'changeme' }, 'X'),
      (error: { code?: string }) => error.code === 'missing_secret'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The artifact contract                                                      */
/* -------------------------------------------------------------------------- */

suite('Application security — artifact contract', () => {
  test('both modules land where the clause points', () => {
    const paths = planSecurityFiles().map((file) => file.path);
    assert.deepStrictEqual(paths, [AUTH_PATH, SECRETS_PATH]);
    assert.strictEqual(AUTH_PATH, 'packages/shared/src/auth.ts');
    assert.ok(sharedSecurityBarrelLines().some((line) => line.includes("'./auth'")));
    assert.ok(sharedSecurityBarrelLines().some((line) => line.includes("'./secrets'")));
  });

  test('every rule the architecture doc states names an export that exists', () => {
    const module = auth() as unknown as Record<string, unknown>;
    const secretModule = secrets() as unknown as Record<string, unknown>;
    for (const row of securityArchitectureRows()) {
      assert.ok(row.startsWith('| '), row);
      const symbol = /`([A-Za-z][A-Za-z0-9]*)`/.exec(row);
      assert.ok(symbol, 'row names no symbol: ' + row);
      const name = symbol[1];
      assert.ok(
        name in module || name in secretModule,
        'the doc names ' + name + ' but no module exports it'
      );
    }
  });

  test('the env spec never puts a secret in the ConfigMap', () => {
    const configNames = securityConfigKeys();
    const secretNames = securitySecretKeys();
    assert.deepStrictEqual(configNames, ['JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_ALG_ALLOWLIST', 'JWT_JWKS_URL']);
    assert.ok(secretNames.includes('JWT_HMAC_SECRET'));
    assert.ok(secretNames.includes(EDGE_SHARED_SECRET_ENV));
    for (const name of secretNames) {
      assert.strictEqual(configNames.includes(name), false, name);
    }
    assert.deepStrictEqual(
      securityConfigEnv().map((entry) => entry.name),
      configNames
    );
    // The example file may only carry placeholders for the secret half.
    for (const line of securityEnvLines()) {
      const [name, value] = line.split('=');
      if (secretNames.includes(name)) {
        assert.strictEqual(secrets().looksLikePlaceholder(value), true, line);
      }
    }
  });

  test('the scaffolded node tree carries the clause end to end', () => {
    const fixtures = path.join(__dirname, '..', '..', '..', '..', 'src', 'test', 'suite', 'services', 'fixtures');
    const tree = JSON.parse(
      fs.readFileSync(path.join(fixtures, 'monorepo-microservices.tree.json'), 'utf8')
    ) as { files: Record<string, string> };
    const files = Object.keys(tree.files);

    assert.ok(files.includes('packages/shared/src/auth.ts'));
    assert.ok(files.includes('packages/shared/src/secrets.ts'));

    const gateway = tree.files['services/gateway/src/index.ts'];
    assert.ok(gateway.includes('authenticateRequest'), 'the gateway validates the token');
    assert.ok(gateway.includes('stampedIdentityHeaders'), 'the gateway stamps the identity');
    assert.ok(gateway.includes('securityConfigFromEnv'), 'the edge config is built at boot');

    const service = tree.files['services/users/src/index.ts'];
    assert.ok(service.includes('identityFromEdge'), 'the service checks the edge identity');
    assert.ok(
      !service.includes('verifyToken'),
      'the service must not parse tokens: that is the edge job'
    );

    const env = tree.files['.env.example'];
    for (const spec of SECURITY_ENV) {
      assert.ok(env.includes(spec.name + '='), 'missing env line for ' + spec.name);
    }

    const manifestTree = JSON.parse(
      fs.readFileSync(path.join(fixtures, 'monorepo-microservices.options.tree.json'), 'utf8')
    ) as { files: Record<string, string> };
    const manifest = manifestTree.files['deploy/k8s/users.yaml'];
    assert.ok(manifest, 'the k8s manifest is part of the tree');
    assert.ok(manifest.includes('JWT_ISSUER'), 'the ConfigMap carries the non-secret keys');
    assert.ok(
      !manifest.includes('JWT_HMAC_SECRET'),
      'a secret must never be projected from a ConfigMap'
    );

    const barrel = tree.files['packages/shared/src/index.ts'];
    assert.ok(barrel.includes("'./auth'"));
    assert.ok(barrel.includes("'./secrets'"));
  });
});

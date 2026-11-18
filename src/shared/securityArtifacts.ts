/**
 * ZEN standards — application security (CON-05).
 *
 * Why this module exists: CON-05 was the last runtime clause the scaffold could
 * not claim. `.env.example` held placeholders and no credential was hardcoded,
 * but no emitted service validated a token, so a generated service accepted any
 * caller that could reach it. The clause has three halves and each one needs a
 * different artifact:
 *
 *   - JWTs validated at the edge      -> `packages/shared/src/auth.ts`
 *   - secrets from the environment    -> `packages/shared/src/secrets.ts` + env spec
 *   - crypto agility (rotation)       -> the keyring in `auth.ts`, not a constant
 *
 * Two rules shaped the design. First, "validated at the edge" is only true if
 * the *service* still fails closed when it is called directly, so the service
 * requires the gateway's identity headers unless `EDGE_AUTH_REQUIRED=0` is set
 * explicitly. Second, algorithm agility is a security property, not a feature:
 * the allowlist must be checked *before* the signature, or a token signed with
 * HS256 using the public key as the HMAC secret validates against an RS256
 * keyring. That attack is a test, not a comment.
 *
 * Node builtins only — the repo ships zero runtime dependencies.
 */

export interface SecurityFile {
  readonly path: string;
  readonly content: string;
}

export const SECURITY_DIR = 'packages/shared/src';
export const AUTH_PATH = `${SECURITY_DIR}/auth.ts`;
export const SECRETS_PATH = `${SECURITY_DIR}/secrets.ts`;

/** Header the gateway reads, and the header it stamps for the services. */
export const AUTH_HEADER = 'authorization';
export const IDENTITY_HEADERS = {
  subject: 'x-auth-subject',
  scopes: 'x-auth-scopes',
  issuer: 'x-auth-issuer',
  verified: 'x-auth-verified',
} as const;

/** Asymmetric by default: symmetric algorithms are opt-in, never the default. */
export const DEFAULT_ALG_ALLOWLIST = ['RS256', 'ES256'];

/** Endpoints that must answer before a caller has a token. */
export const PUBLIC_PATHS = ['/healthz/live', '/healthz/ready', '/health', '/ready', '/metrics'];

export const CLOCK_SKEW_SECONDS = 30;

/** The one switch: `0` makes a service answer unauthenticated callers directly. */
export const EDGE_AUTH_ENV = 'EDGE_AUTH_REQUIRED';

/**
 * The secret that signs the identity headers the gateway stamps. Without it
 * the service can only trust the network — and it says so at startup.
 */
export const EDGE_SHARED_SECRET_ENV = 'EDGE_AUTH_SHARED_SECRET';
export const EDGE_SHARED_SECRET_PREVIOUS_ENV = 'EDGE_AUTH_SHARED_SECRET_PREVIOUS';
export const EDGE_STAMP_HEADER = 'x-auth-stamp';
export const EDGE_STAMP_MAX_AGE_SECONDS = 300;

/**
 * Environment the security clause consumes. `secret: true` means the value must
 * come from a Secret (k8s `secretKeyRef`) and must never sit in a ConfigMap.
 */
export interface SecurityEnvSpec {
  readonly name: string;
  readonly description: string;
  readonly example: string;
  readonly secret: boolean;
}

export const SECURITY_ENV: readonly SecurityEnvSpec[] = [
  {
    name: 'JWT_ISSUER',
    description: 'Expected `iss`; a token from any other issuer is rejected.',
    example: 'https://login.example.com/',
    secret: false,
  },
  {
    name: 'JWT_AUDIENCE',
    description: 'Expected `aud`; the API identifier, not the caller.',
    example: 'api://orders',
    secret: false,
  },
  {
    name: 'JWT_ALG_ALLOWLIST',
    description: 'Comma-separated algorithms accepted for verification.',
    example: DEFAULT_ALG_ALLOWLIST.join(','),
    secret: false,
  },
  {
    name: 'JWT_JWKS_URL',
    description: 'JWKS endpoint the edge refreshes when an unknown `kid` arrives.',
    example: 'https://login.example.com/.well-known/jwks.json',
    secret: false,
  },
  {
    name: 'JWT_HMAC_SECRET',
    description: 'Current symmetric key. Only read when the allowlist names an HS* algorithm.',
    example: '<set-through-the-secret-store>',
    secret: true,
  },
  {
    name: 'JWT_HMAC_SECRET_PREVIOUS',
    description: 'Previous symmetric key, kept for the rotation window.',
    example: '<set-through-the-secret-store>',
    secret: true,
  },
  {
    name: EDGE_SHARED_SECRET_ENV,
    description: 'Signs the identity headers the gateway stamps; services verify it.',
    example: '<set-through-the-secret-store>',
    secret: true,
  },
  {
    name: EDGE_SHARED_SECRET_PREVIOUS_ENV,
    description: 'Previous edge stamp key, kept for the rotation window.',
    example: '<set-through-the-secret-store>',
    secret: true,
  },
];

/** Credential-shaped header names the redactor masks before anything is logged. */
export const CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-secret',
  'idempotency-key',
];

/**
 * The generated `auth.ts`. Written without template literals on purpose: the
 * file is produced from inside a template literal here, so a `${` in the output
 * would be read as this module's own interpolation.
 */
const AUTH_SOURCE = `/**
 * Edge authentication — ZEN-STD-CON-05.
 *
 * The gateway is the only component that validates a token; services behind it
 * trust the identity headers it stamps. "Trust" here means the service still
 * fails closed: a request that reaches a service without those headers is
 * refused unless EDGE_AUTH_REQUIRED=0 was set deliberately.
 *
 * Algorithm agility: JWT_ALG_ALLOWLIST decides which algorithms may verify a
 * token, and it is consulted BEFORE the signature. Without that order an
 * attacker can sign an HS256 token using the public key as the shared secret
 * and the RSA keyring will happily verify it (algorithm-confusion attack).
 * Rotation works the same way for both key families: several keys, matched by
 * \`kid\` or tried in order, and a JWKS refresh instead of a restart.
 */
import {
  constants,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

export const AUTH_HEADER = '${AUTH_HEADER}';
export const BEARER_PREFIX = 'bearer ';
export const IDENTITY_HEADERS = {
  subject: '${IDENTITY_HEADERS.subject}',
  scopes: '${IDENTITY_HEADERS.scopes}',
  issuer: '${IDENTITY_HEADERS.issuer}',
  verified: '${IDENTITY_HEADERS.verified}',
} as const;
export const EDGE_AUTH_ENV = '${EDGE_AUTH_ENV}';
export const DEFAULT_ALGORITHMS = [${DEFAULT_ALG_ALLOWLIST.map((alg) => `'${alg}'`).join(', ')}];
export const PUBLIC_PATHS = [${PUBLIC_PATHS.map((p) => `'${p}'`).join(', ')}];
export const CLOCK_SKEW_SECONDS = ${CLOCK_SKEW_SECONDS};

/** Every algorithm this module can verify. Being listed here is not permission. */
export const ALGORITHM_SUPPORT = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'HS256',
  'HS384',
  'HS512',
];

const DIGESTS: Record<string, string> = {
  RS256: 'sha256',
  RS384: 'sha384',
  RS512: 'sha512',
  PS256: 'sha256',
  PS384: 'sha384',
  PS512: 'sha512',
  ES256: 'sha256',
  ES384: 'sha384',
  ES512: 'sha512',
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

export interface Principal {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly issuer: string;
  readonly expiresAt: number;
}

/** One verification key. \`key\` is a PEM string or a JWK object. */
export interface KeyringEntry {
  readonly kid: string;
  readonly key: string | Record<string, unknown>;
}

export interface AuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  readonly keys: readonly KeyringEntry[];
  readonly hmacSecret?: string;
  readonly previousHmacSecret?: string;
  readonly clockSkewSeconds?: number;
  readonly now?: () => number;
}

export type HeaderBag = Record<string, string | string[] | undefined>;
export type EnvBag = Record<string, string | undefined>;

/** A rejected credential. \`status\` is 401 unless a scope check set 403. */
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }

  /** RFC 6750 challenge so a client knows why it was refused. */
  get wwwAuthenticate(): string {
    return 'Bearer error="' + this.code + '", error_description="' + this.message + '"';
  }
}

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Extracts the bearer token, or explains why there is not one. */
export function bearerToken(headers: HeaderBag): string {
  const raw = headerValue(headers, AUTH_HEADER);
  if (!raw) {
    throw new AuthError('missing_credentials', 'No Authorization header.');
  }
  const value = raw.trim();
  if (value.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    throw new AuthError('unsupported_scheme', 'Only the Bearer scheme is accepted.');
  }
  const token = value.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    throw new AuthError('missing_credentials', 'The bearer token is empty.');
  }
  return token;
}

function decodeSegment(segment: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('malformed_token', 'A JWT segment is not base64url-encoded JSON.');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new AuthError('malformed_token', 'A JWT segment is not a JSON object.');
  }
  return decoded as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** \`scope\` (OAuth) and \`scp\` (Azure AD) both collapse to one list. */
export function scopesFrom(payload: Record<string, unknown>): string[] {
  const collect = (value: unknown): string[] => {
    if (typeof value === 'string') {
      return value.split(' ').filter((entry) => entry.length > 0);
    }
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }
    return [];
  };
  return [...collect(payload.scope), ...collect(payload.scp)];
}

export function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes.includes(scope) || principal.scopes.includes('*');
}

/** Throws 403 — authenticated but not entitled. */
export function requireScope(principal: Principal, scope: string): void {
  if (!hasScope(principal, scope)) {
    throw new AuthError('insufficient_scope', 'This call needs the "' + scope + '" scope.', 403);
  }
}

function verifyHmac(
  signingInput: string,
  signature: Buffer,
  algorithm: string,
  config: AuthConfig
): void {
  const secrets = [config.hmacSecret, config.previousHmacSecret].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0
  );
  if (secrets.length === 0) {
    throw new AuthError('key_unavailable', 'No HMAC secret is configured for ' + algorithm + '.');
  }
  const digest = DIGESTS[algorithm];
  for (const secret of secrets) {
    const expected = createHmac(digest, secret).update(signingInput).digest();
    if (expected.length === signature.length && timingSafeEqual(expected, signature)) {
      return;
    }
  }
  throw new AuthError('bad_signature', 'The token signature does not verify.');
}

function verifyWithKey(
  signingInput: string,
  signature: Buffer,
  algorithm: string,
  entry: KeyringEntry
): boolean {
  const digest = DIGESTS[algorithm];
  try {
    const key = createPublicKey(
      typeof entry.key === 'string'
        ? entry.key
        : { key: entry.key as unknown as import('node:crypto').JsonWebKey, format: 'jwk' }
    );
    const data = Buffer.from(signingInput, 'utf8');
    if (algorithm.startsWith('PS')) {
      return verifySignature(
        digest,
        data,
        {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signature
      );
    }
    if (algorithm.startsWith('ES')) {
      return verifySignature(digest, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return verifySignature(digest, data, key, signature);
  } catch {
    // A malformed key is a verification failure, never a crash.
    return false;
  }
}

function verifyAsymmetric(
  signingInput: string,
  signature: Buffer,
  algorithm: string,
  header: Record<string, unknown>,
  config: AuthConfig
): void {
  const kid = typeof header.kid === 'string' ? header.kid : '';
  if (!kid) {
    throw new AuthError('key_not_found', 'An asymmetric token must carry a kid.');
  }
  const candidates = config.keys.filter((entry) => entry.kid === kid);
  if (candidates.length === 0) {
    throw new AuthError('key_not_found', 'No verification key for kid "' + kid + '".');
  }
  for (const entry of candidates) {
    if (verifyWithKey(signingInput, signature, algorithm, entry)) {
      return;
    }
  }
  throw new AuthError('bad_signature', 'The token signature does not verify.');
}

function verifyClaims(
  payload: Record<string, unknown>,
  config: AuthConfig
): Principal {
  const skew = config.clockSkewSeconds ?? CLOCK_SKEW_SECONDS;
  const nowSeconds = Math.floor((config.now ? config.now() : Date.now()) / 1000);

  const exp = asNumber(payload.exp);
  if (exp === undefined) {
    throw new AuthError('missing_expiry', 'A token without exp is refused.');
  }
  if (nowSeconds - skew >= exp) {
    throw new AuthError('token_expired', 'The token expired at ' + exp + '.');
  }

  const nbf = asNumber(payload.nbf);
  if (nbf !== undefined && nowSeconds + skew < nbf) {
    throw new AuthError('token_not_yet_valid', 'The token becomes valid at ' + nbf + '.');
  }

  const iat = asNumber(payload.iat);
  if (iat !== undefined && iat - skew > nowSeconds) {
    throw new AuthError('issued_in_future', 'The token was issued in the future.');
  }

  const issuer = typeof payload.iss === 'string' ? payload.iss : '';
  if (issuer !== config.issuer) {
    throw new AuthError('wrong_issuer', 'The token issuer is not the configured issuer.');
  }

  const rawAudience = payload.aud;
  const audiences = Array.isArray(rawAudience)
    ? rawAudience.filter((entry): entry is string => typeof entry === 'string')
    : typeof rawAudience === 'string'
      ? [rawAudience]
      : [];
  if (!audiences.includes(config.audience)) {
    throw new AuthError('wrong_audience', 'The token was not issued for this API.');
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (!subject) {
    throw new AuthError('missing_subject', 'The token has no subject.');
  }

  return { subject, scopes: scopesFrom(payload), issuer, expiresAt: exp };
}

/**
 * Verifies one token end to end and returns the caller.
 *
 * Order matters: the allowlist runs before any key is touched, so an
 * algorithm-confusion token never reaches the RSA keyring.
 */
export function verifyToken(token: string, config: AuthConfig): Principal {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new AuthError('malformed_token', 'A JWT has three dot-separated segments.');
  }
  const header = decodeSegment(segments[0]);
  const payload = decodeSegment(segments[1]);
  const algorithm = typeof header.alg === 'string' ? header.alg : '';

  if (algorithm.toLowerCase() === 'none') {
    throw new AuthError('algorithm_not_allowed', 'Unsecured JWTs are never accepted.');
  }
  if (!ALGORITHM_SUPPORT.includes(algorithm)) {
    throw new AuthError('algorithm_not_allowed', '"' + algorithm + '" is not verifiable.');
  }
  if (!config.algorithms.includes(algorithm)) {
    throw new AuthError(
      'algorithm_not_allowed',
      '"' + algorithm + '" is not in JWT_ALG_ALLOWLIST.'
    );
  }

  const signingInput = segments[0] + '.' + segments[1];
  const signature = Buffer.from(segments[2], 'base64url');
  if (signature.length === 0) {
    throw new AuthError('bad_signature', 'The token carries no signature.');
  }

  if (algorithm.startsWith('HS')) {
    verifyHmac(signingInput, signature, algorithm, config);
  } else {
    verifyAsymmetric(signingInput, signature, algorithm, header, config);
  }

  return verifyClaims(payload, config);
}

/** True for the endpoints that must answer before a caller holds a token. */
export function isPublicPath(pathname: string): boolean {
  const path = pathname.split('?')[0];
  return PUBLIC_PATHS.includes(path);
}

/** Gateway side: verify the inbound token. */
export function authenticateRequest(headers: HeaderBag, config: AuthConfig): Principal {
  return verifyToken(bearerToken(headers), config);
}

/** Gateway side: what the upstream service needs to know, and nothing more. */
export function identityHeaders(principal: Principal): Record<string, string> {
  return {
    [IDENTITY_HEADERS.subject]: principal.subject,
    [IDENTITY_HEADERS.scopes]: principal.scopes.join(' '),
    [IDENTITY_HEADERS.issuer]: principal.issuer,
    [IDENTITY_HEADERS.verified]: 'edge',
  };
}

export const EDGE_SHARED_SECRET_ENV = 'EDGE_AUTH_SHARED_SECRET';
export const EDGE_SHARED_SECRET_PREVIOUS_ENV = 'EDGE_AUTH_SHARED_SECRET_PREVIOUS';
export const EDGE_STAMP_HEADER = 'x-auth-stamp';
export const EDGE_STAMP_MAX_AGE_SECONDS = 300;

/** The exact string both sides sign, so the two cannot drift apart. */
export function identityCanonical(principal: Principal): string {
  return [principal.subject, principal.scopes.join(' '), principal.issuer].join('|');
}

/** Gateway side: proof that this identity came from the edge, and when. */
export function stampIdentity(principal: Principal, secret: string, at?: number): string {
  const issuedAt = at ?? Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', secret)
    .update(identityCanonical(principal) + '|' + issuedAt)
    .digest('hex');
  return issuedAt + '.' + mac;
}

/** The headers the gateway sends upstream: the identity plus its stamp. */
export function stampedIdentityHeaders(
  principal: Principal,
  secret: string | undefined,
  at?: number
): Record<string, string> {
  const headers = identityHeaders(principal);
  if (secret && secret.length > 0) {
    headers[EDGE_STAMP_HEADER] = stampIdentity(principal, secret, at);
  }
  return headers;
}

/** Service side: refuses a stamp that is forged, stale or signed with a retired key. */
export function verifyIdentityStamp(
  stamp: string | undefined,
  principal: Principal,
  secrets: readonly string[],
  maxAgeSeconds: number = EDGE_STAMP_MAX_AGE_SECONDS,
  now?: () => number
): void {
  if (!stamp) {
    throw new AuthError('edge_stamp_missing', 'The gateway stamp header is absent.');
  }
  const segments = stamp.split('.');
  if (segments.length !== 2) {
    throw new AuthError('edge_stamp_invalid', 'The gateway stamp is malformed.');
  }
  const issuedAt = Number(segments[0]);
  if (!Number.isFinite(issuedAt)) {
    throw new AuthError('edge_stamp_invalid', 'The gateway stamp carries no timestamp.');
  }
  const nowSeconds = Math.floor((now ? now() : Date.now()) / 1000);
  if (Math.abs(nowSeconds - issuedAt) > maxAgeSeconds) {
    throw new AuthError('edge_stamp_stale', 'The gateway stamp is outside its window.');
  }
  const presented = Buffer.from(segments[1], 'hex');
  const message = identityCanonical(principal) + '|' + issuedAt;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    const expected = createHmac('sha256', secret).update(message).digest();
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      return;
    }
  }
  throw new AuthError('edge_stamp_invalid', 'The gateway stamp does not verify.');
}

/**
 * Service side: read the identity the gateway stamped.
 *
 * Fails closed — the default when EDGE_AUTH_ENV is unset is "required", so a
 * service that is reachable without the gateway refuses rather than serves.
 */
export function identityFromEdge(headers: HeaderBag, env: EnvBag, now?: () => number): Principal {
  const required = (env[EDGE_AUTH_ENV] ?? '1') !== '0';
  const subject = headerValue(headers, IDENTITY_HEADERS.subject) ?? '';
  const verified = headerValue(headers, IDENTITY_HEADERS.verified) ?? '';
  const principal: Principal = {
    subject: subject || (required ? '' : 'anonymous'),
    scopes: (headerValue(headers, IDENTITY_HEADERS.scopes) ?? '')
      .split(' ')
      .filter((entry) => entry.length > 0),
    issuer: headerValue(headers, IDENTITY_HEADERS.issuer) ?? (required ? '' : 'anonymous'),
    expiresAt: 0,
  };

  if (!required) {
    return principal;
  }
  if (!subject || verified !== 'edge') {
    throw new AuthError(
      'edge_auth_missing',
      'This service only accepts calls forwarded by the gateway.'
    );
  }

  // The stamp is what makes "validated at the edge" worth the name: without it
  // any workload on the cluster network could invent an identity header.
  const secrets = [env[EDGE_SHARED_SECRET_ENV], env[EDGE_SHARED_SECRET_PREVIOUS_ENV]].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0
  );
  if (secrets.length > 0) {
    verifyIdentityStamp(
      headerValue(headers, EDGE_STAMP_HEADER),
      principal,
      secrets,
      EDGE_STAMP_MAX_AGE_SECONDS,
      now
    );
  }
  return principal;
}

export interface JwksDocument {
  readonly keys?: readonly Record<string, unknown>[];
}

/** Normalises a JWKS document into keyring entries, skipping what it cannot read. */
export function keyringFromJwks(document: JwksDocument): KeyringEntry[] {
  const entries: KeyringEntry[] = [];
  for (const jwk of document.keys ?? []) {
    const kid = typeof jwk.kid === 'string' ? jwk.kid : '';
    if (!kid) {
      continue;
    }
    entries.push({ kid, key: { ...jwk } });
  }
  return entries;
}

export type JwksFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Rotation without a restart: swap the keyring after the identity provider
 * publishes a new key. A token signed by the new kid then verifies, and the old
 * kid keeps working until it is withdrawn from the document.
 */
export async function refreshKeyring(
  config: AuthConfig,
  jwksUrl: string,
  fetcher: JwksFetcher
): Promise<AuthConfig> {
  const response = await fetcher(jwksUrl);
  if (!response.ok) {
    throw new AuthError('keyring_unavailable', 'JWKS fetch failed with ' + response.status + '.');
  }
  const document = (await response.json()) as JwksDocument;
  const keys = keyringFromJwks(document);
  if (keys.length === 0) {
    throw new AuthError('keyring_unavailable', 'The JWKS document carried no usable keys.');
  }
  return { ...config, keys };
}

/**
 * Builds the edge configuration from the environment. A missing issuer or
 * audience is a startup failure, not a per-request one: an edge that cannot say
 * who it trusts must not accept anybody.
 */
export function securityConfigFromEnv(env: EnvBag): AuthConfig {
  const issuer = (env.JWT_ISSUER ?? '').trim();
  const audience = (env.JWT_AUDIENCE ?? '').trim();
  if (!issuer || !audience) {
    throw new AuthError(
      'misconfigured',
      'JWT_ISSUER and JWT_AUDIENCE are required to validate tokens.'
    );
  }
  const algorithms = (env.JWT_ALG_ALLOWLIST ?? DEFAULT_ALGORITHMS.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const algorithm of algorithms) {
    if (algorithm.toLowerCase() === 'none') {
      throw new AuthError('misconfigured', 'JWT_ALG_ALLOWLIST must never contain "none".');
    }
    if (!ALGORITHM_SUPPORT.includes(algorithm)) {
      throw new AuthError('misconfigured', 'JWT_ALG_ALLOWLIST lists an unsupported algorithm.');
    }
  }

  let keys: KeyringEntry[] = [];
  const rawKeyring = (env.JWT_KEYS ?? '').trim();
  if (rawKeyring) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawKeyring);
    } catch {
      throw new AuthError('misconfigured', 'JWT_KEYS is not valid JSON.');
    }
    if (!Array.isArray(parsed)) {
      throw new AuthError('misconfigured', 'JWT_KEYS must be an array of { kid, pem|jwk }.');
    }
    keys = parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        kid: typeof entry.kid === 'string' ? entry.kid : '',
        key: (entry.pem ?? entry.jwk ?? '') as string | Record<string, unknown>,
      }))
      .filter((entry) => entry.kid.length > 0 && entry.key !== '');
  }

  const config: AuthConfig = {
    issuer,
    audience,
    algorithms,
    keys,
  };
  const hmacSecret = (env.JWT_HMAC_SECRET ?? '').trim();
  const previousHmacSecret = (env.JWT_HMAC_SECRET_PREVIOUS ?? '').trim();
  if (hmacSecret) {
    return {
      ...config,
      hmacSecret,
      ...(previousHmacSecret ? { previousHmacSecret } : {}),
    };
  }
  return previousHmacSecret ? { ...config, previousHmacSecret } : config;
}
`;

/**
 * The generated `secrets.ts` — the second half of CON-05.
 *
 * "Secrets come from the environment" is only true if a missing secret stops the
 * process. A `process.env.X || 'dev-secret'` default is the failure mode: the
 * service starts happily in production with a known key. `requireSecret` throws,
 * `describeSecrets` reports presence without ever printing a value.
 */
const SECRETS_SOURCE = `/**
 * Secret handling — ZEN-STD-CON-05.
 *
 * Three rules, one file:
 *   - a required secret with no value stops the process at boot;
 *   - a value that still looks like the .env.example placeholder is not a value;
 *   - nothing credential-shaped is ever logged — describeSecrets reports state,
 *     never content, and redactHeaders masks the headers that carry tokens.
 */
export type EnvBag = Record<string, string | undefined>;

/** Substrings that mark a value as an unfilled placeholder. */
export const PLACEHOLDER_MARKERS = [
  'changeme',
  'change-me',
  'change_me',
  'your-',
  'your_',
  'placeholder',
  'replace-me',
  'replace_me',
  'example.com',
  '<set',
  'todo',
];

/** Headers whose value must never reach a log line. */
export const CREDENTIAL_HEADERS = [${CREDENTIAL_HEADERS.map((h) => `'${h}'`).join(', ')}];

export class MissingSecretError extends Error {
  readonly code = 'missing_secret';
  readonly names: readonly string[];

  constructor(names: readonly string[]) {
    super('Missing or placeholder secret(s): ' + names.join(', ') + '.');
    this.name = 'MissingSecretError';
    this.names = names;
  }
}

export function looksLikePlaceholder(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised.length === 0) {
    return true;
  }
  return PLACEHOLDER_MARKERS.some((marker) => normalised.includes(marker));
}

/** Reads a secret or throws. Never returns a default. */
export function requireSecret(env: EnvBag, name: string): string {
  const raw = env[name];
  if (raw === undefined || looksLikePlaceholder(raw)) {
    throw new MissingSecretError([name]);
  }
  return raw.trim();
}

/** Optional secret: \`undefined\` when absent, still throws on a placeholder. */
export function optionalSecret(env: EnvBag, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  if (looksLikePlaceholder(raw)) {
    throw new MissingSecretError([name]);
  }
  return raw.trim();
}

/** Fails once, at boot, listing every problem instead of the first one. */
export function assertBootSecrets(env: EnvBag, names: readonly string[]): void {
  const missing = names.filter((name) => {
    const raw = env[name];
    return raw === undefined || looksLikePlaceholder(raw);
  });
  if (missing.length > 0) {
    throw new MissingSecretError(missing);
  }
}

export type SecretState = 'set' | 'missing' | 'placeholder';

/**
 * What a startup log may say about a secret: presence, never content.
 */
export function describeSecrets(
  env: EnvBag,
  names: readonly string[]
): Array<{ name: string; state: SecretState }> {
  return names.map((name) => {
    const raw = env[name];
    if (raw === undefined || raw.trim().length === 0) {
      return { name, state: 'missing' as SecretState };
    }
    return {
      name,
      state: looksLikePlaceholder(raw) ? ('placeholder' as SecretState) : ('set' as SecretState),
    };
  });
}

/** Masks a single value, keeping nothing that could help an attacker. */
export function redactValue(value: string | undefined): string {
  return value === undefined || value.length === 0 ? '<unset>' : '***';
}

/**
 * Masks credential-shaped headers. Returns a new object: the caller may log the
 * result, and the input headers are untouched.
 */
export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const flat = Array.isArray(value) ? value.join(',') : value;
    masked[name] = CREDENTIAL_HEADERS.includes(name.toLowerCase())
      ? redactValue(flat)
      : (flat ?? '<unset>');
  }
  return masked;
}
`;

/** The files the monorepo writer emits for CON-05. */
export function planSecurityFiles(): SecurityFile[] {
  return [
    { path: AUTH_PATH, content: AUTH_SOURCE },
    { path: SECRETS_PATH, content: SECRETS_SOURCE },
  ];
}

/** The generated sources, for tests that execute them. */
export function authSource(): string {
  return AUTH_SOURCE;
}

export function secretsSource(): string {
  return SECRETS_SOURCE;
}

/** Barrel lines the shared package index needs. */
export function sharedSecurityBarrelLines(): string[] {
  return [
    "export * from './auth';",
    "export * from './secrets';",
  ];
}

/**
 * `.env.example` lines. Named so the file and the k8s Secret template cannot
 * disagree about which variables the clause actually reads.
 */
export function securityEnvLines(): string[] {
  return SECURITY_ENV.map((entry) => `${entry.name}=${entry.example}`);
}

/** Keys that must be projected from a Secret, not a ConfigMap. */
export function securitySecretKeys(): string[] {
  return SECURITY_ENV.filter((entry) => entry.secret).map((entry) => entry.name);
}

/** Non-secret keys, safe in a ConfigMap. */
/** Name/value pairs for a ConfigMap: the non-secret half of the clause. */
export function securityConfigEnv(): { name: string; value: string }[] {
  return SECURITY_ENV.filter((entry) => !entry.secret).map((entry) => ({
    name: entry.name,
    value: entry.example,
  }));
}

export function securityConfigKeys(): string[] {
  return SECURITY_ENV.filter((entry) => !entry.secret).map((entry) => entry.name);
}

/**
 * `ARCHITECTURE.md` rows — each names the exported symbol that enforces the
 * rule, so the document cannot describe a control the code does not have.
 */
export const SECURITY_RULES: readonly { readonly rule: string; readonly symbol: string; readonly note: string }[] = [
  {
    rule: 'Tokens are validated only at the gateway',
    symbol: 'authenticateRequest',
    note: 'services call `identityFromEdge` and never parse a bearer token',
  },
  {
    rule: 'Algorithm allowlist before signature verification',
    symbol: 'verifyToken',
    note: 'blocks algorithm-confusion attacks',
  },
  {
    rule: 'Key rotation without a restart',
    symbol: 'refreshKeyring',
    note: 'JWKS refresh on unknown `kid`; previous HMAC secret honoured',
  },
  {
    rule: 'Secrets come from the environment or a Secret',
    symbol: 'requireSecret',
    note: 'a missing or placeholder value stops the process at boot',
  },
  {
    rule: 'No credential reaches a log line',
    symbol: 'redactHeaders',
    note: 'and `describeSecrets` reports state, never content',
  },
];

export function securityArchitectureRows(): string[] {
  return SECURITY_RULES.map(
    (entry) => `| ${entry.rule} | \`${entry.symbol}\` - ${entry.note} |`
  );
}

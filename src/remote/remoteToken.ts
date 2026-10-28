import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * Remote Access token lifecycle (R-P1-02).
 *
 * The token is the *only* credential on the loopback/LAN console, so:
 *  - it is generated from `crypto.randomBytes` (never Math.random, never a
 *    timestamp or pid),
 *  - it is compared with `timingSafeEqual` (no early-exit string compare that
 *    would leak a prefix over the network),
 *  - it lives in `SecretStorage` (never settings.json, never the tree view),
 *  - every failure path fails CLOSED (a throwing keyring verifies as `false`).
 *
 * The class is vscode-free by dependency injection: `RemoteTokenStore` takes the
 * two SecretStorage methods it needs, so the headless suites drive it directly.
 */

/** SecretStorage key holding the console token. */
export const REMOTE_TOKEN_SECRET_KEY = 'adoCode.remote.token';

/** 32 bytes ≈ 43 base64url chars ≈ 256 bits. */
const TOKEN_BYTES = 32;

/** Anything shorter than this is treated as a stale/legacy secret. */
const MIN_TOKEN_LENGTH = 32;

/** The slice of `vscode.SecretStorage` this module needs. */
export interface SecretStorageLike {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** URL-safe base64 without padding — pasteable and query-string safe. */
function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a fresh console token. */
export function generateRemoteToken(): string {
  return toBase64Url(randomBytes(TOKEN_BYTES));
}

/**
 * Constant-time comparison. False for any empty/absent value so an unset token
 * can never authenticate an empty candidate.
 */
export function verifyRemoteToken(expected: string | undefined | null, candidate: string | undefined | null): boolean {
  if (!expected || !candidate) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Create / rotate / verify the persisted token. `ensure()` is idempotent so the
 * QR panel, the status bar and the server can all ask for "the" token.
 */
export class RemoteTokenStore {
  private cached?: string;

  constructor(private readonly secrets: SecretStorageLike) {}

  /** Return the stored token, minting (and persisting) one when absent/stale. */
  async ensure(): Promise<string> {
    if (this.cached) {
      return this.cached;
    }
    let stored: string | undefined;
    try {
      stored = await this.secrets.get(REMOTE_TOKEN_SECRET_KEY);
    } catch {
      stored = undefined;
    }
    if (stored && stored.length >= MIN_TOKEN_LENGTH) {
      this.cached = stored;
      return stored;
    }
    return this.persist(generateRemoteToken());
  }

  /** Mint and persist a new token, invalidating the previous one immediately. */
  async rotate(): Promise<string> {
    this.cached = undefined;
    return this.persist(generateRemoteToken());
  }

  /** True when `candidate` matches the persisted token. Fails closed. */
  async verify(candidate: string | undefined | null): Promise<boolean> {
    if (!candidate) {
      return false;
    }
    let expected: string | undefined;
    try {
      expected = this.cached ?? (await this.secrets.get(REMOTE_TOKEN_SECRET_KEY));
    } catch {
      return false;
    }
    return verifyRemoteToken(expected, candidate);
  }

  /** The cached token, if it has been resolved in this session. */
  get current(): string | undefined {
    return this.cached;
  }

  private async persist(token: string): Promise<string> {
    this.cached = token;
    try {
      await this.secrets.store(REMOTE_TOKEN_SECRET_KEY, token);
    } catch {
      // A locked keyring must not take Remote Access down: the in-memory token
      // still works for this session, it just will not survive a reload.
    }
    return token;
  }
}

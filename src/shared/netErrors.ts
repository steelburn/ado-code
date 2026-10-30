/**
 * Network-error transparency for the extension host.
 *
 * Node's `fetch` (undici) reports *every* low-level network failure as the one
 * opaque string `TypeError: fetch failed` and hides the real reason on
 * `error.cause` (which is not enumerable and never part of `message`). Every
 * caller that surfaced `error.message` verbatim therefore showed users a bare
 * "fetch failed" — impossible to act on, and identical for a wrong base URL, a
 * DNS outage, a dead socket, a TLS-inspecting proxy and our own timeout.
 *
 * This module walks the cause chain and turns it into one actionable sentence
 * plus a "is a retry worth it?" verdict, so providers, the ADO client and the
 * chat UI all report the same thing.
 */

/** One link of an undici/Node network error's `cause` chain. */
export interface NetErrorLink {
  name?: string;
  message?: string;
  code?: string;
  errno?: number | string;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: number | string;
}

/** Low-level codes where a retry has a realistic chance of succeeding. */
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
]);

/**
 * TLS codes: permanent failures. Retrying is pointless, but the usual cause is
 * a TLS-inspecting corporate proxy whose root CA is not trusted, so the hint
 * matters more than the retry.
 */
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
]);

const MAX_CAUSE_DEPTH = 6;

export interface FetchFailureDescription {
  /** Actionable sentence: what failed, where, and what to check next. */
  message: string;
  /** Low-level code, when the cause chain exposed one. */
  code?: string;
  /** Retrying can plausibly succeed (network blip / server hiccup). */
  transient: boolean;
  /** The request hit our own timeout rather than failing on its own. */
  timedOut: boolean;
  /** Distinct cause-chain `name: message` strings, innermost first — for logs. */
  chain: string[];
}

function asLink(value: unknown): NetErrorLink | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const link: NetErrorLink = {};
  if (typeof v.name === 'string') link.name = v.name;
  if (typeof v.message === 'string') link.message = v.message;
  if (typeof v.code === 'string') link.code = v.code;
  if (typeof v.errno === 'number' || typeof v.errno === 'string') link.errno = v.errno;
  if (typeof v.syscall === 'string') link.syscall = v.syscall;
  if (typeof v.hostname === 'string') link.hostname = v.hostname;
  if (typeof v.address === 'string') link.address = v.address;
  if (typeof v.port === 'number' || typeof v.port === 'string') link.port = v.port;
  // `AggregateError` (undici's happy-eyeballs path) carries no code of its own;
  // the useful code/message sits on the first inner error.
  if (!link.code && Array.isArray(v.errors) && v.errors.length > 0) {
    const inner = asLink((v.errors as unknown[])[0]);
    if (inner) {
      link.code = inner.code;
      link.hostname = link.hostname ?? inner.hostname;
      if (inner.message && !/fetch failed/i.test(inner.message)) {
        link.message = inner.message;
      }
    }
  }
  return Object.keys(link).length > 0 ? link : undefined;
}

/** Walk `error.cause` (and nested `AggregateError`s) into a flat list. */
export function collectCauseChain(err: unknown): NetErrorLink[] {
  const chain: NetErrorLink[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const link = asLink(current);
    if (link) {
      chain.push(link);
    }
    if (!current || typeof current !== 'object') {
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** First code found anywhere in the chain, innermost preferred. */
function deepestCode(chain: NetErrorLink[]): string | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].code) {
      return chain[i].code;
    }
  }
  return undefined;
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** True when a proxy is configured in the environment (informational hint). */
function proxyEnvironmentHint(): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }
  const env = process.env;
  const name = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].find(
    key => !!env[key]
  );
  return name
    ? ` ${name} is set in the environment, but ADO Code does not tunnel through a proxy — a direct connection is required.`
    : undefined;
}

/** Message worth showing: skip undici's own "fetch failed" wrapper. */
function usefulMessage(chain: NetErrorLink[]): string | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const message = chain[i].message;
    if (message && !/^fetch failed$/i.test(message.trim())) {
      return message.trim();
    }
  }
  return undefined;
}

/**
 * Turn a thrown `fetch` error (or any error) into a user-facing description.
 * Never throws.
 */
export function describeFetchFailure(
  err: unknown,
  opts: { label: string; url?: string; timedOut?: boolean; timeoutMs?: number } = { label: 'Request' }
): FetchFailureDescription {
  const chain = collectCauseChain(err);
  const code = deepestCode(chain);
  const host = chain.map(link => link.hostname).find(Boolean) ?? hostFromUrl(opts.url);
  const port = chain.map(link => link.port).find(value => value !== undefined && value !== null);
  const where = host ? (port && !String(host).includes(':') ? `${host}:${port}` : host) : 'the server';
  const proxyHint = proxyEnvironmentHint();

  const detail = code ? ` (${code})` : '';
  const wrap = (reason: string, hint?: string, transient = false): FetchFailureDescription => ({
    message: `${opts.label} request failed: ${reason}${detail}.${hint ? ` ${hint}` : ''}${proxyHint ?? ''}`,
    code,
    transient,
    timedOut: !!opts.timedOut,
    chain: chain.map(link => [link.name, link.message].filter(Boolean).join(': ')).filter(Boolean),
  });

  if (opts.timedOut) {
    const seconds = opts.timeoutMs
      ? opts.timeoutMs >= 1000
        ? `${Math.round(opts.timeoutMs / 1000)}s`
        : `${opts.timeoutMs}ms`
      : undefined;
    return wrap(
      `no response from ${where} within ${seconds ? `${seconds}s` : 'the timeout'}`,
      'Check VPN/proxy/firewall, or raise the request timeout.',
      true
    );
  }

  switch (code) {
    case 'ENOTFOUND':
      return wrap(
        `DNS lookup failed for ${where}`,
        'The API base URL is wrong, or DNS/VPN is unavailable right now.'
      );
    case 'EAI_AGAIN':
      return wrap(`DNS lookup for ${where} failed temporarily`, 'DNS is unreachable — check the VPN/network.', true);
    case 'ECONNREFUSED':
      return wrap(
        `the connection to ${where} was refused`,
        'Nothing is listening there: is the gateway running, and is the port part of the base URL?'
      );
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return wrap(
        `the connection to ${where} timed out`,
        'A VPN, proxy or firewall is probably blocking it.',
        true
      );
    case 'ECONNRESET':
    case 'ECONNABORTED':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
    case 'UND_ERR_CLOSED':
      return wrap(`the connection to ${where} was closed mid-request`, 'Usually transient — retrying is safe.', true);
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENETDOWN':
      return wrap(`the network to ${where} is unreachable`, 'Check the VPN/network connection.', true);
    case 'EPROTO':
      return wrap(
        `the TLS handshake with ${where} failed`,
        'Usually an HTTPS-intercepting proxy or firewall.'
      );
    default:
      break;
  }

  if (code && TLS_CODES.has(code)) {
    return wrap(
      `TLS certificate verification failed for ${where}`,
      'Likely a TLS-inspecting corporate proxy: point NODE_EXTRA_CA_CERTS at its root CA.'
    );
  }

  const message = usefulMessage(chain);
  if (message) {
    return wrap(message, undefined, !!code && TRANSIENT_CODES.has(code));
  }

  // Nothing but undici's wrapper: say what we actually know.
  return wrap(
    `the request to ${where} could not be completed`,
    'Check the API base URL, the network/VPN, and any proxy in front of it.'
  );
}

/** True when `err` looks like a transient network failure worth retrying. */
export function isTransientNetworkError(err: unknown): boolean {
  const code = deepestCode(collectCauseChain(err));
  if (code) {
    return TRANSIENT_CODES.has(code);
  }
  // A bare undici wrapper with no code is most often a mid-flight socket drop.
  const chain = collectCauseChain(err);
  return chain.some(link => /fetch failed|socket|other side closed/i.test(link.message ?? ''));
}

/** Build the `Error` callers should throw, with the description attached. */
export function toFetchError(
  err: unknown,
  opts: { label: string; url?: string; timedOut?: boolean; timeoutMs?: number }
): Error {
  const failure = describeFetchFailure(err, opts);
  const error = new Error(failure.message);
  (error as Error & { cause?: unknown; code?: string; transient?: boolean }).cause = err;
  if (failure.code) {
    (error as Error & { code?: string }).code = failure.code;
  }
  (error as Error & { transient?: boolean }).transient = failure.transient;
  return error;
}

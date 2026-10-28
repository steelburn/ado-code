import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import {
  MAX_UPSTREAM_BODY_BYTES,
  parseUpstream,
  serializeEvent,
  type RemoteDownstreamEvent,
  type RemoteUpstreamKind,
} from '../shared/remoteProtocol';
import { CONSOLE_HTML } from './consolePage';
import { isLoopbackHost } from './remoteUrl';

/**
 * Loopback HTTP console server (R-P1-06).
 *
 * Transport: SSE downstream (server → console) + small POSTs upstream. SSE is
 * deliberate — no WebSocket dependency, works through every tunnel that proxies
 * HTTP, and reconnects on its own.
 *
 * Security model (P1):
 *  - binds `127.0.0.1` unless `adoCode.remote.bind === 'all'`;
 *  - **Host guard** defeats DNS rebinding: a request whose `Host` is neither a
 *    loopback name nor a private/LAN address is refused with 403;
 *  - the token is exchanged once (`POST /session`) for an `HttpOnly;
 *    SameSite=Strict` cookie; `/events` and every POST authenticate with that
 *    cookie only, so the token never rides in a URL or a `Referer`;
 *  - mutating routes (`/consent`, `/confirm`, `/cancel`) validate their body and
 *    then answer 501 in Phase 1 — the console can observe, not act.
 */

export const REMOTE_COOKIE_NAME = 'ado_code_remote';

/** SSE keep-alive; tunnels drop idle connections far sooner than the browser does. */
export const HEARTBEAT_MS = 15_000;

export interface RemoteServerOptions {
  /** Verify a candidate token (SecretStorage-backed, constant-time). */
  verifyToken: (candidate: string) => boolean | Promise<boolean>;
  /** Port to bind; 0 (default) lets the OS pick. */
  port?: number;
  bind?: 'loopback' | 'all';
  /** LAN host advertised for `bind: 'all'` — allowed through the Host guard. */
  lanAddress?: string | undefined;
  /** Console page source (injectable so tests can use a stub page). */
  page?: () => string;
  heartbeatMs?: number;
  logger?: { warn(message: string): void };
  /** Wired in P2/P3; absent in P1, where the routes answer 501. */
  onConsent?: (payload: { requestId: string; approved: boolean; scope?: string }) => Promise<{ status: number; body?: unknown }>;
  onConfirm?: (payload: { requestId: string; value?: string; approved?: boolean }) => Promise<{ status: number; body?: unknown }>;
  onCancel?: () => Promise<{ status: number; body?: unknown }>;
}

const PRIVATE_HOST = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export class RemoteServer {
  private server: Server | null = null;
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;
  private boundPort = 0;
  private boundHost = '';
  private disposed = false;

  constructor(private readonly options: RemoteServerOptions) {}

  /** The port actually bound (OS-assigned when `port: 0`). */
  get port(): number {
    return this.boundPort;
  }

  /** The interface actually bound (`127.0.0.1` unless `bind: 'all'`). */
  get host(): string {
    return this.boundHost;
  }

  /** Number of connected consoles. */
  get viewerCount(): number {
    return this.clients.size;
  }

  /** Start listening. Resolves with the bound port. */
  async start(): Promise<number> {
    if (this.server) {
      return this.boundPort;
    }
    if (this.disposed) {
      throw new Error('RemoteServer: cannot start after dispose');
    }
    const host = this.options.bind === 'all' ? '0.0.0.0' : '127.0.0.1';
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.on('clientError', (_error, socket) => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(this.options.port ?? 0, host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    this.server = server;
    this.boundHost = host;
    const address = server.address();
    this.boundPort = address && typeof address === 'object' ? address.port : 0;

    this.heartbeat = setInterval(() => this.ping(), this.options.heartbeatMs ?? HEARTBEAT_MS);
    // Never hold the extension host alive just for a keep-alive tick.
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();

    return this.boundPort;
  }

  /** Fan a downstream event out to every connected console. */
  broadcast(event: RemoteDownstreamEvent): void {
    const frame = `data: ${serializeEvent(event)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Stop listening and drop every open console connection. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  // ── request handling ──────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname = '/';
    try {
      const url = new URL(req.url ?? '/', 'http://remote.invalid');
      pathname = url.pathname;
    } catch {
      this.sendJson(res, 400, { error: 'bad request' });
      return;
    }

    if (!this.hostAllowed(req)) {
      this.sendJson(res, 403, { error: 'forbidden host' });
      return;
    }

    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'GET' && pathname === '/') {
        this.sendPage(res);
        return;
      }
      if (method === 'GET' && pathname === '/events') {
        await this.handleEvents(req, res);
        return;
      }
      if (method === 'POST' && pathname === '/session') {
        await this.handleSession(req, res);
        return;
      }
      if (method === 'POST' && (pathname === '/consent' || pathname === '/confirm' || pathname === '/cancel')) {
        const kind = pathname === '/cancel' ? ('cancel' as const) : (pathname.slice(1) as RemoteUpstreamKind);
        await this.handleMutation(kind, req, res);
        return;
      }
      this.sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      this.options.logger?.warn(`remote server: ${error instanceof Error ? error.message : String(error)}`);
      this.sendJson(res, 500, { error: 'internal error' });
    }
  }

  private sendPage(res: ServerResponse): void {
    const html = (this.options.page ?? ((): string => CONSOLE_HTML))();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // The page is fully inline: nothing may load, nothing may be framed.
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  private async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req, res);
    if (body === null) {
      return;
    }
    const parsed = parseUpstream('session', body);
    if (!parsed.ok || parsed.value.kind !== 'session') {
      this.sendJson(res, 400, { error: parsed.ok ? 'unexpected payload' : parsed.error });
      return;
    }
    let valid = false;
    try {
      valid = await this.options.verifyToken(parsed.value.value.t);
    } catch {
      valid = false;
    }
    if (!valid) {
      this.sendJson(res, 401, { error: 'invalid token' });
      return;
    }
    const attributes = [
      `${REMOTE_COOKIE_NAME}=${encodeURIComponent(parsed.value.value.t)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
    ];
    if (this.isSecureRequest(req)) {
      attributes.push('Secure');
    }
    res.writeHead(204, {
      'Set-Cookie': attributes.join('; '),
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  private async handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(await this.authorized(req))) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    this.clients.add(res);
    this.publishViewerCount();

    const cleanup = (): void => {
      if (this.clients.delete(res)) {
        this.publishViewerCount();
      }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  private async handleMutation(
    kind: RemoteUpstreamKind | 'cancel',
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (!(await this.authorized(req))) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // /cancel carries no payload — nothing to validate, nothing to read.
    if (kind === 'cancel') {
      if (!this.options.onCancel) {
        this.sendJson(res, 501, { error: 'not available — approvals stay on the host in this version' });
        return;
      }
      const cancelled = await this.options.onCancel();
      this.sendJson(res, cancelled.status, cancelled.body ?? { ok: cancelled.status < 400 });
      return;
    }

    const body = await this.readBody(req, res);
    if (body === null) {
      return;
    }
    const parsed = parseUpstream(kind, body);
    if (!parsed.ok) {
      this.sendJson(res, 400, { error: parsed.error });
      return;
    }

    const handler = kind === 'consent' ? this.options.onConsent : this.options.onConfirm;
    if (!handler) {
      this.sendJson(res, 501, { error: 'not available — approvals stay on the host in this version' });
      return;
    }
    const result =
      kind === 'consent'
        ? await (handler as NonNullable<RemoteServerOptions['onConsent']>)(parsed.value.value as never)
        : await (handler as NonNullable<RemoteServerOptions['onConfirm']>)(parsed.value.value as never);
    this.sendJson(res, result.status, result.body ?? { ok: result.status < 400 });
  }

  private async authorized(req: IncomingMessage): Promise<boolean> {
    const candidate = this.readCookie(req, REMOTE_COOKIE_NAME);
    if (!candidate) {
      return false;
    }
    try {
      return await this.options.verifyToken(candidate);
    } catch {
      return false;
    }
  }

  /** DNS-rebinding guard: only loopback, private-range or the LAN address may answer. */
  private hostAllowed(req: IncomingMessage): boolean {
    const header = req.headers.host;
    if (!header) {
      return false;
    }
    const host = stripPort(header);
    if (isLoopbackHost(host)) {
      return true;
    }
    if (PRIVATE_HOST.test(host)) {
      return true;
    }
    const lan = this.options.lanAddress?.trim().toLowerCase();
    if (lan && host.toLowerCase() === lan) {
      return true;
    }
    if (this.options.bind === 'all' && (host === '0.0.0.0' || host === '[::]' || host === '::')) {
      return true;
    }
    return false;
  }

  /** Secure cookies where the browser can honour them (loopback or https). */
  private isSecureRequest(req: IncomingMessage): boolean {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
    if (proto === 'https') {
      return true;
    }
    const header = req.headers.host ?? '';
    return isLoopbackHost(stripPort(header));
  }

  private readCookie(req: IncomingMessage, name: string): string | null {
    const raw = req.headers.cookie;
    if (!raw) {
      return null;
    }
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) {
        continue;
      }
      if (part.slice(0, separator).trim() !== name) {
        continue;
      }
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return null;
  }

  /** Read a bounded JSON body; `null` means a response was already sent. */
  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    return new Promise<unknown | null>((resolve) => {
      let settled = false;
      const finish = (value: unknown | null): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_UPSTREAM_BODY_BYTES) {
          this.sendJson(res, 413, { error: 'payload too large' });
          req.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        this.sendJson(res, 400, { error: 'bad request' });
        finish(null);
      });
      req.on('end', () => {
        if (settled) {
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) {
          this.sendJson(res, 400, { error: 'empty body' });
          finish(null);
          return;
        }
        try {
          finish(JSON.parse(text));
        } catch {
          this.sendJson(res, 400, { error: 'malformed JSON' });
          finish(null);
        }
      });
    });
  }

  private publishViewerCount(): void {
    this.broadcast({ type: 'viewerCount', count: this.clients.size });
  }

  private ping(): void {
    for (const client of [...this.clients]) {
      try {
        client.write(': ping\n\n');
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) {
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

/** Strip the port (and IPv6 brackets) from a Host header. */
function stripPort(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0 && trimmed.indexOf(':') === colon) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

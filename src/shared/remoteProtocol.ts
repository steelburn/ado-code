/**
 * Remote Agent Oversight — wire protocol (R-P1-01).
 *
 * Shared by the extension host (RemoteServer / RemoteControl), by the headless
 * suites and by nothing else: this module is deliberately **vscode-free** so it
 * can be unit-tested outside the extension host.
 *
 * Direction glossary:
 *   downstream = extension host → console page (SSE `data:` frames)
 *   upstream   = console page → extension host (POST bodies)
 *
 * Every validator returns a discriminated result and never throws on bad input:
 * the HTTP layer turns `{ ok: false }` into a 400 and a server that throws on a
 * hostile payload is a denial-of-service vector.
 */

import type { AgentRun } from '../agents/types';

/** Structural mirror of AgentRun so the protocol keeps a type-only vscode-free edge. */
export type AgentRunLike = AgentRun;

/** Protocol revision — bump when a payload shape changes incompatibly. */
export const REMOTE_PROTOCOL_VERSION = 1;

/** Longest request id we accept from a console; guards memory and logs. */
export const MAX_REQUEST_ID_LENGTH = 128;

/** Largest upstream body we will buffer (bytes) before rejecting with 413/400. */
export const MAX_UPSTREAM_BODY_BYTES = 16 * 1024;

/** Consent scopes — parity with the webview's `consentResponse.scope`. */
export type RemoteConsentScope = 'once' | 'session' | 'permanent';

export const REMOTE_CONSENT_SCOPES: readonly RemoteConsentScope[] = ['once', 'session', 'permanent'];

export interface RemoteAgentStatusEvent {
  type: 'agentStatus';
  run: AgentRunLike;
  delta: string;
}

export interface RemoteAgentResultEvent {
  type: 'agentResult';
  run: AgentRunLike;
  summary: string;
}

export interface RemoteConsentRequestEvent {
  type: 'consentRequest';
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  autoApproveMs?: number;
  expiresAt?: number;
}

export interface RemoteConfirmationOption {
  label: string;
  value: string;
  isDangerous?: boolean;
}

export interface RemoteConfirmationRequestEvent {
  type: 'confirmationRequest';
  requestId: string;
  title: string;
  description: string;
  options: RemoteConfirmationOption[];
  expiresAt?: number;
}

export interface RemoteViewerCountEvent {
  type: 'viewerCount';
  count: number;
}

export type RemoteApprovalOutcome = 'approved' | 'denied' | 'expired';

/**
 * A pending approval left the host's decision table: answered in VS Code,
 * answered on another console, or expired. Every console drops the card on
 * this frame instead of keeping a button that can no longer land.
 */
export interface RemoteApprovalResolvedEvent {
  type: 'approvalResolved';
  requestId: string;
  outcome: RemoteApprovalOutcome;
  source: 'host' | 'remote';
}

export type RemoteDownstreamEvent =
  | RemoteAgentStatusEvent
  | RemoteAgentResultEvent
  | RemoteConsentRequestEvent
  | RemoteConfirmationRequestEvent
  | RemoteApprovalResolvedEvent
  | RemoteViewerCountEvent;

/** Upstream endpoint kinds map 1:1 onto the POST routes. */
export type RemoteUpstreamKind = 'session' | 'consent' | 'confirm';

export interface RemoteSessionRequest {
  /** Fragment token exchanged for the session cookie. */
  t: string;
}

export interface RemoteConsentRequest {
  requestId: string;
  approved: boolean;
  scope?: RemoteConsentScope;
}

/**
 * The host's confirmation flow is option-based (`confirmationResponse.value`),
 * so the console may answer with `value`; `approved` is accepted as the
 * boolean shorthand for option lists that model yes/no.
 */
export interface RemoteConfirmRequest {
  requestId: string;
  value?: string;
  approved?: boolean;
}

export type RemoteUpstreamPayload =
  | { kind: 'session'; value: RemoteSessionRequest }
  | { kind: 'consent'; value: RemoteConsentRequest }
  | { kind: 'confirm'; value: RemoteConfirmRequest };

export type RemoteParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Serialize a downstream event into one SSE `data:` payload (no framing). */
export function serializeEvent(event: RemoteDownstreamEvent): string {
  return JSON.stringify(event);
}

/**
 * Parse + validate one downstream frame. Accepts the raw JSON string so the
 * console page and the host suites share one code path.
 */
export function parseDownstream(input: unknown): RemoteParseResult<RemoteDownstreamEvent> {
  const decoded = decode(input);
  if (!decoded.ok) {
    return decoded;
  }
  const body = decoded.value;
  if (!isRecord(body)) {
    return reject('payload must be an object');
  }
  switch (body.type) {
    case 'agentStatus': {
      if (!isRecord(body.run)) {
        return reject('agentStatus.run must be an object');
      }
      if (typeof body.delta !== 'string') {
        return reject('agentStatus.delta must be a string');
      }
      return { ok: true, value: { type: 'agentStatus', run: body.run as unknown as AgentRunLike, delta: body.delta } };
    }
    case 'agentResult': {
      if (!isRecord(body.run)) {
        return reject('agentResult.run must be an object');
      }
      if (typeof body.summary !== 'string') {
        return reject('agentResult.summary must be a string');
      }
      return { ok: true, value: { type: 'agentResult', run: body.run as unknown as AgentRunLike, summary: body.summary } };
    }
    case 'consentRequest': {
      const requestId = readId(body.requestId);
      if (requestId === null) {
        return reject('consentRequest.requestId must be a short non-empty string');
      }
      if (typeof body.tool !== 'string' || !body.tool) {
        return reject('consentRequest.tool must be a non-empty string');
      }
      if (!isRecord(body.args)) {
        return reject('consentRequest.args must be an object');
      }
      const event: RemoteConsentRequestEvent = {
        type: 'consentRequest',
        requestId,
        tool: body.tool,
        args: body.args,
      };
      const autoApproveMs = readOptionalNumber(body.autoApproveMs);
      if (autoApproveMs !== undefined) {
        event.autoApproveMs = autoApproveMs;
      }
      const expiresAt = readOptionalNumber(body.expiresAt);
      if (expiresAt !== undefined) {
        event.expiresAt = expiresAt;
      }
      return { ok: true, value: event };
    }
    case 'confirmationRequest': {
      const requestId = readId(body.requestId);
      if (requestId === null) {
        return reject('confirmationRequest.requestId must be a short non-empty string');
      }
      if (typeof body.title !== 'string') {
        return reject('confirmationRequest.title must be a string');
      }
      if (typeof body.description !== 'string') {
        return reject('confirmationRequest.description must be a string');
      }
      if (!Array.isArray(body.options) || body.options.length === 0) {
        return reject('confirmationRequest.options must be a non-empty array');
      }
      const options: RemoteConfirmationOption[] = [];
      for (const raw of body.options) {
        if (!isRecord(raw) || typeof raw.label !== 'string' || typeof raw.value !== 'string') {
          return reject('confirmationRequest.options[] must be { label, value }');
        }
        const option: RemoteConfirmationOption = { label: raw.label, value: raw.value };
        if (typeof raw.isDangerous === 'boolean') {
          option.isDangerous = raw.isDangerous;
        }
        options.push(option);
      }
      const event: RemoteConfirmationRequestEvent = {
        type: 'confirmationRequest',
        requestId,
        title: body.title,
        description: body.description,
        options,
      };
      const expiresAt = readOptionalNumber(body.expiresAt);
      if (expiresAt !== undefined) {
        event.expiresAt = expiresAt;
      }
      return { ok: true, value: event };
    }
    case 'viewerCount': {
      const count = readOptionalNumber(body.count);
      if (count === undefined || count < 0 || !Number.isInteger(count)) {
        return reject('viewerCount.count must be a non-negative integer');
      }
      return { ok: true, value: { type: 'viewerCount', count } };
    }
    case 'approvalResolved': {
      const requestId = readId(body.requestId);
      if (requestId === null) {
        return reject('approvalResolved.requestId must be a short non-empty string');
      }
      const outcome = body.outcome;
      if (outcome !== 'approved' && outcome !== 'denied' && outcome !== 'expired') {
        return reject('approvalResolved.outcome must be approved | denied | expired');
      }
      const source = body.source;
      if (source !== 'host' && source !== 'remote') {
        return reject('approvalResolved.source must be host | remote');
      }
      return { ok: true, value: { type: 'approvalResolved', requestId, outcome, source } };
    }
    default:
      return reject(`unknown event type: ${String(body.type)}`);
  }
}

/**
 * Parse + validate one upstream POST body against its endpoint kind.
 * `input` may be a raw string (the bytes off the socket) or a parsed object.
 */
export function parseUpstream(kind: RemoteUpstreamKind, input: unknown): RemoteParseResult<RemoteUpstreamPayload> {
  const decoded = decode(input);
  if (!decoded.ok) {
    return decoded;
  }
  const body = decoded.value;
  if (!isRecord(body)) {
    return reject('payload must be an object');
  }

  switch (kind) {
    case 'session': {
      const token = typeof body.t === 'string' ? body.t.trim() : '';
      if (!token) {
        return reject('session.t must be a non-empty string');
      }
      return { ok: true, value: { kind: 'session', value: { t: token } } };
    }
    case 'consent': {
      const requestId = readId(body.requestId);
      if (requestId === null) {
        return reject('consent.requestId must be a short non-empty string');
      }
      if (typeof body.approved !== 'boolean') {
        return reject('consent.approved must be a boolean');
      }
      const value: RemoteConsentRequest = { requestId, approved: body.approved };
      if (body.scope !== undefined) {
        if (typeof body.scope !== 'string' || !REMOTE_CONSENT_SCOPES.includes(body.scope as RemoteConsentScope)) {
          return reject(`consent.scope must be one of ${REMOTE_CONSENT_SCOPES.join('|')}`);
        }
        value.scope = body.scope as RemoteConsentScope;
      }
      return { ok: true, value: { kind: 'consent', value } };
    }
    case 'confirm': {
      const requestId = readId(body.requestId);
      if (requestId === null) {
        return reject('confirm.requestId must be a short non-empty string');
      }
      const value: RemoteConfirmRequest = { requestId };
      let hasAnswer = false;
      if (body.value !== undefined) {
        if (typeof body.value !== 'string') {
          return reject('confirm.value must be a string');
        }
        value.value = body.value;
        hasAnswer = true;
      }
      if (body.approved !== undefined) {
        if (typeof body.approved !== 'boolean') {
          return reject('confirm.approved must be a boolean');
        }
        value.approved = body.approved;
        hasAnswer = true;
      }
      if (!hasAnswer) {
        return reject('confirm requires value or approved');
      }
      return { ok: true, value: { kind: 'confirm', value } };
    }
    default:
      return reject(`unknown upstream kind: ${String(kind)}`);
  }
}

// ── internals ──────────────────────────────────────────────────────────

function decode(input: unknown): RemoteParseResult<unknown> {
  if (typeof input !== 'string') {
    return { ok: true, value: input };
  }
  const text = input.trim();
  if (!text) {
    return reject('empty body');
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return reject('malformed JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }
  return trimmed;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function reject(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

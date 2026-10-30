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

/**
 * The host's own chat turn — the built-in agentic loop — as opposed to a
 * delegated CLI run. A turn produces no AgentRun, so `agentStatus` alone left
 * the console looking idle while the machine was streaming and calling tools.
 */
export interface RemoteTurnInfo {
  /** Session the turn belongs to. */
  sessionId: string;
  /** Session name, or the generating label when the session has none yet. */
  title: string;
  /** Epoch ms the turn started — the console runs its own elapsed clock. */
  startedAt: number;
  /** True while the turn keeps running although another session is on screen. */
  background: boolean;
}

/**
 * One mirrored chat message (R-P1-09).
 *
 * The console mirrors the chat thread the desktop webview is showing so the
 * phone can follow the conversation instead of only the approval cards. Only
 * what a reader needs travels: the role, the text, and — when the assistant
 * offered a choice — the parsed options, so the phone renders real buttons
 * instead of a raw ```choice fence. Reasoning traces and tool cards stay in the
 * webview: they are noise on a phone and would multiply the payload.
 */
export interface RemoteTranscriptChoice {
  question: string;
  options: string[];
}

export interface RemoteTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Message text with any ```choice fence already removed. */
  content: string;
  choice?: RemoteTranscriptChoice;
}

/** Full transcript — replay on connect, and after a reset (session switch). */
export interface RemoteTranscriptEvent {
  type: 'transcript';
  sessionId: string | null;
  messages: RemoteTranscriptMessage[];
}

/** One message appeared or was finalized (assistant answer done). */
export interface RemoteTranscriptMessageEvent {
  type: 'transcriptMessage';
  message: RemoteTranscriptMessage;
}

/** The streaming assistant message grew by `delta`. */
export interface RemoteTranscriptDeltaEvent {
  type: 'transcriptDelta';
  id: string;
  delta: string;
}

export interface RemoteTurnStatusEvent {
  type: 'turnStatus';
  /** null once the turn finished, failed or was stopped. */
  turn: RemoteTurnInfo | null;
}

export type RemoteDownstreamEvent =
  | RemoteAgentStatusEvent
  | RemoteAgentResultEvent
  | RemoteTurnStatusEvent
  | RemoteConsentRequestEvent
  | RemoteConfirmationRequestEvent
  | RemoteApprovalResolvedEvent
  | RemoteViewerCountEvent
  | RemoteTranscriptEvent
  | RemoteTranscriptMessageEvent
  | RemoteTranscriptDeltaEvent
  | RemotePlanEvent;

/**
 * The session plan: the goal the work is meant to achieve plus the to-do list
 * the agent keeps while it works (R-P1-11).
 *
 * Same two surfaces the desktop's To-do view shows. A phone that joins
 * mid-turn has to see what the machine is DOING, not only what it is asking —
 * goal and to-dos are the cheapest honest answer to "what is going on?".
 *
 * `goal` is '' when the session has none yet; `todos` is [] rather than
 * undefined, so the console renders "no plan yet" without a special case.
 */
export interface RemotePlanTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-participle label the desktop shows while the item runs. */
  activeForm?: string;
}

export interface RemotePlanEvent {
  type: 'plan';
  /** Session the plan belongs to; null when no session is active. */
  sessionId: string | null;
  goal: string;
  todos: RemotePlanTodo[];
  total: number;
  completed: number;
  inProgress: number;
}

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
    case 'turnStatus': {
      if (body.turn === null) {
        return { ok: true, value: { type: 'turnStatus', turn: null } };
      }
      if (!isRecord(body.turn)) {
        return reject('turnStatus.turn must be an object or null');
      }
      const sessionId = readId(body.turn.sessionId);
      if (sessionId === null) {
        return reject('turnStatus.turn.sessionId must be a non-empty string');
      }
      if (typeof body.turn.title !== 'string') {
        return reject('turnStatus.turn.title must be a string');
      }
      if (typeof body.turn.startedAt !== 'number' || !Number.isFinite(body.turn.startedAt)) {
        return reject('turnStatus.turn.startedAt must be a finite number');
      }
      return {
        ok: true,
        value: {
          type: 'turnStatus',
          turn: {
            sessionId,
            title: body.turn.title.slice(0, MAX_REQUEST_ID_LENGTH),
            startedAt: body.turn.startedAt,
            background: body.turn.background === true,
          },
        },
      };
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
    case 'transcript': {
      const sessionId = body.sessionId === null || body.sessionId === undefined ? null : readId(body.sessionId);
      if (!Array.isArray(body.messages)) {
        return reject('transcript.messages must be an array');
      }
      const messages: RemoteTranscriptMessage[] = [];
      for (const raw of body.messages) {
        const message = readTranscriptMessage(raw);
        if (!message) {
          return reject('transcript.messages[] entries must be { id, role, content }');
        }
        messages.push(message);
      }
      return { ok: true, value: { type: 'transcript', sessionId, messages } };
    }
    case 'transcriptMessage': {
      const message = readTranscriptMessage(body.message);
      if (!message) {
        return reject('transcriptMessage.message must be { id, role, content }');
      }
      return { ok: true, value: { type: 'transcriptMessage', message } };
    }
    case 'transcriptDelta': {
      const id = readId(body.id);
      if (id === null) {
        return reject('transcriptDelta.id must be a non-empty string');
      }
      if (typeof body.delta !== 'string') {
        return reject('transcriptDelta.delta must be a string');
      }
      return { ok: true, value: { type: 'transcriptDelta', id, delta: body.delta } };
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

function readTranscriptMessage(value: unknown): RemoteTranscriptMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readId(value.id);
  if (id === null) {
    return null;
  }
  if (value.role !== 'user' && value.role !== 'assistant') {
    return null;
  }
  if (typeof value.content !== 'string') {
    return null;
  }
  const message: RemoteTranscriptMessage = { id, role: value.role, content: value.content };
  const choice = value.choice;
  if (isRecord(choice) && typeof choice.question === 'string' && Array.isArray(choice.options)) {
    const options = choice.options.filter((option): option is string => typeof option === 'string');
    if (options.length > 0) {
      message.choice = { question: choice.question, options };
    }
  }
  return message;
}

function reject(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

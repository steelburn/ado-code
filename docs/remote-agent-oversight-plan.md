# Remote Agent Oversight — Implementation Plan (P1 / P2 / P3 / P4)

> Status: **design locked, not started** · Target: `## [Unreleased]` (no version bump) · Owner: TBD
> Scope: includes **remote chat & sessions** (Phase 4). P1–P3 are unchanged except where noted.

## Feature summary

An opt-in, loopback HTTP console that lets a browser/phone **observe agent runs**, **answer the
consent/confirmation prompts the host already raised**, and (from Phase 4) **drive the assistant chat
and manage chat sessions** remotely. No remote file access and no new privilege: remote chat uses the
*same* consent/tool-approval path as the local webview and cannot enable auto-approve, push, or settings
writes. Reuses the existing `agentStatus` / `consentRequest` / chat message vocabulary so there is
exactly one consent state machine and one chat controller.

**Remote chat & sessions (Phase 4) ride the same transport:** `POST /chat/send` + `POST /chat/cancel`
upstream, streamed `chatDelta` / tool events downstream over the **existing SSE stream** — no WebSocket,
no new runtime dependency. Both the local webview and remote viewers are driven by **one extracted
`ChatController`**, so they share a single conversation and a single consent path.

**Architecture**

```
Phone/browser ──HTTP──▶ RemoteServer (extension host, 127.0.0.1)
   ▲   │  GET /events (SSE)          │  POST /consent {requestId, approved, scope}
   │   └──────── stream ◀────────────┘        │
   │                                           ▼
   │                            ChatViewProvider.respondToConsent(...)   ← single source of truth
   │                                           ▼
   │                                    consentBroker.resolve(...)
   │ AgentRunner.onStatus/onComplete ──▶ RemoteServer.broadcast(agentStatus/agentResult)

Public reachability:  vscode.env.asExternalUri  →  cloudflared quick tunnel (opt-in)  →  custom template
```

## Ground rules (apply to every item)

| Rule | Detail |
|---|---|
| **TDD** | Failing test first, verify RED, implement, verify GREEN. No item is Done without its tests. |
| **No version bump** | Work lands under `## [Unreleased]` in `CHANGELOG.md`. `package.json` version untouched. |
| **Zero runtime deps** | `dependencies: {}` stays empty. QR encoder is vendored; tunnel binaries are *discovered*, never bundled. |
| **Node-only** | No `browser` entry. Feature is gated on `vscode.env.uiKind === Desktop`. |
| **`extensionKind: ["workspace"]`** | Server must run on the forwarded (remote/container) side. |
| **Test harness** | Headless: `node node_modules/mocha/bin/mocha.js --ui tdd --require ./scripts/vscode-stub.js --timeout 20000 "<glob>"`. Socket/timer suites require `--timeout 20000`. |
| **Security invariants** | Loopback default; Host/Origin guard; token from `SecretStorage`; fragment→HttpOnly/Secure/SameSite=Strict cookie; rotate-on-start; child killed on dispose. |
| **Chat is not a privilege escalation** | Remote chat resolves tool calls through the same `respondToConsent` path; remote can **never** enable auto-approve/YOLO, push, or write settings. |

## Definition of Done (global)

- [ ] Tests written first, seen failing, then passing (mocha headless + `npm test` for any Electron-touching bits).
- [ ] `npm run compile` clean; no new lint errors introduced beyond the 5 pre-existing.
- [ ] No new `dependencies` entries.
- [ ] `CHANGELOG.md` `## [Unreleased]` entry added.
- [ ] Settings/commands contributed in `package.json` with `scope: "machine"` for state-bearing settings.
- [ ] `dispose()` / `deactivate()` leaves no listening socket and no child process.

---

## Phase 1 — View-only console, toggle, QR, tunnel

**Phase goal:** a user can turn remote access on from any of three surfaces, see a QR, scan it, and watch
live agent status from a phone. Nothing can be *approved* yet.

| ID | Work item | Blocked by | Size |
|---|---|---|---|
| R-P1-01 | `remoteProtocol` wire types + validators | — | S |
| R-P1-02 | `remoteToken` (generate / verify / SecretStorage) | — | S |
| R-P1-03 | `qrcode` vendored MIT encoder + SVG | — | M |
| R-P1-04 | `remoteUrl` resolution + classification + `uiKind` gate | — | M |
| R-P1-05 | `RemoteTunnel` provider shell (`none` / `cloudflared` / `custom`) | R-P1-04 | L |
| R-P1-06 | `RemoteServer` (SSE + session exchange + Host guard) | R-P1-01, R-P1-02 | L |
| R-P1-07 | Mobile console page | R-P1-06 | M |
| R-P1-08 | `RemoteControl` status bar + commands + config listener | R-P1-04, R-P1-05, R-P1-06 | L |
| R-P1-09 | STATUS tree node "Remote Access" | R-P1-08 | S |
| R-P1-10 | `RemoteQrPanel` (+ local-only banner, manual link) | R-P1-03, R-P1-04, R-P1-08 | M |
| R-P1-11 | `extension.ts` wiring + `package.json` contributions | R-P1-08 | M |
| R-P1-12 | P1 docs + CHANGELOG | all P1 | S |

### R-P1-01 — `src/shared/remoteProtocol.ts`

Shared, **vscode-free** wire types + validators so they are headless-testable.

**Acceptance criteria**
- Defines downstream event payloads reusing existing shapes: `agentStatus`, `agentResult`,
  `consentRequest`, `confirmRequest`, plus `viewerCount`.
- Defines upstream request shapes: `POST /session {t}`, `POST /consent {requestId, approved, scope}`,
  `POST /confirm {requestId, approved}`.
- `parseUpstream(kind, body)` returns a discriminated result; **rejects** malformed/unknown payloads
  with a typed error (never throws raw).
- No `import * as vscode` anywhere in the file.

**Tests first** — `src/test/suite/shared/remoteProtocol.test.ts`
- Round-trip: each downstream payload serializes/deserializes losslessly.
- Malformed JSON, missing fields, wrong `scope` enum, oversized `requestId` → rejected, no throw.
- Type-only import of `messages.ts` types does not pull in `vscode`.

### R-P1-02 — `src/remote/remoteToken.ts`

**Acceptance criteria**
- `generateToken()` → 256-bit from `crypto.randomBytes`, URL-fragment-safe (base64url).
- `verify(candidate, expected)` uses `crypto.timingSafeEqual`; handles length mismatch without throwing.
- Stored/retrieved via `context.secrets` only; **never** written to settings or `globalState`.
- `rotate()` generates + stores + returns new token.

**Tests first** — `remoteToken.test.ts` (fake `secrets`): token entropy/length; correct token passes;
wrong token fails; length-mismatch fails safely; `rotate()` changes value and only `secrets.store` is called.

### R-P1-03 — `src/shared/qrcode.ts`

**Acceptance criteria**
- Vendored MIT encoder (nayuki `qrcodegen` style), pure computation, **no `vscode` import**.
- `toSvg(text)` returns well-formed SVG; quiet zone present; version auto-selected by length.
- Deterministic output for identical input.

**Tests first** — `shared/qrcode.test.ts`: known-string matrix snapshot; `toSvg` parses as XML;
long URL selects a larger version; empty input handled.

### R-P1-04 — `src/remote/remoteUrl.ts`

**Acceptance criteria**
- `resolve(port, token)` implements the order: `uiKind !== Desktop` → unavailable; else
  `asExternalUri(loopback)` classified as **external** (host ≠ loopback) or **local-only**
  (host === loopback); if local-only **and** tunnel active → tunnel URL; else loopback/LAN.
- Returns a discriminated result (`{kind:'external'|'tunnel'|'local'|'unavailable', url, message}`) —
  **never throws**.
- `remoteName` used for messaging only, never for gating.

**Tests first** — `remoteUrl.test.ts`: matrix for desktop-local ("local only"), Codespaces mock
(external), `uiKind: Web` (unavailable), tunnel-active (tunnel), `asExternalUri` rejection (degrades to
local, no throw).

### R-P1-05 — `src/remote/RemoteTunnel.ts`

**Acceptance criteria**
- DI `spawnFn = cp.spawn`; spawns through `resolveSpawn()` so Windows `.cmd` shims work.
- Providers: `cloudflared` → `tunnel --url http://127.0.0.1:{port} --no-autoupdate`;
  `custom` → user template with `{port}` substitution.
- Scrapes **stderr and stdout**; `onUrl` fires **exactly once**; non-URL lines ignored.
- Missing binary → actionable `onError`, no crash.
- `dispose()` kills the process tree (Windows `taskkill /T /F`), idempotent.

**Tests first** — `remoteTunnel.test.ts`: canned stderr URL → single `onUrl`; `{port}` substitution;
custom URL regex; missing binary → `onError` only; `dispose()` asserts kill called; double-dispose safe.

### R-P1-06 — `src/remote/RemoteServer.ts`

**Acceptance criteria**
- Binds `127.0.0.1` by default; non-loopback bind requires `adoCode.remote.bind === 'all'` **and** logs
  a warning.
- Routes: `GET /` (console), `GET /events` (SSE, `text/event-stream`), `GET /session` (cookie
  liveness probe — mints nothing), `POST /session` (fragment token →
  HttpOnly/Secure/SameSite=Strict cookie), `GET /pending` (open approvals, read-only —
  the SSE stream has no replay), `POST /consent`, `POST /confirm`, `POST /cancel`.
- **Host/Origin guard** rejects foreign hosts; cookie auth required on `/events` and all POSTs.
- `broadcast(event)` fans out to all SSE clients; viewer connect/disconnect updates a count and emits
  `viewerCount`.
- `dispose()` closes the server + all SSE sockets; port released. `port: 0` → OS-assigned, reported back.

**Tests first** — `remoteServer.test.ts` (`--timeout 20000`, real sockets): loopback default; foreign
Host → 403; unauthenticated `/events` → 401; valid fragment → cookie set with `HttpOnly; Secure;
SameSite=Strict`; SSE connect/disconnect toggles count; `dispose()` frees the port; malformed POST body →
400 via protocol validator.

### R-P1-07 — Mobile console page (`src/remote/console.html` + `console.js`)

**Acceptance criteria**
- Standalone, dependency-free page (no framework, no CDN — survives a tunnel interstitial).
- Reads fragment token, `POST /session`, then subscribes to `GET /events` via `EventSource`
  (cookie-authenticated).
- Renders run list + live status; **no action buttons** in P1.
- Mobile-first layout.

**Tests first** — `remoteConsole.test.ts`: HTML contains no external asset references; the fragment token
is not appended to any request URL except `/session`; static parse of the JS asserts `EventSource` usage
and no `localStorage` token persistence.

### R-P1-08 — `src/remote/RemoteControl.ts`

**Acceptance criteria**
- Status bar item at `StatusBarAlignment.Right, 98`; Off `$(radio-tower)` / On `$(broadcast)` + device
  count / Error `$(error)` + `warningBackground`; tooltip carries `command:` links to
  `showQr · copyUrl · rotateToken · stop`.
- Single source of truth = `adoCode.remote.enabled`; **one** `onDidChangeConfiguration` listener
  reconciles server + tunnel and republishes state; reconciling is serialized behind an in-flight
  promise (no interleaved start/stop).
- Commands: `toggle`, `showQr`, `copyUrl`, `rotateToken`, `tunnel.start` (`QuickPick` with
  **cloudflared first + `activeItem`**).
- `offeredThisSession` flag + reentrancy guard for the tunnel offer.
- Port-in-use/bind failure → Error state, setting **stays** `true`, `showErrorMessage`, one-click retry.
- `dispose()` stops server + tunnel, disposes listener/status item, clears `hasRemoteViewer`.

**Tests first** — `remoteControl.test.ts` (fake vscode): toggle writes `Global` and reconciles exactly
once; context key flips; status text/icon/color transitions; listener idempotent (no double `start()`);
QuickPick first item is cloudflared and `activeItem`; missing cloudflared → no spawn; `dispose()` tears
down all.

### R-P1-09 — STATUS tree node

**Acceptance criteria**
- `StatusPanelProvider.getChildren()` appends `Remote Access: On/Off` using the existing `StatusItem`
  idiom; icon `broadcast`/`radio-tower`; description = device count when on; `contextValue`
  `remoteAccessOn|Off`.
- Inline `view/item/context` buttons per state (`toggle` off/on, `showQr` on), mirroring the
  `todoItemNode` entries.
- Refreshes via `debouncedRefresh()` after a toggle.

**Tests first** — `statusPanelRemote.test.ts`: node present; `contextValue` maps correctly from the
setting; description reflects count.

### R-P1-10 — `src/remote/RemoteQrPanel.ts`

**Acceptance criteria**
- `createWebviewPanel(..., { enableScripts: false, enableCommandUris: true, retainContextWhenHidden: true })`.
- Encodes the **resolved** URL (never raw loopback when a tunnel/external URL exists).
- Local-only mode shows a "Local only — no public URL" banner + persistent
  `command:adoCode.remote.tunnel.start` link.
- Subscribes to resolved-URL changes and **re-renders in place** (no second open).
- **Auto-offer rule:** on open, if classification is local-only **and** `tunnel === 'none'` **and**
  `enabled` **and** not already offered this session **and** no picker in flight → fire the tunnel
  QuickPick **after** the panel renders.

**Tests first** — `remoteQrPanel.test.ts`: external → no QuickPick; local-only + `none` → exactly one
QuickPick, cloudflared `activeItem`; already-tunneled → none; second open after dismissal → none (session
flag); in-flight → no second picker; `setUrl`/html updates on `onUrl`.

### R-P1-11 — `extension.ts` + `package.json`

**Acceptance criteria**
- `RemoteControl` constructed after `AgentRunner` + `chatProvider`; `AgentRunner.onStatus`/`onComplete`
  fan out to `RemoteServer.broadcast`; startup reconciles once; pushed to `context.subscriptions`.
- `package.json`: `"extensionKind": ["workspace"]`; settings
  `adoCode.remote.{enabled=false, bind=loopback, port=0, tunnel=none, tunnelCommand, tunnelUrlPattern}`
  all `scope:"machine"`; 5 commands; `view/item/context` entries.

**Tests first** — `remoteWiring.test.ts`: settings declared with `machine` scope and correct defaults;
`extensionKind` present and workspace-only; commands present; `deactivate` path disposes server + tunnel.

### R-P1-12 — P1 docs + CHANGELOG

- [ ] `docs/remote.md` — feature overview, cloudflared install per-OS, LAN-only fallback, "bring your own
  tunnel" via `tunnelCommand`, port visibility note for Codespaces.
- [ ] `README.md` short section.
- [ ] `CHANGELOG.md` `## [Unreleased]` → `### Added`.

---

## Phase 2 — Remote approvals

**Phase goal:** a phone can answer consent/confirmation prompts. **No new authority** — remote can only
resolve requests the host already raised.

| ID | Work item | Blocked by | Size |
|---|---|---|---|
| R-P2-01 | Extract `respondToConsent(...)` from `ChatViewProvider` | R-P1-11 | M |
| R-P2-02 | `getPendingPrompts()` + remote prompt fan-out | R-P2-01 | M |
| R-P2-03 | Fix `updatePromptPause()` for remote viewers | R-P2-01 | S |
| R-P2-04 | `POST /consent` + `POST /confirm` handlers | R-P2-02, R-P1-06 | M |
| R-P2-05 | Console approve/deny UI | R-P2-04 | M |
| R-P2-06 | Privilege-guard tests (the security gate) | R-P2-05 | L |

### R-P2-01 — Extract `respondToConsent`

- **AC:** body of the `case 'consentResponse'` handler (`ChatViewProvider.ts:2251`) becomes a public
  `respondToConsent(requestId, approved, scope)`; the webview handler **and** the remote POST both call
  it. `session`/`permanent` allowlist scope applied in exactly one place.
- **Tests first** — `respondToConsent.test.ts`: webview path and remote path produce identical broker
  calls; `permanent` extends the allowlist; unknown `requestId` is a no-op; double-resolve ignored.

### R-P2-02 — `getPendingPrompts()` + fan-out

- **AC:** pending consent/confirm requests are enumerable and broadcast as `consentRequest`/`confirmRequest`
  to remote viewers; a viewer connecting mid-prompt receives the current pending set (no missed prompts).
- **Tests first**: prompt raised while no viewer → new viewer gets it on connect; prompt resolved before
  connect → not delivered; payload identical to the webview's.

### R-P2-03 — `updatePromptPause()` remote awareness

- **AC:** `updatePromptPause()` (`ChatViewProvider.ts:~1305`) includes a `hasRemoteViewer()` signal so a
  phone-only session (no local chat surface visible) does **not** freeze the consent countdown. Signal
  increments on SSE connect, decrements on disconnect.
- **Tests first**: no visible chat + 1 remote viewer → timer **runs**; no viewer → pauses; viewer
  disconnects → pauses again. (This is the bug that would otherwise hang every phone-only run.)

### R-P2-04 — POST handlers

- **AC:** `/consent` and `/confirm` accept only `requestId` + decision, validated by `remoteProtocol`,
  cookie-auth required, then call `respondToConsent` / confirmation equivalent. No other route exists.

### R-P2-05 — Console approve/deny UI

- **AC:** pending prompts render with approve/deny; POST on tap; optimistic state reconciled by the next
  SSE event; works after a tunnel interstitial.

### R-P2-06 — Privilege-guard tests *(the security gate)*

- **AC (must all hold):**
  - Remote can resolve an **already-pending** request; it **cannot originate** one (no route accepts a
    tool/command payload).
  - `yolo.pushApproval` and protected-branch push remain **blocked** when driven remotely.
  - No remote route reaches `agentFollowUp`, settings writes, push, or the tool executor — asserted by
    enumerating the router's routes.
- **Tests first** — `remoteConsent.test.ts`: the above, plus scope semantics parity with the local path.

---

## Phase 3 — Remote cancel + docs

| ID | Work item | Blocked by | Size |
|---|---|---|---|
| R-P3-01 | `POST /cancel` → run cancellation | R-P2-06 | M |
| R-P3-02 | Console cancel button + confirm | R-P3-01 | S |
| R-P3-03 | Finalize docs (`docs/remote.md` hardening, security model) | R-P3-02 | S |
| R-P3-04 | *(Superseded by Phase 4 — see R-P4-*)* remote follow-up prompt | — | L |

- **R-P3-01 AC:** cancelling a known run id aborts it via the existing abort path; unknown/finished id →
  409, no throw; `dispose()` during an in-flight cancel is safe. **Tests first**: cancel running → aborted
  once; cancel finished → 409; cancel unknown → 404.
- **R-P3-04** is **superseded by Phase 4**: remote influence on agent behaviour is delivered
  deliberately and safely via **remote chat & sessions** (R-P4-*), under the P4 security gate
  (R-P4-07), rather than as an ad-hoc follow-up prompt.

---

---

## Phase 4 — Remote chat & sessions

**Phase goal:** a remote browser/phone can **send chat messages to the assistant and manage chat
sessions** (create / switch / rename / delete), watching the response stream live. Chat rides the
**existing SSE downstream + POST upstream transport** — no WebSocket, no new runtime dependency.

**Security position (non-negotiable):** remote chat is **not** a privilege escalation. Tool calls raised
by a remote chat message go through the *same* `respondToConsent` path as local chat; remote clients
**cannot** enable `consent.harmlessAutoApprove` / `consent.autoApproveTools` / YOLO, cannot push, cannot
write settings, and cannot change the interaction mode. The only new authority is "send text into an
existing session", gated by the same bearer-token/cookie auth as the rest of the console.

| ID | Work item | Blocked by | Size |
|---|---|---|---|
| R-P4-01 | `ChatSessionStore` — create/list/rename/delete + history persistence/resume | R-P1-11 | L |
| R-P4-02 | Chat event vocabulary in `remoteProtocol` (`chatDelta`, `chatToolCall`, `chatDone`, `sessionList`, …) | R-P1-01 | M |
| R-P4-03 | Extract `ChatController` from `ChatViewProvider` (`sendMessage`/`cancel`/`getSessions`/`getHistory`) | R-P2-01 | L |
| R-P4-04 | Upstream chat/session routes (`POST /chat/send`, `/chat/cancel`, `/sessions`) | R-P4-02, R-P4-03, R-P1-06 | M |
| R-P4-05 | Downstream session sync (backlog replay on connect; local + remote viewers share one conversation) | R-P4-04 | M |
| R-P4-06 | Console chat UI (message list, composer, streaming render, markdown/code, session switcher) | R-P4-05 | L |
| R-P4-07 | Chat security-guard tests (the P4 gate) | R-P4-06 | L |
| R-P4-08 | Chat/session docs + CHANGELOG | R-P4-07 | S |

### R-P4-01 — `ChatSessionStore`
- **AC:** `create()/list()/get(id)/rename(id)/delete(id)`; history persisted in `workspaceState`; a
  session resumes with full history after reload; deleting the active session selects a fallback; store
  is vscode-thin and headless-testable via an injected state adapter.
- **Tests first** — `chatSessionStore.test.ts`: create/list/rename/delete; persistence round-trip;
  delete-active fallback; id collision safety.

### R-P4-02 — Chat event vocabulary
- **AC:** `remoteProtocol` gains downstream `chatDelta` (streamed text), `chatToolCall`, `chatToolResult`,
  `chatDone`, `chatError`, `sessionList`, `sessionState`, and upstream `chat/send` + `chat/cancel` +
  `sessions` payloads. Reuses existing chat message shapes where possible; validators reject malformed
  payloads without throwing. No `vscode` import.
- **Tests first** — extend `remoteProtocol.test.ts`: round-trip for each new event; malformed rejection;
  message-size limit enforced.

### R-P4-03 — Extract `ChatController`
- **AC:** the send/cancel/history logic currently inside `ChatViewProvider` becomes a reusable
  `ChatController` with `sendMessage(sessionId, text)`, `cancel(sessionId)`, `getSessions()`,
  `getHistory(sessionId)` and streaming callbacks; **both** the webview and the remote routes drive it,
  so there is one chat implementation. Webview behaviour is unchanged (parity test).
- **Tests first** — `chatController.test.ts`: webview path and a direct call produce identical
  controller/broker calls; cancel mid-stream aborts exactly once; history read is side-effect free.

### R-P4-04 — Upstream chat/session routes
- **AC:** `POST /chat/send {sessionId, text}`, `POST /chat/cancel {sessionId}`, `POST /sessions`
  (create/switch/rename/delete) — cookie-auth required, bodies validated by `remoteProtocol`, bound to
  the `ChatController`. Unknown session → 404; oversized text → 413.
- **Tests first** — `remoteChatRoutes.test.ts`: auth required; unknown session 404; oversized 413;
  send delegates to `ChatController.sendMessage`; cancel delegates once.

### R-P4-05 — Downstream session sync
- **AC:** a viewer connecting mid-response receives the current session state + history backlog, then
  live deltas (no missed or duplicated messages — per-viewer cursor). Local webview and remote viewers
  observe the **same** conversation.
- **Tests first**: connect mid-stream → backlog then live deltas, no duplicates; two viewers both see
  the same delta sequence; disconnect does not disturb the other viewer.

### R-P4-06 — Console chat UI
- **AC:** message list with streamed assistant text, tool-call/result rendering, markdown + code blocks,
  a composer, and a session switcher (create/rename/delete/switch). Survives a tunnel interstitial and
  reconnect (backlog replay). Mobile-first; still dependency-free (no framework, no CDN).
- **Tests first** — `remoteConsoleChat.test.ts`: static parse asserts `EventSource` for chat, no token
  in `localStorage`, no external asset references; composer disabled while a response streams unless
  cancel is available.

### R-P4-07 — Chat security-guard tests *(the P4 gate)*
- **AC (must all hold):**
  - Tool calls raised by remote chat resolve through the same `respondToConsent` path; remote chat
    **cannot** auto-approve them.
  - Remote has **no route** to enable `consent.harmlessAutoApprove` / `consent.autoApproveTools` / YOLO,
    to push, to write settings, or to change the interaction mode — asserted by enumerating the router.
  - Per-session and global **rate limits** + message-size caps are enforced; repeated bad tokens are
    throttled/locked out.
- **Tests first** — `remoteChatSecurity.test.ts`: the above, plus parity of tool-approval semantics with
  the local chat path.

---

## Dependency graph

```
R-P1-01 ─┬─▶ R-P1-06 ─┬─▶ R-P1-07
R-P1-02 ─┘            ├─▶ R-P1-11 ─▶ R-P2-01 ─┬─▶ R-P2-02 ─▶ R-P2-04 ─▶ R-P2-05 ─▶ R-P2-06 ─▶ R-P3-01 ─▶ R-P3-02 ─▶ R-P3-03
R-P1-04 ─┬─▶ R-P1-05 ─┘                      └─▶ R-P2-03
R-P1-03 ─┴─▶ R-P1-10
R-P1-08 ─▶ R-P1-09
R-P1-01 ─▶ R-P4-02 ─▶ R-P4-04
R-P1-11 ─▶ R-P4-01 ─▶ R-P4-04
R-P2-01 ─▶ R-P4-03 ─▶ R-P4-04 ─▶ R-P4-05 ─▶ R-P4-06 ─▶ R-P4-07 ─▶ R-P4-08
```

Critical path: `R-P1-01/02 → R-P1-06 → R-P1-11 → R-P2-01 → R-P4-03 → R-P4-04 → R-P4-06 → R-P4-07`.

## Risk register

| Risk | Mitigation | Owning item |
|---|---|---|
| Phone-only session freezes consent timer | `hasRemoteViewer()` in `updatePromptPause` | R-P2-03 (must land with P2, not after) |
| cloudflared URL on **stderr**, stdout-only reader hangs | Scrape both, emit once | R-P1-05 |
| Public URL leaks token via query/proxy logs | Fragment → HttpOnly/Secure/SameSite=Strict cookie | R-P1-06 |
| `asExternalUri` returns loopback on desktop forks → false "reachable" | Classification + honest "Local only" label | R-P1-04 |
| Dangling public endpoint after crash/toggle-off | PID-tracked kill on dispose + `deactivate` | R-P1-05, R-P1-11 |
| DNS rebinding on loopback | Host/Origin guard + cookie auth | R-P1-06 |
| Fork drift in consent scope logic | Single extracted `respondToConsent` | R-P2-01 |
| Remote chat drives tools without oversight | Remote chat reuses `respondToConsent`; no auto-approve route exists | R-P4-07 |
| Token/cost runaway from remote chat | Per-session + global rate limits, message-size caps | R-P4-07 |
| Local + remote viewers desync the conversation | Single `ChatController` + backlog replay with per-viewer cursor | R-P4-03, R-P4-05 |
| Chat session state lost on reload | Persist history in `workspaceState` via `ChatSessionStore` | R-P4-01 |

## Open questions

1. **Parent epic** — no ADO parent/Area confirmed yet; items are documented here, and are created under
   the Epic *"Remote Agent Oversight (browser/phone)"*.
2. **Iteration/milestone** — do P1/P2/P3/P4 map to iterations, or stay as tags?
3. **R-P3-04** is **superseded by Phase 4** (remote chat supersedes the deferred follow-up prompt).
4. **P4 chat scope** — should the remote console be able to *create* sessions, or only attach to
   sessions created locally? (Plan assumes create + manage, per R-P4-01/R-P4-06.)

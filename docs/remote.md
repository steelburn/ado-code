# Remote Agent Oversight

A phone-sized web console that mirrors what your ADO Code agents are doing on this
machine, so you can leave the desk without losing sight of a long run.

The console shows which agent runs are active, streams their status and results, and lets
you answer the consent and confirmation prompts those runs raise — from the sofa, without
walking back to the machine. It does not start runs or type new instructions: the machine
still drives, the phone only unblocks it.

Turning the feature on is the same thing as starting the server: `adoCode.remote.enabled`
is the single source of truth, and every surface (status bar, STATUS row, commands, QR
panel) reads it rather than keeping its own on/off state.

## Turning it on

Any of these toggles `adoCode.remote.enabled`:

- the status bar item (`$(broadcast) Remote`, or `$(broadcast) 2` while two devices watch),
- the **Remote Access** row in the STATUS view,
- `ADO Code: Toggle Remote Access` in the command palette.

`ADO Code: Show Remote Access QR Code` starts the stack if it is off, then opens a panel
with a scannable QR code, the URL, and a one-line explanation of how that URL is reachable.

## Reading the QR code

The panel tells you which of three cases you are in, because they behave differently on
a phone:

| Kind | What it means | Works on a phone? |
| --- | --- | --- |
| `local` | The console only listens on loopback (`127.0.0.1`), possibly mirrored to your LAN address when `adoCode.remote.bind` is `all`. | Only from this machine (or LAN with `all`) — start a tunnel. |
| `tunnel` | A public tunnel URL is running (`cloudflared` or your own command). | Yes, from anywhere, while the tunnel stays up. |
| `external` | VS Code already forwards the port (Codespaces, Remote-SSH, dev tunnels) via `asExternalUri`. | Yes, through VS Code's forwarding. |

The QR encodes the **resolved** URL, so it is never a loopback address when a public one
exists. If no public URL exists, the panel says so plainly instead of handing you a code
that silently fails.

The panel also carries the actions you would otherwise hunt for in the palette:
**Turn off remote access** stops the server, disconnects every phone and closes the panel,
**Copy console URL**
puts the address on the clipboard for a device that cannot scan, **Rotate token** invalidates
the current link so a phone that already scanned it has to scan again, and **Reconfigure**
opens the remote settings. They are plain `command:` links - the panel still runs no script.

## One app, five views

Scanning the QR code opens a single-page app: one document, one event stream, and a tab
bar at the bottom that switches **views in place**. Nothing reloads when you move between
them, so the stream stays connected, the mirrored conversation keeps arriving, and a
consent card that lands while you are reading the runs is already live the moment you
tap **Approvals**.

| View | What it holds |
| --- | --- |
| **Thread** | The plan card, the mirrored conversation with its choice buttons — each answer followed by the tool calls it made — and the box you reply in. It opens on the newest message. |
| **Goal** | The objective in full, a progress bar and the milestones grouped into *In progress*, *Next* and *Done* — the view you open to remind yourself what the agent is doing at all. |
| **Files** | Every file the agent changed this session, newest first, with the tool that touched it and how many times, and a count on the tab. |
| **Approvals** | The consent and confirmation cards, with a count on the tab while any of them is unanswered. |
| **Runs** | The external agent runs this machine is driving, with their live delta, above the tool calls the agent is making right now. |

The route lives in the URL fragment (`#view=thread`, `#view=goal`, `#view=changes`, `#view=approvals`,
 `#view=runs`),
right next to the token, so the phone's back gesture returns to the previous view and a
reload or a bookmark lands where you left off instead of on an empty page. A fragment
never reaches the server: switching views costs no request and shows nothing to a tunnel
interstitial, the token is still the only thing that opens a session, and it is still
scrubbed from the address bar once it has been exchanged for the cookie.

The app starts on **Thread**, scrolled to the newest message: a phone that joins an hour into a run
must not land on the first frame of the replay. That follow-the-end behaviour is released the moment
you scroll back to read, and re-armed when you return to the bottom, so reading is never interrupted
by an incoming message. A scan that carries a view - `#t=…&view=approvals` - opens that view
directly; anything it does not recognise falls back to **Thread**.

Tab labels stay legible on purpose: full-contrast colour at 15px with a 44px tap target, and the
selected view is marked by an accent rule and a pill rather than by fading its neighbours. The
**Runs** view, when empty, says so honestly - no agent is working right now, a run appears the
moment one starts on the desktop, and this page mirrors it instead of starting it.

## Settings

All six are `machine`-scoped: the console is a service on *this* machine, so a workspace
cannot turn it on or point it elsewhere.

| Setting | Default | Meaning |
| --- | --- | --- |
| `adoCode.remote.enabled` | `false` | Serve the console. Turning it off stops the server and any tunnel. |
| `adoCode.remote.bind` | `loopback` | `loopback` listens on `127.0.0.1`; `all` also listens on your LAN. |
| `adoCode.remote.port` | `0` | Console port; `0` lets the OS pick a free one. |
| `adoCode.remote.tunnel` | `none` | `none`, `cloudflared` (quick tunnels), or `custom`. |
| `adoCode.remote.tunnelCommand` | empty | Command template for `custom`; `{port}` is substituted. |
| `adoCode.remote.tunnelUrlPattern` | empty | Regex to scrape the public URL from tunnel output; empty uses the built-in patterns. |

## Answering approvals

A tool call that needs consent appears in two places at once: the card in the chat on the
machine, and the **Approvals** view of the console (the middle tab, which counts what is
waiting). Both are views of one
request, so the first answer wins — the other card disappears and its buttons go dead.

- **Allow once** approves that single call.
- **Allow for session** (and **Always**, where the tool offers it) writes to the *same*
  allowlist the desktop card writes to, so a phone approval is not a weaker exception that
  expires early.
- **Deny** refuses the call; the agent is told it was declined.
- **Confirmation prompts** — the questions an agent asks mid-run — render one button per
  option the agent actually offered. The console never guesses between them.

Cards carry the same countdown as their desktop twins and are removed the moment the decision
lands anywhere, expiry included. Because the SSE stream has no replay, the page re-reads
`GET /pending` on every (re)connect: a phone that slept through the moment the card appeared
still shows it on wake.

If a tap loses the race — the desktop answered first, or the request expired while the tap
was in flight — the host answers `409 Conflict`, and the console drops the card and says so
instead of retrying. A blind retry would answer whatever the agent asks *next*, which is the
one mistake this design refuses to make.

## Watching a job that is already running

The console is a live view: the event stream only carries what happens *after* it opens. A job
that is already running writes nothing until its next chunk of output, so the page asks for the
jobs that are progressing right now (`GET /runs`) every time it connects — the first load, a
reload, and each automatic reconnect after the phone slept or the network dropped. The card is
rendered immediately with its status, title and work item, then takes over from the stream.

Only running jobs are replayed: a finished run's card arrives with its final status on the
stream. So an empty list means nothing is running right now — not that nothing ever ran.

### The built-in chat turn is not an agent run

A delegated CLI run has an `AgentRun` record; a plain chat turn — the model streaming text and
calling tools — has none, so it never appears in `GET /runs`. The page therefore also asks
`GET /turn` on every (re)connect and renders a **Working now** card above the job list: the
session's name, whether it is running in the background, and a ticking elapsed clock. The
turn's start and end are pushed live as `turnStatus` events (`turn: null` when idle), so the
card appears and disappears without a reload. If nothing is running on either side the page
says *Nothing running right now.*

## Following the conversation — and continuing it

The console shows the same thread the chat shows, not just the cards: your own messages, the
assistant's answers as they stream in, and any **choice block** at the end of an answer, rendered
as tappable buttons. Tapping one sends that option as your next message, exactly as if you had
clicked it on the machine, and the turn it starts is followed by the *Working now* card. The
block you answered closes on both screens as soon as the answer is accepted: the option card in
VS Code goes away *before* the turn starts streaming, so the same question can never sit open on
one surface while the other has already answered it. And it stays closed: the host keeps the
answer by request id, so a re-render, a webview reload or a second phone connecting cannot bring
an answered block back as if it were still waiting.

A text box under the thread takes a free-form reply — the answer to a question the assistant asked
in prose, or a new instruction. Sending from the phone is not a separate code path: the text goes
through the same handler the webview uses, so tools, approvals and steering behave identically, and
your message appears in the chat on the machine too.

The box is pinned to the bottom of the screen, directly above the tab bar, so a reply is one thumb
away no matter how far the thread has scrolled — the thread itself gets `padding-bottom: 150px` so
nothing hides under it, and the pinned bar clears the home indicator with `env(safe-area-inset-bottom)`.

**Send** is the one control on the page that is filled with the accent colour rather than outlined,
because it is the action the page exists for; it is a 44px tap target, and it reports its own state
instead of raising a toast on a screen you may not be looking at:

| State | What it says |
| --- | --- |
| idle | `➤ Send`, accent fill |
| sending | `⟳ Sending`, spinning icon, disabled — a double tap cannot post the reply twice |
| sent | `✓ Sent`, green, reverts to idle after a moment |
| failed | `↻ Retry`, red — the reply is still in the box, so it is worth tapping again |

Both halves of the bridge have the usual failure behaviour:

- **`GET /transcript`** replays the thread when the page opens, reloads, or reconnects — the console
  never depends on having been listening at the right moment. An observe-only console gets an empty
  thread rather than an error.
- The thread is bounded (40 messages, 4000 characters each, oldest dropped first), so a long session
  cannot flood a phone over a tunnel. The console shows a truncated cap with an ellipsis.
- **`POST /chat`** answers `400` for empty text and `501` when the console is observe-only — a
  read-only console cannot talk back.

## The session plan

The goal and the to-do list belong to the session, so the console shows them: a card above the
thread carrying the goal in one line, a `3 of 6 steps done` summary and one row per step — `○`
pending, `▸` in progress, `✔` done, the in-progress row also bolded. It is the same plan the To-do
view on the machine shows, including the steps the agent ticks off by itself.

- Every write to the to-do store is pushed as a `plan` event, whichever tool made it — `set_goal`,
  `update_todo_list`, or the automatic tick when the agent finishes a step.
- `GET /plan` replays it on every (re)connect, for the same reason `/runs` and `/transcript` exist:
  the event stream has no replay of its own, and a phone that joins mid-run would otherwise show
  nothing until the plan changed again.
- The card is hidden entirely when the session has neither a goal nor a to-do list — an empty box
  would only push the thread down. Long lists stop at eight rows (`+N more steps`), so the
  conversation stays reachable one thumb-scroll away.
- A read-only console sees the plan; it just cannot act on it.

### The Goal view

The plan card in the thread answers *how far along*; the **Goal** tab answers *what is this agent
even doing*, so it is deliberately more than the same list again: the objective in full, a progress
bar (`role="img"` with the counts as its label, so it reads out on a screen reader) and the
milestones grouped into **In progress**, **Next** and **Done**. A long session that has scrolled the
goal far up the thread still has it one tap away.

A session with nothing planned says so instead of rendering an empty page, and a phone that joins
mid-run replays the whole thing from `GET /plan` — the Goal tab is filled by exactly the same frame
that fills the thread card.

## The files the agent changed

After an hour of edits the phone has a third question, after *what is happening* and *what needs me*:
**what did it touch?** The tool feed forgets — it is a rolling window of twelve calls — and the
transcript makes you read. So the host keeps a per-session list of changed files and the **Files**
tab renders it newest first: one row per file, the file name kept and the directory faded out (a
390px row cannot hold a full workspace path), a status dot, and `tool ×edits` beside it.

- The host aggregates the calls that *change* something — `edit_file`, `apply_diff`, `write_to_file`,
  `delete_file` — keyed by the workspace-relative path, so six edits to one file are one row with
  `edits: 6` rather than six rows. The path comes from the raw arguments, not from the clipped
  digest the feed shows.
- A call id is counted once, and the row's status is *derived*, not assigned: `running` while any
  call against that file is still in flight, `error` if one of them failed — and it stays `error`
  even after a later success. From a sofa, a file touched by a failed call must not read as fine.
- The list is capped at 60 files (`MAX_CHANGED_FILES`) and evicts the *coldest* file, not the
  oldest: a run that keeps returning to one file never loses it. When it has evicted anything the
  frame carries `truncated: true` and the view says so — a silently shortened list is a lie.
- Pushed whole on every change (the `files` event) and replayed by `GET /files`, both bounded by the
  same cap. A tracker that throws degrades to an empty list rather than a `500`: a snapshot the host
  cannot produce must not black out the tab.
- The tab carries a count of the files seen since you last opened it, as **Approvals** does.

## Tool calls

An approval card covers the calls that **stop to ask**. Everything else — `read_file`,
`search_files`, a `yolo` turn, every delegated CLI run — used to be invisible on the phone: the
console said nothing while the agent edited six files. The **Runs** view now carries a **Tool calls**
feed above the run cards and the empty state.

One row per call: the tool name, a one-line digest of what it targets (`edit_file` ·
`src/remote/consolePage.ts`, `run_terminal_command` · `npm test`), how it ended and how long it took.
Newest first, because the last thing that happened is what you picked the phone up to see.

- The digest is *chosen*, not dumped: the most descriptive argument wins (a search's `regex` over the
directory it ran in), an array collapses to its first entry plus a count, and the value is clipped.
Arguments never travel — the console gets the target, not the payload.
- `chat.showToolCalls=false` keeps its promise here too: that path already posts the call with
`arguments: {}`, so the phone renders the tool's name and status without its payload.
- Status is `running` (accent dot, elapsed time ticking), `ok`, or `error` — the verdict is read from
the tool's own result text (`{ error: … }`, or a leading `Error:`/`failed`), never from a thrown
exception. A call still marked running after five minutes renders as **stalled** instead, so an
aborted turn cannot leave the phone showing a spinner that never ends.
- The feed is bounded to the last 12 calls and pushed **whole** as a `toolFeed` event — a couple of
KB, no client-side merge, and a phone that slept through six calls renders the same rows as one that
just opened. `GET /tools` replays it on every (re)connect, for the same reason `/plan` does, and
answers an empty feed rather than `500` when the mirror is unavailable.

### In the thread

The same calls are drawn **under the message that made them** in the Thread view, in the order they
ran: an answer can be read together with what it cost — `read_file` · `src/a.ts`, `edit_file` ·
`src/remote/consolePage.ts`, `run_terminal_command` · `npm test`, each with a status dot and its
duration.

- The pairing happens on the **host**, in `TranscriptMirror`: a call hangs under the assistant
  message of the current turn — the live stream while one is open, otherwise the newest answer since
  your last message. The console never guesses the pairing from timings, so a reloaded page draws the
  same groups.
- A turn that calls tools **before writing anything** gets a content-less message of its own, labelled
  **Tool run**. It renders as the list of calls and never as an empty bubble.
- Each message carries at most **10** calls (the newest are kept) plus the real total, so a 40-call
  turn says `+30 earlier calls not shown` instead of growing without bound. That cap is per message
  and independent of the 12-row live feed above, which only ever shows what is running now.
- One row per call: the `started` and `settled` announcements update the same row, a call still
  running after five minutes reads as **stalled**, and the rows travel with the message, so
  `GET /transcript` replays them exactly like the text.

## Security model

- **Token.** A 256-bit random token lives in VS Code `SecretStorage`. The QR URL carries it
  in the `#t=` fragment (never sent to a server in a request line by the browser's own
  rules), and the console exchanges it once for an `HttpOnly` cookie via `POST /session`.
  Every later request — the SSE stream included — relies on that cookie. Because a phone
  browser drops the fragment on reload, tab restore and "open in browser", the console asks
  `GET /session` (cookie only, mints nothing) whether that session is still live before it
  ever asks you to scan again.
- **Approval authority, only over an open request.** The console answers the same brokers the
  desktop cards do — but an unknown or already-answered `requestId`, or an option the host
  never offered, is refused (`409` / `400`). The console can read what is pending
  (`GET /pending`) and can never *create* a request, so a compromised page cannot manufacture
  an approval; rotating the token kills the cookie that carries the authority.
- **Host guard.** Requests whose `Host` header is neither loopback nor the configured LAN
  address are rejected, which shuts the door on DNS-rebinding attacks against a
  localhost-bound server.
- **Loopback by default.** `bind: all` is a deliberate opt-in; the LAN address is only
  advertised when you ask for it.
- **Rotate.** `ADO Code: Rotate Remote Console Token` mints a new token and invalidates the
  old one, so a leaked URL stops working. Every connected device must rescan.
- **No scripts in the panel.** The QR panel is static markup with a strict CSP; the only
  interactive element is a `command:` link that VS Code handles.

## Tunnels

`cloudflared` is used as a quick tunnel: the binary must be on `PATH`, and a missing binary
only disables that option — it never breaks activation. For anything else, set
`adoCode.remote.tunnel: custom` and give a command template, e.g.

```jsonc
{
  "adoCode.remote.tunnel": "custom",
  "adoCode.remote.tunnelCommand": "ssh -R 80:localhost:{port} nokey@localhost.run",
  "adoCode.remote.tunnelUrlPattern": "https://[a-z0-9-]+\\.lhr\\.life"
}
```

The tunnel process is started with the console and killed when it stops, so it cannot
outlive the feature.

## Limitations

- **VS Code Desktop only.** The web client cannot forward a local port, so the console
  reports itself unavailable there instead of handing out an unusable URL.
- **Approvals, not instructions.** The console answers prompts and reads runs; it cannot
  start a run, send a message or type into the chat.
- **One console.** Enabling it in two windows of the same machine is the same server.

## Troubleshooting

- *The card is on the phone but tapping it does nothing* — if the toast says the request was
  already answered, the desktop got there first (or it expired); reload to drop the stale
  card. If the page cannot reach the host at all nothing is decided: a dropped answer never
  counts as a yes.
- *The row says Off but the setting is on* — a start failure (port taken, tunnel binary
  missing) drops back to Off; the status bar tooltip carries the error.
- *The QR scans but the page never loads* — you are almost certainly using the `local` code
  from another device. Start a tunnel, or set `adoCode.remote.bind: all` and use the LAN
  address.
- *A new token broke my bookmark* — expected: rotating invalidates the `#t=` fragment. Use
  the current QR code.
- *"This link is missing its access token"* — the banner is now the last resort, not the first
  reaction: a missing fragment is normal on a reload, so the console probes `GET /session`
  and reconnects on a live cookie by itself. Seeing the banner means nothing is left to
  resume — private mode, a cleared cache, a rotated token or a different host — so scan the
  current QR code.

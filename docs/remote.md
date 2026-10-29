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
machine, and the **Approvals** region at the top of the console. Both are views of one
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

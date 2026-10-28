# Remote Agent Oversight

A phone-sized web console that mirrors what your ADO Code agents are doing on this
machine, so you can leave the desk without losing sight of a long run.

Phase 1 is **oversight**: the console shows which agent runs are active, streams their
status and results, and flags consent prompts waiting on the machine. It does not let
you approve tools or type instructions yet — the machine stays in charge.

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

## Security model

- **Token.** A 256-bit random token lives in VS Code `SecretStorage`. The QR URL carries it
  in the `#t=` fragment (never sent to a server in a request line by the browser's own
  rules), and the console exchanges it once for an `HttpOnly` cookie via `POST /session`.
  Every later request — the SSE stream included — relies on that cookie.
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
- **Read-only in phase 1.** Consent prompts are announced, not answerable, from the phone.
- **One console.** Enabling it in two windows of the same machine is the same server.

## Troubleshooting

- *The row says Off but the setting is on* — a start failure (port taken, tunnel binary
  missing) drops back to Off; the status bar tooltip carries the error.
- *The QR scans but the page never loads* — you are almost certainly using the `local` code
  from another device. Start a tunnel, or set `adoCode.remote.bind: all` and use the LAN
  address.
- *A new token broke my bookmark* — expected: rotating invalidates the `#t=` fragment. Use
  the current QR code.

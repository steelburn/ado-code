/**
 * Mobile console page (R-P1-07).
 *
 * One self-contained document: no framework, no CDN, no build step, no external
 * asset of any kind. That is a hard requirement, not a preference — the page has
 * to render behind a tunnel interstitial and inside a phone browser with no
 * network access to anywhere but the extension host.
 *
 * Security shape:
 *  - the token arrives in the URL **fragment** (`#t=…`), which browsers never
 *    send to a server and never put in a Referer;
 *  - it is exchanged once for an HttpOnly cookie via `POST /session` and then
 *    dropped from the address bar (`history.replaceState`) so a shoulder-surfed
 *    URL or a screenshotted tab cannot be replayed;
 *  - every other request (SSE + any future POST) relies on the cookie, so the
 *    token never appears in a request URL, a log line or a proxy trail.
 *
 * Phase 1 is strictly view-only: the page renders runs and their status and has
 * no buttons that could approve anything.
 */

export const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="referrer" content="no-referrer">
<title>ADO Code — Remote Console</title>
<style>
  :root {
    --bg: #1e1e1e;
    --panel: #252526;
    --border: #3c3c3c;
    --fg: #cccccc;
    --muted: #8c8c8c;
    --accent: #3794ff;
    --ok: #4ec9b0;
    --warn: #d7ba7d;
    --error: #f48771;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #ffffff; --panel: #f3f3f3; --border: #d4d4d4; --fg: #333333; --muted: #6a6a6a; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    -webkit-text-size-adjust: 100%;
  }
  header {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; flex: 1; }
  .badge {
    font-size: 12px; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; white-space: nowrap;
  }
  main { padding: 12px 16px 48px; }
  .empty { color: var(--muted); padding: 24px 0; text-align: center; }
  .run {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 14px; margin-bottom: 12px;
  }
  .run-head { display: flex; align-items: baseline; gap: 8px; }
  .run-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-agent { font-size: 12px; color: var(--muted); }
  .status { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .status.running { color: var(--accent); }
  .status.succeeded { color: var(--ok); }
  .status.failed, .status.error { color: var(--error); }
  .status.queued, .status.cancelled { color: var(--warn); }
  .delta {
    margin: 8px 0 0; padding: 8px 10px; max-height: 180px; overflow: auto;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  .summary { margin: 8px 0 0; white-space: pre-wrap; }
  .prompt {
    margin: 8px 0 0; padding: 8px 10px; border-left: 3px solid var(--warn);
    font-size: 13px; color: var(--muted);
  }
  .banner {
    margin-bottom: 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
    border: 1px solid var(--border); background: var(--panel); color: var(--muted);
  }
  .banner.error { color: var(--error); }
  footer { padding: 0 16px 24px; font-size: 12px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<header>
  <h1>ADO Code — Remote Console</h1>
  <span class="badge" id="viewers">0 watching</span>
</header>
<main>
  <div id="banner" class="banner" hidden></div>
  <div id="runs"><div class="empty">Connecting…</div></div>
</main>
<footer>View-only · approvals stay on the machine running VS Code</footer>
<script>
(function () {
  'use strict';
  var state = { runs: {}, order: [], source: null, connected: false };
  var runsEl = document.getElementById('runs');
  var bannerEl = document.getElementById('banner');
  var viewersEl = document.getElementById('viewers');

  function showBanner(message, isError) {
    bannerEl.hidden = !message;
    bannerEl.textContent = message || '';
    bannerEl.className = 'banner' + (isError ? ' error' : '');
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function titleFor(run) {
    if (!run) { return 'Agent run'; }
    if (run.title) { return run.title; }
    if (run.workItemId) { return 'ADO-' + run.workItemId; }
    return run.id || 'Agent run';
  }

  function render() {
    if (!state.order.length) {
      runsEl.innerHTML = state.connected
        ? '<div class="empty">No agent runs yet.</div>'
        : '<div class="empty">Connecting…</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < state.order.length; i++) {
      var run = state.runs[state.order[i]];
      var status = String(run.status || 'running');
      html += '<section class="run">' +
        '<div class="run-head">' +
          '<span class="run-title">' + esc(titleFor(run)) + '</span>' +
          '<span class="status ' + esc(status) + '">' + esc(status) + '</span>' +
        '</div>' +
        '<div class="run-agent">' + esc(run.agent || '') + (run.workdir ? ' · ' + esc(run.workdir) : '') + '</div>' +
        (run.summary ? '<p class="summary">' + esc(run.summary) + '</p>' : '') +
        (run.delta ? '<pre class="delta">' + esc(run.delta) + '</pre>' : '') +
        (run.prompt ? '<div class="prompt">' + esc(run.prompt) + '</div>' : '') +
      '</section>';
    }
    runsEl.innerHTML = html;
  }

  function upsert(run, patch) {
    if (!run || !run.id) { return null; }
    var existing = state.runs[run.id];
    if (!existing) {
      state.order.push(run.id);
      existing = state.runs[run.id] = {};
    }
    for (var key in run) {
      if (Object.prototype.hasOwnProperty.call(run, key)) { existing[key] = run[key]; }
    }
    if (patch) {
      for (var patchKey in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, patchKey)) { existing[patchKey] = patch[patchKey]; }
      }
    }
    return existing;
  }

  function handle(event) {
    if (!event || typeof event !== 'object') { return; }
    switch (event.type) {
      case 'agentStatus': {
        var run = upsert(event.run, { delta: (event.delta || '') });
        if (run && event.delta) {
          run.delta = String(run.delta || '').slice(-4000);
        }
        break;
      }
      case 'agentResult': {
        upsert(event.run, { summary: event.summary || '' });
        break;
      }
      case 'consentRequest': {
        // Phase 1 is view-only: show that the host is waiting, without buttons.
        showBanner('A consent prompt is waiting on the machine (' + (event.tool || 'tool') + ').');
        break;
      }
      case 'confirmationRequest': {
        showBanner('A confirmation is waiting on the machine: ' + (event.title || ''));
        break;
      }
      case 'viewerCount': {
        viewersEl.textContent = (event.count || 0) + ' watching';
        return;
      }
      default:
        return;
    }
    render();
  }

  function connect() {
    if (state.source) { state.source.close(); }
    var source = new EventSource('/events');
    state.source = source;
    source.onopen = function () {
      state.connected = true;
      showBanner('');
      render();
    };
    source.onmessage = function (message) {
      var payload;
      try { payload = JSON.parse(message.data); } catch (err) { return; }
      handle(payload);
    };
    source.onerror = function () {
      state.connected = false;
      showBanner('Connection lost — retrying…', true);
    };
  }

  function readToken() {
    var hash = window.location.hash || '';
    if (hash.indexOf('#t=') !== 0) { return ''; }
    return decodeURIComponent(hash.slice(3));
  }

  function clearTokenFromAddressBar() {
    try {
      window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
    } catch (err) { /* some browsers refuse; harmless */ }
  }

  function start() {
    var token = readToken();
    if (!token) {
      showBanner('This link is missing its access token. Re-open the QR code from VS Code.', true);
      return;
    }
    clearTokenFromAddressBar();
    fetch('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ t: token })
    }).then(function (response) {
      if (!response.ok) { throw new Error('HTTP ' + response.status); }
      connect();
    }).catch(function () {
      showBanner('Could not sign in — the access token was rejected. Rotate it in VS Code and rescan.', true);
    });
  }

  start();
})();
</script>
</body>
</html>
`;

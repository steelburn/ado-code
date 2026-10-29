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
 *  - every other request (SSE, the approval POSTs and the GET probes) relies on
 *    the cookie, so the token never appears in a request URL, a log line or a
 *    proxy trail.
 *
 * The page renders agent runs and their status, and mirrors any *open* approval
 * request so it can be answered from the phone. It can only ever answer a
 * request the host already raised, never create one, and the decision is taken
 * by the same broker that backs the desktop card, so the two cards cannot
 * disagree.
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
    /* Approvals — first thing on the page: a decision is the only thing a
       phone visitor may need to do, and it is time-critical. */
    #approvals { margin: 0 0 16px; }
    .approval {
      border: 1px solid rgba(201, 162, 39, 0.85);
      border-radius: 10px;
      padding: 12px 12px 10px;
      margin: 0 0 10px;
      background: rgba(201, 162, 39, 0.10);
    }
    .ap-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 8px; }
    .ap-title { font-weight: 600; font-size: 15px; }
    .ap-timer { font-size: 13px; opacity: 0.75; font-variant-numeric: tabular-nums; }
    .ap-tool { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; opacity: 0.85; margin: 0 0 6px; word-break: break-all; }
    .ap-args, .ap-desc {
      margin: 0 0 10px;
      padding: 8px;
      max-height: 150px;
      overflow: auto;
      border-radius: 6px;
      background: rgba(127, 127, 127, 0.14);
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ap-desc { font-family: inherit; font-size: 14px; }
    .ap-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .act {
      flex: 1 1 auto;
      min-height: 44px;
      padding: 10px 14px;
      font-size: 15px;
      font-weight: 600;
      border-radius: 8px;
      border: 1px solid rgba(127, 127, 127, 0.5);
      background: rgba(127, 127, 127, 0.14);
      color: inherit;
      cursor: pointer;
    }
    .act.go { border-color: #2e7d32; }
    .act.danger { border-color: #b3261e; }
    .act:disabled { opacity: 0.45; cursor: default; }
</style>
</head>
<body>
<header>
  <h1>ADO Code — Remote Console</h1>
  <span class="badge" id="viewers">0 watching</span>
</header>
<main>
  <div id="banner" class="banner" hidden></div>
  <div id="approvals"></div>
  <div id="runs"><div class="empty">Connecting…</div></div>
</main>
  <footer>Approvals can be answered here — mutating tools still need a decision</footer>
<script>
(function () {
  'use strict';
  var state = { runs: {}, order: [], approvals: {}, approvalOrder: [], source: null, connected: false };
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
        ? '<div class="empty">No agent runs yet. Waiting tool approvals show up at the top.</div>'
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
        addApproval(event, 'consent');
        break;
      }
      case 'confirmationRequest': {
        addApproval(event, 'confirm');
        break;
      }
      case 'approvalResolved': {
        // Answered here, answered on the desktop, or expired: drop the card.
        removeApproval(event.requestId);
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

  var approvalsEl = document.getElementById('approvals');

  function argsText(args) {
    var text;
    try { text = JSON.stringify(args || {}, null, 2); } catch (err) { text = '{}'; }
    if (text.length > 1200) { text = text.slice(0, 1200) + String.fromCharCode(8230); }
    return text;
  }

  function leftLabel(expiresAt) {
    if (!expiresAt) { return ''; }
    var ms = expiresAt - Date.now();
    if (ms <= 0) { return 'expired'; }
    var total = Math.floor(ms / 1000);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return mm + ':' + (ss < 10 ? '0' + ss : String(ss));
  }

  function addApproval(event, kind) {
    if (!event || !event.requestId) { return; }
    var expiresAt = event.expiresAt || (event.autoApproveMs ? Date.now() + event.autoApproveMs : 0);
    state.approvals[event.requestId] = {
      requestId: event.requestId,
      kind: kind,
      title: kind === 'consent' ? 'Allow ' + (event.tool || 'this tool') + '?' : String(event.title || 'Confirm?'),
      tool: String(event.tool || ''),
      argsText: kind === 'consent' ? argsText(event.args) : '',
      description: String(event.description || ''),
      options: event.options || [],
      expiresAt: expiresAt,
      sent: false
    };
    if (state.approvalOrder.indexOf(event.requestId) < 0) {
      state.approvalOrder.push(event.requestId);
    }
    renderApprovals();
  }

  function removeApproval(requestId) {
    if (!state.approvals[requestId]) { return; }
    delete state.approvals[requestId];
    var at = state.approvalOrder.indexOf(requestId);
    if (at >= 0) { state.approvalOrder.splice(at, 1); }
    renderApprovals();
  }

  function decisionButton(card, label, attrs, className) {
    var disabled = card.sent ? ' disabled' : '';
    return '<button class="act ' + esc(className) + '" data-id="' + esc(card.requestId) + '" ' + esc(attrs) + esc(disabled) + '>' + esc(label) + '</button>';
  }

  function cardHtml(card) {
    var html = '<section class="approval">';
    html += '<div class="ap-head"><span class="ap-title">' + esc(card.title) + '</span>';
    html += '<span class="ap-timer" data-expires="' + esc(String(card.expiresAt)) + '">' + esc(leftLabel(card.expiresAt)) + '</span></div>';
    if (card.kind === 'consent') {
      html += '<div class="ap-tool">' + esc(card.tool) + '</div>';
      html += '<pre class="ap-args">' + esc(card.argsText) + '</pre>';
    } else if (card.description) {
      html += '<div class="ap-desc">' + esc(card.description) + '</div>';
    }
    html += '<div class="ap-actions">';
    if (card.kind === 'consent') {
      html += decisionButton(card, 'Allow once', 'data-kind="consent" data-approved="1" data-scope="once"', 'go');
      html += decisionButton(card, 'Allow for session', 'data-kind="consent" data-approved="1" data-scope="session"', '');
      html += decisionButton(card, 'Deny', 'data-kind="consent" data-approved="0"', 'danger');
    } else {
      for (var i = 0; i < card.options.length; i++) {
        var option = card.options[i] || {};
        html += decisionButton(card, String(option.label || option.value || 'OK'),
          'data-kind="confirm" data-value="' + esc(String(option.value || '')) + '"',
          option.isDangerous ? 'danger' : '');
      }
    }
    html += '</div></section>';
    return html;
  }

  function renderApprovals() {
    if (!state.approvalOrder.length) {
      approvalsEl.innerHTML = '';
      return;
    }
    var html = '';
    for (var i = 0; i < state.approvalOrder.length; i++) {
      var card = state.approvals[state.approvalOrder[i]];
      if (card) { html += cardHtml(card); }
    }
    approvalsEl.innerHTML = html;
  }

  function tickApprovalTimers() {
    var nodes = approvalsEl.querySelectorAll('.ap-timer');
    for (var i = 0; i < nodes.length; i++) {
      var expiresAt = parseInt(nodes[i].getAttribute('data-expires'), 10) || 0;
      var label = leftLabel(expiresAt);
      if (nodes[i].textContent !== label) { nodes[i].textContent = label; }
    }
    // An expired card can no longer be answered — the broker denied it.
    for (var j = state.approvalOrder.length - 1; j >= 0; j--) {
      var card = state.approvals[state.approvalOrder[j]];
      if (card && card.expiresAt && card.expiresAt <= Date.now()) {
        removeApproval(card.requestId);
      }
    }
  }

  function postDecision(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).catch(function () { return null; });
  }

  approvalsEl.addEventListener('click', function (clickEvent) {
    var target = clickEvent.target;
    var button = target && target.closest ? target.closest('button.act') : null;
    if (!button || button.disabled) { return; }
    var requestId = button.getAttribute('data-id');
    var card = state.approvals[requestId];
    if (!card || card.sent) { return; }
    // Optimistic lock: a double tap must not post twice.
    card.sent = true;
    renderApprovals();
    var kind = button.getAttribute('data-kind');
    var path = kind === 'consent' ? '/consent' : '/confirm';
    var body;
    if (kind === 'consent') {
      body = { requestId: requestId, approved: button.getAttribute('data-approved') === '1' };
      var scope = button.getAttribute('data-scope');
      if (scope && body.approved) { body.scope = scope; }
    } else {
      body = { requestId: requestId, value: button.getAttribute('data-value') };
    }
    postDecision(path, body).then(function (response) {
      if (!response) {
        card.sent = false;
        renderApprovals();
        showBanner('Could not reach VS Code — try again.', true);
        return;
      }
      // 409: already answered on the other surface, or expired. Gone is gone.
      // 401: the session cookie is no longer valid — nothing can be decided.
      if (response.ok || response.status === 409 || response.status === 401) {
        removeApproval(requestId);
        if (response.status === 401) {
          showBanner('Session expired — rotate the token in VS Code and rescan.', true);
        }
        return;
      }
      card.sent = false;
      renderApprovals();
      showBanner('VS Code refused that decision.', true);
    });
  });

  function loadPending() {
    fetch('/pending', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload || !payload.approvals) { return; }
        for (var i = 0; i < payload.approvals.length; i++) {
          var item = payload.approvals[i];
          if (!item || !item.requestId) { continue; }
          if (state.approvals[item.requestId]) { continue; }
          addApproval(item, item.type === 'confirmationRequest' ? 'confirm' : 'consent');
        }
      })
      .catch(function () { /* offline: the SSE stream will deliver new ones */ });
  }

  setInterval(tickApprovalTimers, 1000);

  function connect() {
    if (state.source) { state.source.close(); }
    var source = new EventSource('/events');
    state.source = source;
    source.onopen = function () {
      state.connected = true;
      showBanner('');
      render();
      loadPending();
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

  /**
   * Is the cookie from an earlier scan still good? A reload, a tab restore or
   * "open in browser" from the tab list drops the URL fragment, and a lost
   * fragment is not a lost session — ask the host before sending the user back
   * to VS Code to re-scan.
   */
  function resumeSession() {
    return fetch('/session', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok; })
      .catch(function () { return false; });
  }

  function start() {
    var token = readToken();
    if (!token) {
      resumeSession().then(function (ok) {
        if (ok) { connect(); return; }
        showBanner('This link is missing its access token. Re-open the QR code from VS Code.', true);
      });
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
      // A rotated token behind a live cookie still signs in; only a genuinely
      // dead session deserves "rotate it and rescan".
      resumeSession().then(function (ok) {
        if (ok) { connect(); return; }
        showBanner('Could not sign in — the access token was rejected. Rotate it in VS Code and rescan.', true);
      });
    });
  }

  start();
})();
</script>
</body>
</html>
`;

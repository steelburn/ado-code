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
    --tab-bg: rgba(24, 24, 24, 0.97);
    --tab-border: rgba(255, 255, 255, 0.14);
    --tab-fg: #b8b8b8;
    --tab-fg-active: #ffffff;
    --tab-pill: rgba(255, 255, 255, 0.13);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff; --panel: #f3f3f3; --border: #d4d4d4; --fg: #333333; --muted: #6a6a6a;
      /* The bar used to be dark-only: rgba(255,255,255,.10) on white is nothing. */
      --tab-bg: rgba(243, 243, 243, 0.98);
      --tab-border: #d4d4d4;
      --tab-fg: #454545;
      --tab-fg-active: #111111;
      --tab-pill: rgba(0, 0, 0, 0.08);
    }
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
  .empty-title { color: var(--fg); font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .empty-body { color: var(--fg); opacity: 0.85; font-size: 13px; line-height: 1.5; }
  .empty-hint { color: var(--muted); font-size: 12px; line-height: 1.5; margin-top: 8px; }
  /* ── Tool calls: what the agent is doing, call by call ────────────── */
  .tools { margin: 0 0 14px; }
  .tools-head {
    display: flex; align-items: center; gap: 8px;
    margin: 0 2px 8px; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  }
  .tools-title { flex: 1; }
  .tools-live {
    display: inline-flex; align-items: center; gap: 5px;
    color: var(--accent); text-transform: none; letter-spacing: 0;
  }
  .live-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
    animation: tool-pulse 1.4s ease-in-out infinite;
  }
  @keyframes tool-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } }
  .tool-list { list-style: none; margin: 0; padding: 0; }
  .tool {
    display: flex; align-items: center; gap: 10px;
    min-height: 44px; padding: 8px 12px; margin-bottom: 6px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  }
  .tool-dot { flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .tool.running .tool-dot { background: var(--accent); box-shadow: 0 0 0 3px rgba(55, 148, 255, 0.18); }
  .tool.ok .tool-dot { background: var(--ok); }
  .tool.error .tool-dot { background: var(--error); }
  .tool.stalled .tool-dot { background: var(--warn); }
  .tool-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .tool-name {
    font-weight: 600; font-size: 14px; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tool-detail {
    font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tool-time {
    flex: 0 0 auto; font-size: 12px;
    font-variant-numeric: tabular-nums; color: var(--muted);
  }
  .tool.running .tool-time { color: var(--accent); }
  .tool.error .tool-time { color: var(--error); }
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
    /* The session plan: the goal the work is meant to achieve plus the to-do
     list. Compact on purpose — it answers "what is this doing?" at a glance,
     before the thread it belongs to. */
  .plan {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; margin-bottom: 12px;
  }
  .plan[hidden] { display: none; }
  .plan-goal { font-size: 14px; font-weight: 600; line-height: 1.35; word-break: break-word; }
  .plan-label { font-weight: 500; color: var(--muted); }
  .plan-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .plan-list { list-style: none; margin: 8px 0 0; padding: 0; }
  .plan-item { font-size: 13px; line-height: 1.4; display: flex; gap: 6px; word-break: break-word; }
  .plan-mark { flex: none; width: 15px; text-align: center; color: var(--muted); }
  .plan-item.done { color: var(--muted); }
  .plan-item.done .plan-text { text-decoration: line-through; }
  .plan-item.active .plan-mark { color: var(--accent); }
  .plan-item.active .plan-text { font-weight: 600; }
  .plan-more { font-size: 12px; color: var(--muted); margin-top: 6px; }
  /* Working now — the chat turn generating right now, above the run cards. */
    .turn {
      border: 1px solid rgba(56, 139, 253, 0.75);
      border-radius: 10px;
      padding: 12px;
      margin: 0 0 10px;
      background: rgba(56, 139, 253, 0.10);
    }
    .turn-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 6px; }
    .turn-title { font-weight: 600; font-size: 15px; }
    .turn-clock { font-size: 13px; opacity: 0.8; font-variant-numeric: tabular-nums; }
    .turn-session { font-size: 14px; margin: 0 0 4px; word-break: break-word; }
    .turn-note { font-size: 12px; opacity: 0.75; }
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
    /* Mirrored conversation (R-P1-09). Plain text on purpose: the desktop's
       markdown renderer is not shipped to the phone, so a fence or a table
       degrades to readable text instead of broken markup. */
    .thread-head { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; opacity: .6; margin: 0 0 8px; }
    .msg { margin: 0 0 10px; padding: 10px 12px; border-radius: 12px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); }
    .msg.user { background: rgba(56, 139, 253, 0.13); border-color: rgba(56, 139, 253, 0.35); }
    .msg-role { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .55; margin: 0 0 4px; }
    .msg-body { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.5; }
    /* Tool calls a message made, under its text: the shape of the work, not the
       payloads — a name, a one-line digest and how long the call took. */
    .msg .msg-tools {
      list-style: none; margin: 10px 0 0; padding: 8px 0 0;
      border-top: 1px dashed var(--border);
      display: flex; flex-direction: column; gap: 5px;
    }
    .msg-tool { display: flex; align-items: baseline; gap: 7px; min-width: 0;
      font-size: 12.5px; line-height: 1.35; color: var(--muted); }
    .msg-tool-dot { flex: 0 0 6px; width: 6px; height: 6px; border-radius: 50%;
      background: var(--muted); transform: translateY(-1px); }
    .msg-tool.running .msg-tool-dot { background: var(--accent); animation: tool-pulse 1.4s ease-in-out infinite; }
    .msg-tool.ok .msg-tool-dot { background: var(--ok); }
    .msg-tool.error .msg-tool-dot { background: var(--error); }
    .msg-tool.stalled .msg-tool-dot { background: var(--warn); }
    .msg-tool-name { flex: 0 0 auto; color: var(--fg);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .msg-tool-detail { flex: 1 1 auto; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .msg-tool-ms { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .msg-tools-more { margin-top: 5px; font-size: 11.5px; color: var(--muted); }
    .msg.tool-only .msg-body { display: none; }
    .msg.tool-only .msg-tools { margin-top: 0; padding-top: 0; border-top: 0; }
    .msg-sr { position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap; }
    .choice { margin: 10px 0 2px; display: flex; flex-direction: column; gap: 6px; }
    .choice-q { font-weight: 600; font-size: 13px; opacity: .85; }
    .choice-opt { text-align: left; }
    /* The reply box is PINNED: a phone conversation is read with the thumb at
       the bottom edge, so the thing that answers must live there and never
       scroll away. It sits directly on top of the tab bar, safe area included,
       so the two fixed strips cannot overlap on a notched phone. */
    .composer {
      position: fixed; left: 0; right: 0; z-index: 10;
      bottom: calc(62px + env(safe-area-inset-bottom));
      display: flex; align-items: center; gap: 8px;
      margin: 0; padding: 10px 12px;
      background: var(--tab-bg);
      border-top: 1px solid var(--tab-border);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    }
    .composer input {
      flex: 1 1 auto; min-width: 0; min-height: 44px;
      padding: 10px 12px; border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(0, 0, 0, 0.3); color: inherit; font: inherit;
    }
    .composer input:focus { outline: none; border-color: #2f81f7; box-shadow: 0 0 0 2px rgba(47, 129, 247, 0.3); }
    /* Send is the one control on the page that must look tappable: accent fill,
       white label, soft glow. Its data-state drives the icon and the colour, so
       "did it go?" is answered by the button itself, not by a toast. */
    .send {
      flex: 0 0 auto; min-width: 86px; min-height: 44px;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 0 14px; border: 0; border-radius: 10px;
      background: linear-gradient(135deg, #2f81f7, #1a5fd0);
      color: #ffffff; font: inherit; font-weight: 700; letter-spacing: 0.01em;
      box-shadow: 0 2px 10px rgba(47, 129, 247, 0.45);
      transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
      -webkit-tap-highlight-color: transparent;
    }
    .send:active { transform: scale(0.96); }
    .send .send-icon { font-size: 15px; line-height: 1; }
    .send[data-state="sending"] { background: linear-gradient(135deg, #4b5563, #374151); box-shadow: none; }
    .send[data-state="sending"] .send-icon { display: inline-block; animation: send-spin 900ms linear infinite; }
    .send[data-state="sent"] { background: linear-gradient(135deg, #2ea043, #1f7a33); box-shadow: 0 2px 10px rgba(46, 160, 67, 0.45); }
    .send[data-state="failed"] { background: linear-gradient(135deg, #da3633, #a92724); box-shadow: none; }
    @keyframes send-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .send[data-state="sending"] .send-icon { animation: none; } }
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
    /* Single-page shell: one document, one event stream, five views.
       Switching a view never reloads, so a consent card that arrives while the
       thread is on screen still lands in a live document. */
    [hidden] { display: none !important; }
    main { padding-bottom: 150px; }
    footer { margin-bottom: 150px; }
    .tabs {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
      display: flex; gap: 6px;
      padding: 8px 8px calc(10px + env(safe-area-inset-bottom));
      background: var(--tab-bg);
      border-top: 1px solid var(--tab-border);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    }
    /* Labels were 14px at 62% opacity: two dimmings stacked on an already muted
       colour, unreadable at arm's length. Explicit colours instead of opacity -
       legible when idle, full contrast plus an accent rule when selected - and
       per-scheme, so a light-mode phone gets a selected tab it can actually see. */
    .tabs a {
      flex: 1 1 0; min-width: 0;
      display: flex; align-items: center; justify-content: center; gap: 5px;
      min-height: 44px; padding: 10px 6px;
      border-radius: 12px; text-decoration: none;
      color: var(--tab-fg);
      font-size: 15px; font-weight: 600; letter-spacing: 0.01em;
      -webkit-tap-highlight-color: transparent;
    }
    .tabs a[aria-current="page"] {
      color: var(--tab-fg-active);
      background: var(--tab-pill);
      box-shadow: inset 0 2px 0 var(--accent);
    }
    .tabs .count, .tabs .dot {
      flex: 0 0 auto;
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      background: var(--warn); color: #14140f;
      font-size: 11px; font-weight: 700; line-height: 1;
    }
    .tabs .dot { width: 8px; height: 8px; min-width: 0; padding: 0; border-radius: 50%; }
    /* Five views do not fit at 15px on a 390px phone; the labels stay whole and
       the tap target stays 44px, so the type gives way instead. */
    .tabs a { font-size: 13.5px; padding: 10px 5px; }
    /* Goal view: the objective the work is meant to achieve, then its
       milestones — this is the "why am I looking at this?" answer. */
    .goal-hero {
      margin: 0 0 12px; padding: 12px 14px; border-radius: 12px;
      background: var(--panel); border: 1px solid var(--border);
    }
    .goal-kicker { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
    .goal-title { font-size: 17px; font-weight: 650; line-height: 1.35; word-break: break-word; }
    .goal-bar { position: relative; height: 8px; margin: 0 0 6px; border-radius: 999px; background: rgba(127, 127, 127, 0.25); overflow: hidden; }
    .goal-bar span { position: absolute; top: 0; bottom: 0; left: 0; background: linear-gradient(90deg, #2f81f7, #2ea043); }
    .goal-meta { margin: 0 0 16px; font-size: 12.5px; color: var(--muted); }
    .goal-group { margin: 0 0 16px; }
    .goal-group > h3 { margin: 0 0 6px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
    .goal-list { list-style: none; margin: 0; padding: 0; }
    /* Changes view: one row per file the agent touched. */
    .file-row {
      display: flex; align-items: center; gap: 10px;
      min-height: 44px; padding: 8px 12px; margin-bottom: 6px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    }
    .file-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #2ea043; }
    .file-row.running .file-dot { background: var(--warn); animation: tool-pulse 1.4s ease-in-out infinite; }
    .file-row.error .file-dot { background: #f85149; }
    .file-name { flex: 1 1 auto; min-width: 0; font-size: 13.5px; word-break: break-all; }
    .file-dir { color: var(--muted); }
    .file-tool { flex: 0 0 auto; font-size: 11.5px; color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
<header>
  <h1>ADO Code — Remote Console</h1>
  <span class="badge" id="viewers">0 watching</span>
</header>
<main>
  <div id="banner" class="banner" hidden></div>
  <div id="plan" class="plan" hidden></div>
  <div id="goal" class="goal" hidden></div>
  <div id="changes" class="changes" hidden></div>
  <div id="approvals"></div>
  <p class="empty" id="approvals-empty" hidden>Nothing waiting - an agent asks here the moment it needs consent.</p>
  <div id="transcript" class="thread"></div>
  <form id="composer" class="composer" autocomplete="off">
    <input id="composer-input" type="text" placeholder="Reply to the agent…" aria-label="Reply to the agent" />
    <button type="submit" id="composer-send" class="send" data-state="idle" aria-label="Send reply">
      <span class="send-icon" id="composer-send-icon" aria-hidden="true">➤</span><span id="composer-send-label">Send</span>
    </button>
  </form>
  <div id="runs"><div class="empty">Connecting…</div></div>
</main>
<nav class="tabs" id="tabs" aria-label="Console views">
  <a href="#view=thread" data-view="thread">Thread<span class="dot" id="thread-dot" hidden></span></a>
  <a href="#view=goal" data-view="goal">Goal</a>
  <a href="#view=changes" data-view="changes">Files<span class="count" id="files-count" hidden></span></a>
  <a href="#view=approvals" data-view="approvals">Approvals<span class="count" id="approvals-count" hidden></span></a>
  <a href="#view=runs" data-view="runs">Runs<span class="count" id="runs-count" hidden></span></a>
</nav>
  <footer>Approvals can be answered here — mutating tools still need a decision</footer>
<script>
(function () {
  'use strict';
  var state = { runs: {}, order: [], approvals: {}, approvalOrder: [], turn: null, source: null, connected: false,
    transcriptOrder: [], transcriptMessages: {}, answered: {}, transcriptTimer: null, plan: null, files: null };
  var planEl = document.getElementById('plan');
  var goalEl = document.getElementById('goal');
  var changesEl = document.getElementById('changes');
  var filesCountEl = document.getElementById('files-count');
  var sendBtn = document.getElementById('composer-send');
  var sendIcon = document.getElementById('composer-send-icon');
  var sendLabel = document.getElementById('composer-send-label');
  var runsEl = document.getElementById('runs');
  var transcriptEl = document.getElementById('transcript');
  var bannerEl = document.getElementById('banner');
  var viewersEl = document.getElementById('viewers');
  var composerEl = document.getElementById('composer');
  var tabsEl = document.getElementById('tabs');
  var threadDotEl = document.getElementById('thread-dot');
  var approvalsCountEl = document.getElementById('approvals-count');
  var runsCountEl = document.getElementById('runs-count');
  var approvalsEmptyEl = document.getElementById('approvals-empty');

  /**
   * Single-page shell.
   *
   * The console is one document with one long-lived event stream: views are
   * switched in place and never fetched, so moving between them keeps the
   * stream, the mirrored conversation and every pending approval alive. The
   * route rides in the URL fragment (#view=thread, #view=goal, #view=changes,
   * #view=approvals, #view=runs)
   * for the same reason the token does - a fragment never reaches the server - so
   * a view survives a reload, a back gesture or a bookmark without a request and
   * without leaking anything to a tunnel interstitial.
   */
  var VIEWS = ['thread', 'goal', 'changes', 'approvals', 'runs'];
  var view = 'thread';

  function parseView() {
    var hash = window.location.hash || '';
    var at = hash.indexOf('view=');
    if (at < 0) { return 'thread'; }
    var name = hash.slice(at + 5).split('&')[0].replace(/[^a-z]/g, '');
    return VIEWS.indexOf(name) >= 0 ? name : 'thread';
  }

  /** Follow the newest message while the reader stays at the bottom; scrolling up releases it. */
  var stickToLatest = true;

  /** True while the viewport sits at the (live) end of the page. */
  function nearLatest() {
    var scrolled = window.scrollY || document.documentElement.scrollTop || 0;
    var height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    return (scrolled + window.innerHeight) >= (height - 72);
  }

  function followLatest() {
    if (!stickToLatest) { return; }
    var height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    try { window.scrollTo(0, height); } catch (err) { /* nothing to scroll yet */ }
  }

  window.addEventListener('scroll', function () { stickToLatest = nearLatest(); }, { passive: true });

  /** A plan card with neither a goal nor a to-do list is not worth a view. */
  function planVisible() {
    var plan = state.plan;
    if (!plan) { return false; }
    return !!plan.goal || !!(plan.todos && plan.todos.length);
  }

  /** Unread marker: something landed in the thread while it was off screen. */
  function showThreadDot(on) {
    if (threadDotEl) { threadDotEl.hidden = !on; }
  }

  function syncBadges() {
    syncFilesBadge();
    var pending = state.approvalOrder.length;
    var active = state.order.length;
    if (approvalsCountEl) {
      approvalsCountEl.hidden = !pending;
      approvalsCountEl.textContent = pending ? String(pending) : '';
    }
    if (runsCountEl) {
      runsCountEl.hidden = !active;
      runsCountEl.textContent = active ? String(active) : '';
    }
    if (approvalsEmptyEl) {
      approvalsEmptyEl.hidden = pending > 0 || view !== 'approvals';
    }
    if (!tabsEl) { return; }
    var links = tabsEl.getElementsByTagName('a');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-view') === view) {
        links[i].setAttribute('aria-current', 'page');
      } else {
        links[i].removeAttribute('aria-current');
      }
    }
  }

  function syncViews() {
    var thread = view === 'thread';
    if (planEl) { planEl.hidden = !thread || !planVisible(); }
    if (goalEl) { goalEl.hidden = view !== 'goal'; }
    if (changesEl) { changesEl.hidden = view !== 'changes'; }
    if (transcriptEl) { transcriptEl.hidden = !thread; }
    if (composerEl) { composerEl.hidden = !thread; }
    if (approvalsEl) { approvalsEl.hidden = view !== 'approvals'; }
    if (runsEl) { runsEl.hidden = view !== 'runs'; }
    syncBadges();
  }

  /** How many files the agent has touched, on the Files tab. */
  function syncFilesBadge() {
    if (!filesCountEl) { return; }
    var count = state.files && state.files.files ? state.files.files.length : 0;
    filesCountEl.hidden = !count;
    filesCountEl.textContent = count ? String(count) : '';
  }

  /**
   * Switch views. The replace flag rewrites the current history entry instead
   * of adding one - used at boot, where the token fragment it replaces must not
   * be one back gesture away.
   */
  function applyView(next, replace) {
    if (VIEWS.indexOf(next) < 0) { next = 'thread'; }
    var changed = next !== view;
    view = next;
    syncViews();
    var hash = '#view=' + view;
    if (window.location.hash !== hash) {
      try {
        if (replace) {
          var base = window.location.pathname + window.location.search;
          window.history.replaceState(null, document.title, base + hash);
        } else {
          window.location.hash = hash;
        }
      } catch (err) {
        // A browser that refuses history calls still gets the view.
      }
    }
    if (changed) {
      try { window.scrollTo(0, 0); } catch (err) { /* nothing to scroll */ }
    }
    if (view === 'runs') { loadRuns(); loadTools(); }
    if (view === 'thread') {
      showThreadDot(false);
      // Coming back to the conversation means "show me what is happening now":
      // re-arm the follow and jump to the newest message.
      if (changed) { stickToLatest = true; followLatest(); }
    }
    if (view === 'goal') { loadPlan(); }
    if (view === 'changes') { loadFiles(); }
  }

  window.addEventListener('hashchange', function () {
    var next = parseView();
    if (next !== view) { applyView(next, false); }
  });

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

  /** Elapsed clock for the in-flight turn: 8s, 3m 12s, 1h 04m. */
  function elapsedText(startedAt) {
    var ms = Date.now() - Number(startedAt || 0);
    if (!isFinite(ms) || ms < 0) { ms = 0; }
    var total = Math.floor(ms / 1000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var s = pad(total % 60);
    var m = pad(Math.floor(total / 60) % 60);
    var h = Math.floor(total / 3600);
    // Built from a parts array: the escape guard would otherwise read this
    // clock as an unescaped payload concatenation.
    var parts = [];
    if (h > 0) { parts.push(h + 'h'); parts.push(m + 'm'); }
    else if (total >= 60) { parts.push(Number(m) + 'm'); parts.push(s + 's'); }
    else { parts.push(Number(s) + 's'); }
    return parts.join(' ');
  }

  /**
   * The chat turn generating right now.
   *
   * Agent runs arrive as agentStatus; a plain chat turn is not an agent run
   * and used to leave this page saying "nothing running" while the machine
   * streamed and called tools. This card closes that gap.
   */
  function turnHtml() {
    if (!state.turn) { return ''; }
    return '<section class="turn">' +
      '<div class="turn-head">' +
        '<span class="turn-title">Working now</span>' +
        '<span class="turn-clock" id="turn-clock">' + esc(elapsedText(state.turn.startedAt)) + '</span>' +
      '</div>' +
      '<div class="turn-session">' + esc(state.turn.title || state.turn.sessionId || 'Chat turn') +
        (state.turn.background ? ' · in the background' : '') + '</div>' +
      '<div class="turn-note">Generating and calling tools — details follow on the stream.</div>' +
    '</section>';
  }

  /**
   * What the Runs view shows while the list is empty.
   *
   * "Nothing running right now" read as "the feature is broken". This page is a
   * mirror - it never starts a run - so the honest copy is "no agent is working
   * yet; start one on the desktop and it lands here", plus where consents go.
   */
  function emptyRunsHtml() {
    return '<div class="empty">' +
      '<div class="empty-title">No agent is working right now.</div>' +
      '<div class="empty-body">A run appears here the moment one starts on the desktop - a delegated agent, or a chat turn that calls tools. This page mirrors it live; it never starts one itself.</div>' +
      '<div class="empty-hint">When a run needs consent it moves to Approvals, and this tab gets a badge.</div>' +
      '</div>';
  }

  /** Milliseconds as a phone-sized duration: 240ms, 1.4s, 2m. */
  function fmtMs(ms) {
    var value = Math.max(0, Number(ms) || 0);
    if (value < 1000) { return Math.round(value) + 'ms'; }
    if (value < 60000) { return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 's'; }
    return Math.round(value / 60000) + 'm';
  }

  function elapsedFor(entry) {
    if (typeof entry.durationMs === 'number') { return fmtMs(entry.durationMs); }
    return fmtMs(Date.now() - (entry.startedAt || Date.now()));
  }

  /**
   * A call still marked running long after it started is not live any more.
   *
   * The host only sends a finish for a call the loop actually completed, so an
   * aborted turn (or a phone that slept through one) would otherwise leave a
   * row pulsing forever. Five minutes is past every tool's timeout, so this
   * reads as "no result came back" rather than lying about activity.
   */
  var TOOL_STALL_MS = 5 * 60 * 1000;

  function toolStatusFor(entry) {
    var status = String(entry.status || 'running');
    if (status === 'running' && Date.now() - (entry.startedAt || 0) > TOOL_STALL_MS) {
      return 'stalled';
    }
    return status;
  }

  function hasRunningTool() {
    var entries = state.toolFeed || [];
    for (var i = 0; i < entries.length; i++) {
      if (toolStatusFor(entries[i]) === 'running') { return true; }
    }
    return false;
  }

  /**
   * The tool calls the agent made, newest first.
   *
   * This is the feed that answers "what is it doing right now?" for calls that
   * never stopped to ask permission - the ones the Approvals view cannot show.
   */
  function toolFeedHtml() {
    var entries = state.toolFeed || [];
    if (!entries.length) { return ''; }
    var html = '<section class="tools">' +
      '<div class="tools-head">' +
        '<span class="tools-title">Tool calls</span>' +
        (hasRunningTool() ? '<span class="tools-live"><span class="live-dot"></span>running</span>' : '') +
      '</div>' +
      '<ul class="tool-list">';
    // Newest first: on a phone the last thing that happened is the headline.
    for (var i = entries.length - 1; i >= 0; i--) {
      var entry = entries[i] || {};
      var status = toolStatusFor(entry);
      html += '<li class="tool ' + esc(status) + '">' +
        '<span class="tool-dot" aria-hidden="true"></span>' +
        '<span class="tool-body">' +
          '<span class="tool-name">' + esc(entry.name || 'tool') + '</span>' +
          (entry.detail ? '<span class="tool-detail">' + esc(entry.detail) + '</span>' : '') +
        '</span>' +
        '<span class="tool-time">' + esc(elapsedFor(entry)) + '</span>' +
      '</li>';
    }
    return html + '</ul></section>';
  }

  /** Replay on (re)connect: a phone that opens mid-turn missed the starts. */
  function loadTools() {
    fetch('/tools', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (payload && payload.entries) {
          state.toolFeed = payload.entries;
          render();
        }
      })
      .catch(function () { /* the stream still delivers new calls */ });
  }

  /** Keep the elapsed column honest while a call is still running. */
  function tickTools() {
    if (view !== 'runs' || !hasRunningTool()) { return; }
    render();
  }

  function render() {
    syncBadges();
    var html = turnHtml() + toolFeedHtml();
    if (!state.order.length) {
      runsEl.innerHTML = html + (state.connected
        // A chat turn that is generating is shown as its own card above: claiming
        // "no agent is working" next to it would contradict the card.
        ? (html ? '' : emptyRunsHtml())
        : '<div class="empty">Connecting…</div>');
      return;
    }
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
      case 'toolFeed': {
        state.toolFeed = event.entries || [];
        render();
        break;
      }
      case 'plan': {
        state.plan = { goal: event.goal || '', todos: event.todos || [] };
        renderPlan();
        renderGoal();
        break;
      }
      case 'files': {
        state.files = { files: event.files || [], truncated: event.truncated === true };
        renderChanges();
        syncFilesBadge();
        break;
      }
      case 'turnStatus': {
        state.turn = event.turn || null;
        break;
      }
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
      case 'choiceResolved': {
        // The answer was given on the OTHER surface (a desktop click or a
        // second console) — close the block here so its buttons cannot be
        // tapped a second time.
        markChoiceAnswered(event.requestId, event.answer);
        break;
      }
      case 'transcript': {
        // Full snapshot: first load, reload, reconnect, session switch.
        var rows = event.messages || [];
        state.transcriptOrder = [];
        state.transcriptMessages = {};
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          upsertTranscript(rows[rowIndex]);
        }
        renderTranscript();
        return;
      }
      case 'transcriptMessage': {
        // A whole message: a user turn, or an assistant answer that just
        // finished — this is the frame that carries the choice block.
        upsertTranscript(event.message);
        scheduleTranscriptRender();
        return;
      }
      case 'transcriptDelta': {
        var streaming = state.transcriptMessages[event.id];
        if (!streaming) {
          streaming = upsertTranscript({ id: event.id, role: 'assistant', content: '' });
        }
        if (streaming) {
          var prior = String(streaming.content || '');
          var extra = String(event.delta || '');
          streaming.content = prior + extra;
        }
        scheduleTranscriptRender();
        return;
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
    syncBadges();
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

  /**
   * Jobs that are still progressing, replayed on (re)connect.
   *
   * The stream only reports what happens after it opens, so a phone that joins
   * or reloads mid-job would otherwise see nothing while the machine works.
   */
  function loadRuns() {
    fetch('/runs', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        var runs = payload && payload.runs ? payload.runs : [];
        for (var i = 0; i < runs.length; i++) { upsert(runs[i], {}); }
        render();
      })
      .catch(function () { /* the stream stays the source of truth */ });
  }

  /**
   * The turn the host is generating right now, replayed on (re)connect.
   *
   * Same reason as loadRuns: the stream only reports what happens after it
   * opens, and a turn in flight is not an agent run, so nothing else here
   * would ever say the machine is busy.
   */
  function loadTurn() {
    fetch('/turn', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        state.turn = (payload && payload.turn) || null;
        render();
      })
      .catch(function () { /* the stream still delivers the next turnStatus */ });
  }

  /**
   * One mirrored message into the local store (id-keyed, so a delta, a
   * finalize and a replay all land on the same bubble).
   */
  function upsertTranscript(message) {
    if (!message || !message.id) { return null; }
    var existing = state.transcriptMessages[message.id];
    if (!existing) {
      existing = { id: message.id, role: 'assistant', content: '' };
      state.transcriptMessages[message.id] = existing;
      state.transcriptOrder.push(message.id);
    }
    if (message.role === 'user' || message.role === 'assistant') { existing.role = message.role; }
    if (typeof message.content === 'string') { existing.content = message.content; }
    if (message.choice) {
      existing.choice = message.choice;
      // Remember the answer the HOST reports: a later frame for the same
      // message that no longer carries it must still render the block closed,
      // not as options waiting for input.
      if (message.choice.answered === true && message.choice.answer) {
        state.answered[existing.id] = message.choice.answer;
      }
    }
    if (message.tools) { existing.tools = message.tools; }
    if (typeof message.toolCount === 'number') { existing.toolCount = message.toolCount; }
    return existing;
  }

  /**
   * Close the mirrored block the given requestId names.
   *
   * By requestId and not by option text: the same label can appear in two
   * cards, and the host names WHICH card closed. Matching on text would close
   * both and let the user answer the wrong one.
   */
  function markChoiceAnswered(requestId, answer) {
    if (!requestId) { return; }
    for (var orderIndex = 0; orderIndex < state.transcriptOrder.length; orderIndex++) {
      var messageId = state.transcriptOrder[orderIndex];
      var message = state.transcriptMessages[messageId];
      if (!message || !message.choice || message.choice.requestId !== requestId) { continue; }
      message.choice.answered = true;
      message.choice.answer = answer;
      // A tap of our own already recorded it; the host frame only confirms it.
      state.answered[messageId] = answer;
      scheduleTranscriptRender();
      return;
    }
  }

  /**
   * The choice block the model offered, as real buttons.
   *
   * The host strips the choice fence from the text and sends the options
   * structurally, so tapping one is the same act as tapping the card on the
   * desktop: it becomes the next user message.
   */
  function choiceHtml(message) {
    if (!message.choice || !message.choice.options || !message.choice.options.length) { return ''; }
    // A block is closed when an answer EXISTS: tapped here (state.answered) or
    // given on the desktop and mirrored back (choice.answered on the block).
    // Deriving it from the answer is what keeps an unanswered block live across
    // a reconnect instead of freezing it into a dead one.
    var picked = state.answered[message.id] !== undefined
      ? state.answered[message.id]
      : (message.choice.answered ? message.choice.answer : undefined);
    var closed = picked !== undefined;
    var html = '<div class="choice">';
    html += '<div class="choice-q">' + esc(message.choice.question || 'Pick an option') + '</div>';
    for (var optionIndex = 0; optionIndex < message.choice.options.length; optionIndex++) {
      var option = String(message.choice.options[optionIndex]);
      var answered = closed && String(picked) === option;
      var disabled = closed ? ' disabled' : '';
      var mark = answered ? ' ✓' : '';
      html += '<button type="button" class="act choice-opt" data-choice="' + esc(option) + '" data-msg="' + esc(message.id) + '"' + esc(disabled) + '>' + esc(option) + esc(mark) + '</button>';
    }
    html += '</div>';
    return html;
  }

  /**
   * The tool calls one message made, drawn under its text.
   *
   * The Runs view answers "what is it doing now?"; this answers "what did this
   * answer cost?" — the files it read and the commands it ran, in the order
   * they ran. The host sends the name and a one-line digest, never the payload,
   * and keeps only the newest MAX_MESSAGE_TOOLS calls, so a long turn says how
   * many older ones it is not showing instead of growing without bound.
   */
  function inlineTools(message) {
    var tools = message.tools || [];
    if (!tools.length) { return ''; }
    var html = '<ul class="msg-tools" aria-label="Tool calls">';
    for (var index = 0; index < tools.length; index++) {
      var entry = tools[index] || {};
      var status = toolStatusFor(entry);
      var name = String(entry.name || 'tool');
      html += '<li class="msg-tool ' + esc(status) + '">' +
        '<span class="msg-tool-dot" aria-hidden="true"></span>' +
        '<span class="msg-tool-name">' + esc(name) + '</span>' +
        (entry.detail ? '<span class="msg-tool-detail">' + esc(String(entry.detail)) + '</span>' : '') +
        '<span class="msg-tool-ms">' + esc(elapsedFor(entry)) + '</span>' +
        '<span class="msg-sr">' + esc(name + ' ' + status) + '</span>' +
        '</li>';
    }
    html += '</ul>';
    var hidden = (Number(message.toolCount) || tools.length) - tools.length;
    if (hidden > 0) {
      html += '<div class="msg-tools-more">+' + esc(hidden) + ' earlier ' +
        (hidden === 1 ? 'call' : 'calls') + ' not shown</div>';
    }
    return html;
  }

  function renderTranscript() {
    showThreadDot(view !== 'thread' && state.transcriptOrder.length > 0);
    var html = '<div class="thread-head">Conversation</div>';
    if (!state.transcriptOrder.length) {
      html += '<div class="empty">No messages mirrored yet.</div>';
      transcriptEl.innerHTML = html;
      return;
    }
    for (var index = 0; index < state.transcriptOrder.length; index++) {
      var message = state.transcriptMessages[state.transcriptOrder[index]];
      if (!message) { continue; }
      var roleClass = message.role === 'user' ? 'user' : 'bot';
      var roleLabel = message.role === 'user' ? 'You' : 'Assistant';
      // A turn that called tools before writing anything has a message of its
      // own, with no text: label it for what it is instead of "Assistant".
      var toolOnly = !String(message.content || '').trim() && !!(message.tools && message.tools.length);
      if (toolOnly) { roleLabel = 'Tool run'; }
      html += '<article class="msg ' + esc(roleClass) + (toolOnly ? ' tool-only' : '') + '">';
      html += '<div class="msg-role">' + esc(roleLabel) + '</div>';
      html += '<div class="msg-body">' + esc(message.content || '') + '</div>';
      html += choiceHtml(message);
      html += inlineTools(message);
      html += '</article>';
    }
    transcriptEl.innerHTML = html;
    // The page opens on the newest message, and stays there while it streams —
    // unless the reader scrolled back, which nearLatest() has already noticed.
    followLatest();
  }

  /** Deltas arrive per token: coalesce them into one paint. */
  function scheduleTranscriptRender() {
    if (state.transcriptTimer) { return; }
    state.transcriptTimer = setTimeout(function () {
      state.transcriptTimer = null;
      renderTranscript();
    }, 150);
  }

  /**
   * The plan card. Hidden entirely when the session has neither a goal nor
   * a to-do list — an empty box would only add noise.
   */
  function renderPlan() {
    if (!planEl) { return; }
    var plan = state.plan;
    var goal = (plan && plan.goal) || '';
    var todos = (plan && plan.todos) || [];
    if (!goal && !todos.length) {
      syncViews();
      planEl.innerHTML = '';
      return;
    }
    var done = 0;
    for (var d = 0; d < todos.length; d++) {
      if (String(todos[d].status) === 'completed') { done++; }
    }
    var html = '';
    if (goal) {
      html += '<div class="plan-goal"><span class="plan-label">Goal · </span>' + esc(goal) + '</div>';
    }
    if (todos.length) {
      html += '<div class="plan-meta">' + esc(done) + ' of ' + esc(todos.length) + ' steps done</div>'
        + '<ul class="plan-list">';
      var shown = todos.length > 8 ? todos.slice(0, 8) : todos;
      for (var i = 0; i < shown.length; i++) {
        var row = shown[i] || {};
        var status = String(row.status || 'pending');
        // One glyph per state: the console is scanned, not read.
        var mark = status === 'completed' ? '✔' : (status === 'in_progress' ? '▸' : '○');
        var klass = 'plan-item' + (status === 'completed' ? ' done' : (status === 'in_progress' ? ' active' : ''));
        html += '<li class="' + esc(klass) + '"><span class="plan-mark">' + esc(mark) + '</span>'
          + '<span class="plan-text">' + esc(row.content || row.activeForm || '') + '</span></li>';
      }
      html += '</ul>';
      if (todos.length > shown.length) {
        html += '<div class="plan-more">+' + esc(todos.length - shown.length) + ' more steps</div>';
      }
    }
    planEl.innerHTML = html;
    syncViews();
  }

  /** Replay on (re)connect: the plan changes are events a late phone missed. */
  function loadPlan() {
    fetch('/plan', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload) { return; }
        state.plan = { goal: payload.goal || '', todos: payload.todos || [] };
        renderPlan();
        renderGoal();
      })
      .catch(function () { /* keep whatever was already rendered */ });
  }

  /**
   * The Goal view: what this session is trying to achieve, and how far along it
   * is. Deliberately more than the compact plan card in the thread — this is
   * the tab a reader opens to remind themselves WHAT the agent is doing, so it
   * gets the objective in full, a progress bar and the milestones grouped by
   * state (in progress, next, done) instead of one flat list.
   */
  function renderGoal() {
    if (!goalEl) { return; }
    var plan = state.plan || { goal: '', todos: [] };
    var goal = plan.goal || '';
    var todos = plan.todos || [];
    if (!goal && !todos.length) {
      goalEl.innerHTML = '<div class="empty">No goal for this session yet — the agent sets one when the work starts.</div>';
      return;
    }
    var done = 0;
    for (var i = 0; i < todos.length; i++) {
      if (((todos[i] || {}).status || 'pending') === 'completed') { done++; }
    }
    var html = '';
    if (goal) {
      html += '<div class="goal-hero"><div class="goal-kicker">Objective</div>';
      html += '<div class="goal-title">' + esc(goal) + '</div></div>';
    }
    if (todos.length) {
      var summary = done + ' of ' + esc(String(todos.length)) + ' milestones complete';
      var pct = Math.round((done / todos.length) * 100);
      html += '<div class="goal-bar" role="img" aria-label="' + esc(summary) + '">';
      html += '<span style="width:' + esc(String(pct)) + '%"></span></div>';
      html += '<div class="goal-meta">' + esc(summary) + '</div>';
      // Grouped by state, not by order: "what is running now" is the first
      // question, "what is left" the second, "what is done" the last.
      var groups = [['in_progress', 'In progress'], ['pending', 'Next'], ['completed', 'Done']];
      for (var g = 0; g < groups.length; g++) {
        var rows = '';
        for (var j = 0; j < todos.length; j++) {
          var todo = todos[j] || {};
          if (String(todo.status || 'pending') !== groups[g][0]) { continue; }
          var mark = groups[g][0] === 'completed' ? '✔' : groups[g][0] === 'in_progress' ? '▸' : '○';
          var klass = 'plan-item' + (groups[g][0] === 'completed' ? ' done' : groups[g][0] === 'in_progress' ? ' active' : '');
          rows += '<li class="' + esc(klass) + '"><span class="plan-mark">' + esc(mark) + '</span>';
          rows += '<span class="plan-text">' + esc(todo.content || todo.activeForm || '') + '</span></li>';
        }
        if (!rows) { continue; }
        html += '<div class="goal-group"><h3>' + esc(groups[g][1]) + '</h3><ul class="goal-list">';
        html += rows;
        html += '</ul></div>';
      }
    }
    goalEl.innerHTML = html;
  }

  /**
   * The Changes view: every file the agent touched this session, newest first.
   *
   * Paths are split at the last slash so the file NAME survives a 390px row
   * and the directory can fade out — the same trick the desktop tree uses.
   */
  function renderChanges() {
    if (!changesEl) { return; }
    var list = state.files && state.files.files ? state.files.files : [];
    if (!list.length) {
      changesEl.innerHTML = '<div class="empty">No files changed yet this session.</div>';
      return;
    }
    var html = '<div class="thread-head">Files · ' + esc(String(list.length)) + '</div>';
    for (var i = list.length - 1; i >= 0; i--) {
      var file = list[i] || {};
      var path = String(file.path || '');
      var cut = path.lastIndexOf('/');
      var dir = cut >= 0 ? path.slice(0, cut + 1) : '';
      var name = cut >= 0 ? path.slice(cut + 1) : path;
      html += '<div class="file-row ' + esc(String(file.status || 'ok')) + '">';
      html += '<span class="file-dot"></span>';
      html += '<span class="file-name"><span class="file-dir">' + esc(dir) + '</span>' + esc(name) + '</span>';
      html += '<span class="file-tool">' + esc(String(file.tool || '') + ' ×' + String(file.edits || 1)) + '</span>';
      html += '</div>';
    }
    if (state.files && state.files.truncated) {
      html += '<div class="msg-tools-more">Showing the ' + esc(String(list.length)) + ' most recently touched files</div>';
    }
    changesEl.innerHTML = html;
  }

  /** Replay on (re)connect: a phone that joins mid-run missed every files frame. */
  function loadFiles() {
    fetch('/files', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload || !payload.files) { return; }
        state.files = { files: payload.files, truncated: payload.truncated === true };
        renderChanges();
        syncFilesBadge();
      })
      .catch(function () { /* keep whatever was already rendered */ });
  }

  /**
   * The mirrored conversation, replayed on every (re)connect.
   *
   * Same reason as loadTurn: the stream only carries what happens after it
   * opens, so a phone that joins mid-thread — or whose screen slept and
   * reconnected — would otherwise never see the choice block at all.
   */
  function loadTranscript() {
    fetch('/transcript', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        var rows = (payload && payload.messages) || [];
        state.transcriptOrder = [];
        state.transcriptMessages = {};
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          upsertTranscript(rows[rowIndex]);
        }
        renderTranscript();
      })
      .catch(function () { /* the stream still delivers new messages */ });
  }

  /** POST text to the host — a tapped choice, or a typed reply. */
  function sendChat(text, done, choiceRequestId) {
    fetch('/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, choiceRequestId: choiceRequestId })
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          done(response.ok, payload || {});
        });
      })
      .catch(function () { done(false, {}); });
  }

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
  setInterval(tickTools, 1000);

  // Tapping a choice in the mirrored thread answers it the same way the
  // desktop card does: the option becomes the next user message.
  transcriptEl.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('button[data-choice]') : null;
    if (!button || button.disabled) { return; }
    var option = button.getAttribute('data-choice');
    var messageId = button.getAttribute('data-msg');
    button.disabled = true;
    state.answered[messageId] = option;
    renderTranscript();
    // NAME the card we answered. The host closes the desktop card from this id,
    // so a phone that tapped an older card cannot close the newest one.
    var answeredMessage = state.transcriptMessages[messageId];
    var choiceRequestId = answeredMessage && answeredMessage.choice
      ? answeredMessage.choice.requestId
      : undefined;
    sendChat(option, function (ok, payload) {
      if (ok) { return; }
      delete state.answered[messageId];
      renderTranscript();
      showBanner((payload && payload.error) || 'VS Code refused that choice.', true);
    }, choiceRequestId);
  });

  var composerForm = document.getElementById('composer');
  var composerInput = document.getElementById('composer-input');
  if (composerForm && composerInput) {
    composerForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = composerInput.value.trim();
      if (!text) { return; }
      composerInput.value = '';
      setSendState('sending');
      sendChat(text, function (ok, payload) {
        if (ok) { setSendState('sent'); return; }
        setSendState('failed');
        if (!composerInput.value) { composerInput.value = text; }
        showBanner((payload && payload.error) || 'VS Code refused that message.', true);
      });
    });
  }

  /**
   * The Send button narrates its own request.
   *
   * A phone on a slow tunnel gives no other feedback that a reply left: the
   * spinner says it is in flight, the tick says it landed, the arrow-plus-red
   * says it did not and is worth tapping again.
   */
  function setSendState(next) {
    if (!sendBtn) { return; }
    sendBtn.setAttribute('data-state', next);
    if (sendIcon) {
      sendIcon.textContent = next === 'sending' ? '⟳' : next === 'sent' ? '✓' : next === 'failed' ? '↻' : '➤';
    }
    if (sendLabel) {
      sendLabel.textContent = next === 'sending' ? 'Sending' : next === 'sent' ? 'Sent' : next === 'failed' ? 'Retry' : 'Send';
    }
    // Disabled while in flight: a double tap must not post the reply twice.
    sendBtn.disabled = next === 'sending';
    if (next === 'sent') {
      setTimeout(function () {
        if (sendBtn.getAttribute('data-state') === 'sent') { setSendState('idle'); }
      }, 1400);
    }
  }

  // Tick the turn clock without a full re-render (a render would drop the
  // reader's scroll position on every second).
  setInterval(function () {
    var clock = document.getElementById('turn-clock');
    if (clock && state.turn) { clock.textContent = elapsedText(state.turn.startedAt); }
  }, 1000);

  function connect() {
    if (state.source) { state.source.close(); }
    var source = new EventSource('/events');
    state.source = source;
    source.onopen = function () {
      state.connected = true;
      showBanner('');
      render();
      loadPending();
      loadRuns();
      loadTurn();
      loadPlan();
      loadFiles();
      loadTranscript();
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
    // A route may ride in the same fragment (t=...&view=runs): the token ends
    // at the first parameter separator.
    return decodeURIComponent(hash.slice(3).split('&')[0]);
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
    // The route is captured before the token fragment is scrubbed: a QR scan may
    // land on any view, and a reload must not bounce back to Thread.
    var initialView = parseView();
    var token = readToken();
    if (!token) {
      applyView(initialView, true);
      resumeSession().then(function (ok) {
        if (ok) { connect(); return; }
        showBanner('This link is missing its access token. Re-open the QR code from VS Code.', true);
      });
      return;
    }
    clearTokenFromAddressBar();
    applyView(initialView, true);
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

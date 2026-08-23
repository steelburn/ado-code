import * as vscode from 'vscode';
import { AgentRun } from '../agents/types';
import { renderMarkdown } from './markdown';

/** Human-friendly agent names (shared with AgentSummaryPanel). */
export function agentDisplayName(agent: string): string {
  const names: Record<string, string> = {
    'claude': 'Claude Code',
    'codex': 'Codex',
    'opencode': 'OpenCode',
    'hermes': 'Hermes',
    'pi': 'Pi',
    'openclaw': 'OpenClaw',
    'aider': 'Aider',
    'gemini': 'Gemini',
    'cursor-agent': 'Cursor',
    'dsh': 'DeepSeek Harness',
  };
  return names[agent] ?? agent;
}

/**
 * LIVE agent progress panel in the editor area.
 *
 * A script-enabled webview panel (one per run, deduped by run id) that shows
 * agent delegation progress in real time: status badge, live elapsed clock,
 * animated progress bar while running, timestamped streaming log with event
 * styling, and a markdown-rendered summary on completion.
 *
 * Host → panel messages:
 *   { type: 'init', run, output?, summaryHtml? }   — full state (on show)
 *   { type: 'append', delta }                      — streamed chunk
 *   { type: 'complete', run, summaryHtml }         — final state + summary
 *
 * Panel → host:
 *   { type: 'ready' }                              — webview JS loaded; host
 *                                                    flushes the pending init
 *
 * The 'ready' handshake closes the classic webview race where messages posted
 * before the HTML loads are silently dropped: update()/complete() calls that
 * arrive before 'ready' are folded into the pending init buffer.
 */
export class AgentProgressPanel {
  private static readonly keyPrefix = 'adoCode.agentProgress.';

  private static panels = new Map<string, vscode.WebviewPanel>();
  // Init payload waiting for the webview's 'ready' handshake (webview not
  // loaded yet — messages posted now would be dropped).
  private static pending = new Map<string, { run: AgentRun; output: string; summaryHtml?: string }>();

  private static key(runId: string): string {
    return AgentProgressPanel.keyPrefix + runId;
  }

  /** True when a live progress panel is open for this run. */
  static has(runId: string): boolean {
    return AgentProgressPanel.panels.has(AgentProgressPanel.key(runId));
  }

  /**
   * Open (or reveal) the live progress panel for a run. `initialOutput` is the
   * accumulated output so far (backfill for panels opened mid-run).
   */
  static show(_context: vscode.ExtensionContext, run: AgentRun, initialOutput?: string): void {
    const panelId = AgentProgressPanel.key(run.id);
    const existing = AgentProgressPanel.panels.get(panelId);
    const summaryHtml = run.summary ? renderMarkdown(run.summary) : undefined;

    if (existing) {
      existing.reveal(vscode.ViewColumn.Beside);
      const pend = AgentProgressPanel.pending.get(panelId);
      if (pend) {
        // Webview still loading (handshake not done) — refresh the pending
        // init so it carries the freshest run/output when 'ready' fires.
        pend.run = run;
        pend.output = initialOutput ?? pend.output;
        if (summaryHtml) pend.summaryHtml = summaryHtml;
      } else {
        existing.webview.postMessage({ type: 'init', run, output: initialOutput ?? '', summaryHtml });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      panelId,
      AgentProgressPanel.formatTitle(run),
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = AgentProgressPanel.renderHtml();
    panel.onDidDispose(() => {
      AgentProgressPanel.panels.delete(panelId);
      AgentProgressPanel.pending.delete(panelId);
    });
    AgentProgressPanel.panels.set(panelId, panel);
    AgentProgressPanel.pending.set(panelId, { run, output: initialOutput ?? '', summaryHtml });

    // Handshake: the webview posts 'ready' once its message listener is live;
    // only then flush the init payload.
    panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg?.type !== 'ready') return;
      const payload = AgentProgressPanel.pending.get(panelId);
      if (payload) {
        panel.webview.postMessage({ type: 'init', run: payload.run, output: payload.output, summaryHtml: payload.summaryHtml });
        AgentProgressPanel.pending.delete(panelId);
      }
    });
  }

  /** Stream a chunk to the panel (cheap no-op when the panel is closed). */
  static update(run: AgentRun, delta: string): void {
    if (!delta) return;
    const panelId = AgentProgressPanel.key(run.id);
    const panel = AgentProgressPanel.panels.get(panelId);
    if (!panel) return;
    // Webview not loaded yet — fold the chunk into the pending init so
    // nothing is dropped during the handshake window.
    const pend = AgentProgressPanel.pending.get(panelId);
    if (pend) {
      pend.output += delta;
      return;
    }
    panel.webview.postMessage({ type: 'append', delta });
  }

  /** Push the final state + summary into the panel (no-op when closed). */
  static complete(run: AgentRun, summary: string): void {
    const panelId = AgentProgressPanel.key(run.id);
    const panel = AgentProgressPanel.panels.get(panelId);
    if (!panel) return;
    const pend = AgentProgressPanel.pending.get(panelId);
    if (pend) {
      // Handshake not done yet — let the init carry the final state.
      pend.run = run;
      pend.summaryHtml = renderMarkdown(summary);
      return;
    }
    panel.webview.postMessage({ type: 'complete', run, summaryHtml: renderMarkdown(summary) });
    panel.title = AgentProgressPanel.formatTitle(run);
  }

  private static formatTitle(run: AgentRun): string {
    const icon =
      run.status === 'succeeded' ? '✓' :
      run.status === 'failed' ? '✗' :
      run.status === 'cancelled' ? '⊘' : '●';
    const agentLabel = agentDisplayName(run.agent);
    const wiLabel = run.workItemId ? ` — ADO-${run.workItemId}` : '';
    return `${icon} ${agentLabel}${wiLabel}`;
  }

  private static renderHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Agent Progress</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 14px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      margin: 0;
      padding: 16px 24px 24px;
      max-width: 1100px;
      margin: 0 auto;
      line-height: 1.5;
    }
    .header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .agent-name { font-weight: 600; font-size: 1.15em; }
    .badge {
      padding: 1px 8px; border-radius: 10px; font-size: 0.8em; font-weight: 600;
      background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #ccc);
      max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .status-badge { padding: 2px 12px; border-radius: 12px; font-size: 0.82em; font-weight: 600; color: #fff; }
    .status-badge.running { background: var(--vscode-progressBar-background, #0e639c); }
    .status-badge.succeeded { background: #2e7d32; }
    .status-badge.failed { background: #c62828; }
    .status-badge.cancelled { background: #616161; }
    .status-badge.interrupted { background: #f9a825; color: #1e1e1e; }
    .elapsed {
      margin-left: auto; font-variant-numeric: tabular-nums;
      color: var(--vscode-descriptionForeground, #999); font-size: 0.95em;
    }
    .elapsed .clock { font-weight: 600; color: var(--vscode-foreground, #ccc); }

    .progress-row { margin: 4px 0 12px; height: 4px; border-radius: 2px; overflow: hidden;
      background: var(--vscode-progressBar-background, #0e639c); opacity: 0.35; }
    .progress-bar { width: 40%; height: 100%; border-radius: 2px;
      background: var(--vscode-progressBar-background, #0e639c);
      animation: slide 1.1s ease-in-out infinite; }
    @keyframes slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(350%); }
    }

    .toolbar { display: flex; gap: 6px; margin: 10px 0 8px; align-items: center; }
    .tool-btn {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: none; border-radius: 4px; padding: 3px 10px; font-size: 0.8em;
      cursor: pointer;
    }
    .tool-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .tool-btn.off { opacity: 0.55; }
    .toolbar .spacer { flex: 1; }

    h2 {
      font-size: 0.95em; margin: 14px 0 6px; color: var(--vscode-descriptionForeground, #999);
      text-transform: uppercase; letter-spacing: 0.06em;
    }

    .summary-box {
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 6px; padding: 12px 16px; margin-bottom: 4px;
      background: var(--vscode-editorWidget-background, #252526);
    }
    .summary-box h1 { font-size: 1.3em; margin: 8px 0; }
    .summary-box h2 { text-transform: none; letter-spacing: 0; margin: 16px 0 6px;
      border-bottom: 1px solid var(--vscode-widget-border, #333); padding-bottom: 4px; color: var(--vscode-foreground, #ccc); }
    .summary-box h3 { margin: 10px 0 4px; color: var(--vscode-descriptionForeground, #999); }
    .summary-box p { margin: 6px 0; }
    .summary-box ul, .summary-box ol { margin: 6px 0; padding-left: 22px; }
    .summary-box li { margin: 3px 0; }
    .summary-box pre {
      background: var(--vscode-textCodeBlock-background, #2d2d2d); padding: 10px;
      border-radius: 5px; overflow-x: auto; font-size: 0.88em;
    }
    .summary-box code {
      background: var(--vscode-textCodeBlock-background, #2d2d2d);
      padding: 1px 5px; border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
    }
    .summary-box pre code { padding: 0; background: none; }
    .summary-box a { color: var(--vscode-textLink-foreground, #3794ff); }
    .summary-box em { color: var(--vscode-descriptionForeground, #999); }
    .summary-box hr { border: none; border-top: 1px solid var(--vscode-widget-border, #333); }

    .log {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.86em;
      background: var(--vscode-textCodeBlock-background, #1f1f1f);
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 6px;
      padding: 8px 0;
      height: 320px;
      overflow-y: auto;
      line-height: 1.55;
    }
    .log-row { display: flex; gap: 10px; padding: 0 12px; white-space: pre-wrap; word-break: break-all; }
    .log-row.event { background: color-mix(in srgb, var(--vscode-progressBar-background, #0e639c) 14%, transparent); }
    .log-ts {
      color: var(--vscode-descriptionForeground, #777);
      flex-shrink: 0; user-select: none;
    }
    .log-empty { color: var(--vscode-descriptionForeground, #999); font-style: italic; padding: 8px 12px; }

    .jump-btn {
      position: fixed; right: 28px; bottom: 24px;
      background: var(--vscode-button-background, #0e639c); color: #fff;
      border: none; border-radius: 14px; padding: 6px 14px; font-size: 0.85em;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="agent-name">🤖 <span id="agentName">…</span></span>
    <span class="badge" id="wiBadge" hidden></span>
    <span class="badge" id="branchBadge" hidden></span>
    <span class="status-badge running" id="statusBadge">Starting…</span>
    <span class="elapsed">elapsed <span class="clock" id="elapsed">0:00</span></span>
  </div>

  <div class="progress-row" id="progressRow" hidden><div class="progress-bar"></div></div>

  <div class="toolbar" id="toolbar" hidden>
    <button class="tool-btn" id="btnFollow">⤓ Follow</button>
    <button class="tool-btn" id="btnClear">Clear</button>
    <button class="tool-btn" id="btnCopy">Copy</button>
    <span class="spacer"></span>
    <span id="lineCount" style="color: var(--vscode-descriptionForeground,#999); font-size:0.78em;"></span>
  </div>

  <h2 id="summaryHeading" hidden>Summary</h2>
  <div class="summary-box" id="summary" hidden></div>

  <h2>Output</h2>
  <div class="log" id="log"><div class="log-empty" id="emptyHint">Waiting for agent output…</div></div>

  <button class="jump-btn" id="jumpBtn" hidden>↓ Jump to bottom</button>

  <script>
    (function () {
      var vscode = acquireVsCodeApi();
      var MAX_LINES = 2000;
      var lineCount = 0;
      var following = true;
      var startedAt = null;
      var ticker = null;

      var logEl = document.getElementById('log');
      var emptyHint = document.getElementById('emptyHint');

      function pad(n) { return n < 10 ? '0' + n : '' + n; }

      function fmtClock(ms) {
        if (!isFinite(ms) || ms < 0) ms = 0;
        var s = Math.floor(ms / 1000);
        var m = Math.floor(s / 60);
        var h = Math.floor(m / 60);
        s = s % 60; m = m % 60;
        return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
      }

      function fmtStamp(d) {
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      }

      function isEventLine(line) {
        return /^(worktree created:|worktree failed,|delegating to|pre-agent hook|cancelled by user|warning:)/.test(line);
      }

      function appendOutput(text) {
        if (text && emptyHint) { emptyHint.remove(); }
        var lines = text.split('\\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].replace(/\\r$/, '');
          if (!line.trim()) continue;
          var row = document.createElement('div');
          row.className = 'log-row' + (isEventLine(line) ? ' event' : '');
          var ts = document.createElement('span');
          ts.className = 'log-ts';
          ts.textContent = fmtStamp(new Date());
          var body = document.createElement('span');
          body.className = 'log-body';
          body.textContent = line; // textContent only — never innerHTML with agent output
          row.appendChild(ts);
          row.appendChild(body);
          logEl.appendChild(row);
          if (++lineCount > MAX_LINES) {
            logEl.removeChild(logEl.firstChild);
            lineCount--;
          }
        }
        var lc = document.getElementById('lineCount');
        if (lc) lc.textContent = lineCount + ' lines';
        if (following) logEl.scrollTop = logEl.scrollHeight;
      }

      function statusLabel(status) {
        return ({ running: 'Running', succeeded: 'Completed', failed: 'Failed',
                  cancelled: 'Cancelled', interrupted: 'Interrupted' })[status] || status;
      }

      function startTicker() {
        if (ticker || startedAt === null) return;
        ticker = setInterval(function () {
          document.getElementById('elapsed').textContent = fmtClock(Date.now() - startedAt);
        }, 1000);
      }

      function stopTicker(ms) {
        if (ticker) { clearInterval(ticker); ticker = null; }
        document.getElementById('elapsed').textContent = fmtClock(ms);
      }

      function renderSummary(html) {
        document.getElementById('summaryHeading').hidden = false;
        var box = document.getElementById('summary');
        box.hidden = false;
        box.innerHTML = html; // safe: host renders via renderMarkdown (escapes first)
      }

      window.addEventListener('message', function (e) {
        var msg = e.data;
        if (!msg || !msg.type) return;
        switch (msg.type) {
          case 'init': {
            var run = msg.run;
            document.getElementById('agentName').textContent = run.agent || run.id;
            if (run.workItemId) {
              document.getElementById('wiBadge').textContent = 'ADO-' + run.workItemId;
              document.getElementById('wiBadge').hidden = false;
            }
            if (run.branch) {
              document.getElementById('branchBadge').textContent = run.branch;
              document.getElementById('branchBadge').title = run.worktreePath || '';
              document.getElementById('branchBadge').hidden = false;
            }
            var running = run.status === 'running';
            var badge = document.getElementById('statusBadge');
            badge.textContent = statusLabel(run.status);
            badge.className = 'status-badge ' + run.status;
            document.getElementById('progressRow').hidden = !running;
            document.getElementById('toolbar').hidden = false;
            var start = new Date(run.startedAt).getTime();
            startedAt = isFinite(start) ? start : Date.now();
            if (msg.output) appendOutput(msg.output);
            if (msg.summaryHtml) {
              renderSummary(msg.summaryHtml);
              stopTicker(Date.now() - startedAt);
            } else if (running) {
              startTicker();
            } else {
              stopTicker(0);
            }
            break;
          }
          case 'append':
            appendOutput(msg.delta);
            break;
          case 'complete': {
            if (msg.summaryHtml) renderSummary(msg.summaryHtml);
            var fin = new Date(msg.run.finishedAt || Date.now()).getTime();
            if (startedAt !== null && isFinite(fin)) stopTicker(fin - startedAt);
            var badge = document.getElementById('statusBadge');
            badge.textContent = statusLabel(msg.run.status);
            badge.className = 'status-badge ' + msg.run.status;
            document.getElementById('progressRow').hidden = true;
            break;
          }
        }
      });

      // Toolbar
      document.getElementById('btnFollow').onclick = function () {
        following = !following;
        this.classList.toggle('off', !following);
        if (following) { logEl.scrollTop = logEl.scrollHeight; document.getElementById('jumpBtn').hidden = true; }
      };
      document.getElementById('btnClear').onclick = function () {
        logEl.innerHTML = '';
        lineCount = 0;
        var lc = document.getElementById('lineCount');
        if (lc) lc.textContent = '';
      };
      document.getElementById('btnCopy').onclick = function () {
        var parts = [];
        var rows = logEl.querySelectorAll('.log-row');
        for (var i = 0; i < rows.length; i++) {
          var body = rows[i].querySelector('.log-body');
          if (body) parts.push(body.textContent);
        }
        if (navigator.clipboard && parts.length) {
          navigator.clipboard.writeText(parts.join('\\n')).catch(function () {});
        }
      };
      logEl.addEventListener('scroll', function () {
        var nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
        if (!nearBottom && following) {
          following = false;
          document.getElementById('btnFollow').classList.add('off');
        }
        document.getElementById('jumpBtn').hidden = nearBottom || following;
      });
      document.getElementById('jumpBtn').onclick = function () {
        following = true;
        logEl.scrollTop = logEl.scrollHeight;
        this.hidden = true;
        document.getElementById('btnFollow').classList.remove('off');
      };

      // Handshake: tell the host the listener is live so it can flush init.
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}

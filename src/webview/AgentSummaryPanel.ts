import * as vscode from 'vscode';
import { AgentRun } from '../agents/types';

/**
 * Webview panel that shows agent run summaries in the editor area.
 * Rendered as a nicely formatted HTML page with markdown-like sections,
 * similar to WorkItemDetailPanel but for agent results.
 */
export class AgentSummaryPanel {
  // Per-run panel tracking so show() reveals an existing panel instead of
  // piling up duplicates (the panel id alone does NOT dedupe in VS Code).
  private static panels = new Map<string, vscode.WebviewPanel>();

  /**
   * Show the agent summary in the editor area. If a panel for this run
   * already exists, reveal it (and refresh its content) instead of creating
   * a duplicate.
   */
  public static show(context: vscode.ExtensionContext, run: AgentRun, summary: string): void {
    if (!summary) return;

    const panelId = `adoCode.agentSummary.${run.id}`;
    const title = AgentSummaryPanel.formatTitle(run);

    const existing = AgentSummaryPanel.panels.get(panelId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Beside);
      existing.webview.html = AgentSummaryPanel.renderHtml(run, summary);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      panelId,
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );

    panel.webview.html = AgentSummaryPanel.renderHtml(run, summary);
    panel.onDidDispose(() => AgentSummaryPanel.panels.delete(panelId));
    AgentSummaryPanel.panels.set(panelId, panel);
  }

  private static formatTitle(run: AgentRun): string {
    const agentLabel = AgentSummaryPanel.agentDisplayName(run.agent);
    const wiLabel = run.workItemId ? ` — ADO-${run.workItemId}` : '';
    const statusIcon = run.status === 'succeeded' ? '✓' :
                       run.status === 'failed' ? '✗' :
                       run.status === 'cancelled' ? '⊘' : '●';
    return `${statusIcon} ${agentLabel}${wiLabel}`;
  }

  private static agentDisplayName(agent: string): string {
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
    };
    return names[agent] ?? agent;
  }

  private static renderHtml(run: AgentRun, summary: string): string {
    const agentLabel = AgentSummaryPanel.agentDisplayName(run.agent);
    const statusColor = run.status === 'succeeded' ? '#4caf50' :
                        run.status === 'failed' ? '#f44336' :
                        run.status === 'cancelled' ? '#9e9e9e' : '#ff9800';
    const statusLabel = run.status.charAt(0).toUpperCase() + run.status.slice(1);

    const duration = AgentSummaryPanel.formatDuration(run.startedAt, run.finishedAt);

    // Convert markdown-ish summary to HTML
    const summaryHtml = AgentSummaryPanel.renderMarkdown(summary);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${AgentSummaryPanel.escapeHtml(AgentSummaryPanel.formatTitle(run))}</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 14px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 24px 32px;
      max-width: 900px;
      margin: 0 auto;
      line-height: 1.6;
    }
    h1 { margin: 0 0 4px 0; font-size: 1.5em; }
    h2 {
      font-size: 1.15em;
      margin: 24px 0 8px 0;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
      padding-bottom: 4px;
    }
    h3 { font-size: 1em; margin: 12px 0 4px 0; color: var(--vscode-descriptionForeground, #999); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .agent-name { font-weight: 600; font-size: 1.1em; }
    .work-item-id {
      color: var(--vscode-descriptionForeground, #999);
      font-size: 0.9em;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.82em;
      font-weight: 600;
      color: #fff;
      background: ${statusColor};
    }
    .meta {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 4px 12px;
      margin: 12px 0;
      font-size: 0.9em;
    }
    .meta-label { color: var(--vscode-descriptionForeground, #999); text-align: right; }
    .section { margin: 20px 0; }
    .summary-content { margin: 8px 0; }
    .summary-content p { margin: 8px 0; }
    .summary-content ul, .summary-content ol { margin: 8px 0; padding-left: 24px; }
    .summary-content li { margin: 4px 0; }
    .summary-content strong { color: var(--vscode-foreground, #ccc); }
    .summary-content em { color: var(--vscode-descriptionForeground, #999); }
    code {
      background: var(--vscode-textCodeBlock-background, #2d2d2d);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }
    pre {
      background: var(--vscode-textCodeBlock-background, #2d2d2d);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.88em;
    }
    pre code { padding: 0; background: none; }
    a { color: var(--vscode-textLink-foreground, #3794ff); }
    em { color: var(--vscode-descriptionForeground, #999); }
    .section-divider {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, #333);
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="agent-name">🤖 ${AgentSummaryPanel.escapeHtml(agentLabel)}</span>
    ${run.workItemId ? `<span class="work-item-id">ADO-${run.workItemId}</span>` : ''}
    <span class="status-badge">${AgentSummaryPanel.escapeHtml(statusLabel)}</span>
  </div>

  <div class="meta">
    <span class="meta-label">Started</span>
    <span>${AgentSummaryPanel.formatDate(run.startedAt)}</span>
    ${run.finishedAt ? `<span class="meta-label">Finished</span><span>${AgentSummaryPanel.formatDate(run.finishedAt)}</span>` : ''}
    ${duration ? `<span class="meta-label">Duration</span><span>${duration}</span>` : ''}
    ${run.sessionId ? `<span class="meta-label">Session</span><span><code>${AgentSummaryPanel.escapeHtml(run.sessionId)}</code></span>` : ''}
  </div>

  <hr class="section-divider">

  <div class="section">
    <h2>Summary</h2>
    <div class="summary-content">${summaryHtml}</div>
  </div>
</body>
</html>`;
  }

  /** Render markdown-ish text to HTML (simple conversion). */
  private static renderMarkdown(text: string): string {
    if (!text) return '<em>No summary</em>';

    let html = text;

    // Escape HTML entities first (except what we'll generate)
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Line breaks → paragraphs (double newline)
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph if not already wrapped
    if (!html.startsWith('<')) {
      html = `<p>${html}</p>`;
    }

    return html;
  }

  private static formatDuration(start?: string, end?: string): string {
    if (!start || !end) return '';
    try {
      const ms = new Date(end).getTime() - new Date(start).getTime();
      if (ms < 1000) return `${ms}ms`;
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return `${secs}s`;
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      return `${mins}m ${remSecs}s`;
    } catch {
      return '';
    }
  }

  private static formatDate(dateStr?: string): string {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      return dateStr;
    }
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

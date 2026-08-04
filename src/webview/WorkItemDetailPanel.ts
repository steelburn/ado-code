import * as vscode from 'vscode';
import { AdoClient } from '../ado/client';
import { getActiveOrg, getSettings } from '../config/settings';

/**
 * Webview panel that shows full work item details in the main editor area.
 * Rendered as a read-only markdown document with nicely formatted sections.
 */
export class WorkItemDetailPanel {
  public static show(context: vscode.ExtensionContext, ado: AdoClient, workItemId: number): void {
    const panel = vscode.window.createWebviewPanel(
      'adoCode.workItemDetail',
      `ADO-${workItemId}`,
      vscode.ViewColumn.One,
      { enableScripts: false }
    );

    panel.webview.html = WorkItemDetailPanel.loadingHtml(workItemId);

    // Fetch and render
    WorkItemDetailPanel.fetchAndRender(context, ado, workItemId, panel);
  }

  private static async fetchAndRender(
    context: vscode.ExtensionContext,
    ado: AdoClient,
    workItemId: number,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const settings = getSettings();
    const active = getActiveOrg(context, settings);
    if (!active.name || !active.project || !settings.adoPat) {
      panel.webview.html = WorkItemDetailPanel.errorHtml('Configure organization, project and PAT first.');
      return;
    }

    try {
      const { detail, comments, creator } = await ado.getWorkItemWithDiscussion(active.project, workItemId);
      const f = detail.fields;

      const state = f['System.State'] ?? '';
      const type = f['System.WorkItemType'] ?? '';
      const title = f['System.Title'] ?? '';
      const assignedTo = f['System.AssignedTo']?.displayName ?? '—';
      const areaPath = f['System.AreaPath'] ?? '—';
      const iterationPath = f['System.IterationPath'] ?? '—';
      const createdDate = f['System.CreatedDate'] ?? '';
      const changedDate = f['System.ChangedDate'] ?? '';
      const description = f['System.Description'] ?? '';
      const ac = f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '';
      const tags = f['System.Tags'] ?? '';
      const reproSteps = f['Microsoft.VSTS.TCM.ReproSteps'] ?? '';
      const systemInfo = f['Microsoft.VSTS.TCM.SystemInfo'] ?? '';

      // State color
      const stateColor = state === 'Done' || state === 'Closed'
        ? '#4caf50'
        : state === 'Active'
        ? '#2196f3'
        : '#ff9800';

      // Build comments HTML
      let commentsHtml = '';
      if (comments.length > 0) {
        const commentItems = comments.map(c => `
          <div class="comment">
            <div class="comment-header">
              <span class="comment-author">${WorkItemDetailPanel.escapeHtml(c.createdBy.displayName)}</span>
              <span class="comment-date">${WorkItemDetailPanel.formatDate(c.createdDate)}</span>
            </div>
            <div class="comment-body">${WorkItemDetailPanel.renderAdoHtml(c.text)}</div>
          </div>
        `).join('');
        commentsHtml = `
          <div class="section">
            <h2>Discussion (${comments.length})</h2>
            ${commentItems}
          </div>
        `;
      }

      // Bug-specific fields
      let bugFieldsHtml = '';
      if (reproSteps || systemInfo) {
        bugFieldsHtml = `
          <div class="section">
            <h2>Bug Details</h2>
            ${reproSteps ? `<h3>Repro Steps</h3><div class="field-content">${WorkItemDetailPanel.renderAdoHtml(reproSteps)}</div>` : ''}
            ${systemInfo ? `<h3>System Info</h3><div class="field-content">${WorkItemDetailPanel.renderAdoHtml(systemInfo)}</div>` : ''}
          </div>
        `;
      }

      panel.webview.html = WorkItemDetailPanel.renderHtml({
        workItemId,
        title,
        type,
        state,
        stateColor,
        assignedTo,
        creator: creator?.displayName ?? '—',
        areaPath,
        iterationPath,
        createdDate,
        changedDate,
        description,
        acceptanceCriteria: ac,
        tags,
        commentsHtml,
        bugFieldsHtml,
      });

      // Update tab title with type
      panel.title = `${type} #${workItemId}`;
    } catch (err) {
      panel.webview.html = WorkItemDetailPanel.errorHtml(
        `Failed to load ADO-${workItemId}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  private static renderHtml(d: {
    workItemId: number; title: string; type: string; state: string; stateColor: string;
    assignedTo: string; creator: string; areaPath: string; iterationPath: string;
    createdDate: string; changedDate: string; description: string;
    acceptanceCriteria: string; tags: string; commentsHtml: string; bugFieldsHtml: string;
  }): string {
    const descHtml = d.description ? WorkItemDetailPanel.renderAdoHtml(d.description) : '<em>No description</em>';
    const acHtml = d.acceptanceCriteria ? WorkItemDetailPanel.renderAdoHtml(d.acceptanceCriteria) : '<em>None</em>';
    const tagsHtml = d.tags
      ? d.tags.split(';').map(t => `<span class="tag">${WorkItemDetailPanel.escapeHtml(t.trim())}</span>`).join(' ')
      : '<em>None</em>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADO-${d.workItemId}</title>
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
    h2 { font-size: 1.15em; margin: 24px 0 8px 0; border-bottom: 1px solid var(--vscode-widget-border, #333); padding-bottom: 4px; }
    h3 { font-size: 1em; margin: 12px 0 4px 0; color: var(--vscode-descriptionForeground, #999); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .id { color: var(--vscode-descriptionForeground, #999); font-size: 0.9em; }
    .type { color: var(--vscode-descriptionForeground, #999); font-size: 0.85em; }
    .state {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.82em;
      font-weight: 600;
      color: #fff;
      background: ${d.stateColor};
    }
    .meta { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; margin: 12px 0; font-size: 0.9em; }
    .meta-label { color: var(--vscode-descriptionForeground, #999); text-align: right; }
    .section { margin: 20px 0; }
    .field-content { margin: 4px 0 12px 0; }
    .tag {
      display: inline-block;
      padding: 1px 8px;
      margin: 2px 4px 2px 0;
      border-radius: 4px;
      font-size: 0.82em;
      background: var(--vscode-badge-background, #333);
      color: var(--vscode-badge-foreground, #ccc);
    }
    .comment {
      margin: 8px 0;
      padding: 8px 12px;
      border-left: 3px solid var(--vscode-widget-border, #333);
      background: var(--vscode.sideBarBackground, #252526);
      border-radius: 0 4px 4px 0;
    }
    .comment-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
    .comment-author { font-weight: 600; font-size: 0.9em; }
    .comment-date { color: var(--vscode-descriptionForeground, #999); font-size: 0.82em; }
    .comment-body { font-size: 0.92em; }
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
  </style>
</head>
<body>
  <div class="header">
    <span class="type">${WorkItemDetailPanel.escapeHtml(d.type)}</span>
    <span class="id">#${d.workItemId}</span>
    <span class="state">${WorkItemDetailPanel.escapeHtml(d.state)}</span>
  </div>
  <h1>${WorkItemDetailPanel.escapeHtml(d.title)}</h1>

  <div class="meta">
    <span class="meta-label">Assigned To</span><span>${WorkItemDetailPanel.escapeHtml(d.assignedTo)}</span>
    <span class="meta-label">Created By</span><span>${WorkItemDetailPanel.escapeHtml(d.creator)}</span>
    <span class="meta-label">Area Path</span><span>${WorkItemDetailPanel.escapeHtml(d.areaPath)}</span>
    <span class="meta-label">Iteration</span><span>${WorkItemDetailPanel.escapeHtml(d.iterationPath)}</span>
    <span class="meta-label">Created</span><span>${WorkItemDetailPanel.formatDate(d.createdDate)}</span>
    <span class="meta-label">Changed</span><span>${WorkItemDetailPanel.formatDate(d.changedDate)}</span>
    <span class="meta-label">Tags</span><span>${tagsHtml}</span>
  </div>

  <div class="section">
    <h2>Description</h2>
    <div class="field-content">${descHtml}</div>
  </div>

  <div class="section">
    <h2>Acceptance Criteria</h2>
    <div class="field-content">${acHtml}</div>
  </div>

  ${d.bugFieldsHtml}

  ${d.commentsHtml}
</body>
</html>`;
  }

  private static loadingHtml(workItemId: number): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.loading{color:var(--vscode-descriptionForeground);font-size:1.1em;}
</style></head><body><div class="loading">Loading ADO-${workItemId}…</div></body></html>`;
  }

  private static errorHtml(message: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.error{color:var(--vscode-errorForeground,#f44);font-size:1.1em;}
</style></head><body><div class="error">${WorkItemDetailPanel.escapeHtml(message)}</div></body></html>`;
  }

  /** Render ADO HTML content: sanitize dangerous tags, make images responsive. */
  private static renderAdoHtml(text: string): string {
    if (!text) return '';
    let html = text;
    // Strip dangerous tags (script, iframe, object, embed, form, input, style)
    html = html.replace(/<\s*(script|iframe|object|embed|form|input|style|textarea|select|button)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    html = html.replace(/<\s*(script|iframe|object|embed|form|input|style|textarea|select|button)[^>]*\/?>/gi, '');
    // Strip on* event handlers
    html = html.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // Make images responsive and visible
    html = html.replace(/<img\s/gi, '<img style="max-width:100%;height:auto;border-radius:4px;margin:4px 0;display:block;" ');
    // Make tables readable
    html = html.replace(/<table/gi, '<table style="border-collapse:collapse;width:100%;margin:8px 0;"');
    html = html.replace(/<th/gi, '<th style="border:1px solid var(--vscode-widget-border,#333);padding:6px 10px;text-align:left;background:var(--vscode-sideBarBackground,#252526);"');
    html = html.replace(/<td/gi, '<td style="border:1px solid var(--vscode-widget-border,#333);padding:6px 10px;"');
    return html;
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private static formatDate(dateStr?: string): string {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  }
}

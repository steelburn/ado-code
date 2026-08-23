import * as vscode from 'vscode';
import { AgentCapability, AgentName } from '../agents/types';
import { AGENT_SPECS } from '../agents/registry';

/**
 * Webview panel that shows detailed information about a specific agent,
 * including its binary, version, supported modes, and CLI args.
 */
export class AgentDetailPanel {
  private static panel?: vscode.WebviewPanel;

  /**
   * Show agent details in a webview panel. If the panel already exists,
   * reveal it and refresh content instead of creating a duplicate.
   */
  public static show(
    agentName: string,
    capability: AgentCapability
  ): void {
    const spec = AGENT_SPECS[agentName as AgentName];
    const title = `Agent: ${capability.displayName}`;

    if (AgentDetailPanel.panel) {
      AgentDetailPanel.panel.reveal(vscode.ViewColumn.Beside);
      AgentDetailPanel.panel.webview.html = AgentDetailPanel.renderHtml(
        capability,
        spec
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'adoCode.agentDetail',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );

    panel.webview.html = AgentDetailPanel.renderHtml(capability, spec);
    panel.onDidDispose(() => {
      AgentDetailPanel.panel = undefined;
    });
    AgentDetailPanel.panel = panel;
  }

  private static renderHtml(
    capability: AgentCapability,
    spec?: typeof AGENT_SPECS[AgentName]
  ): string {
    const name = AgentDetailPanel.escapeHtml(capability.displayName);
    const installed = capability.installed ? '✓ Yes' : '✗ No';
    const installedColor = capability.installed ? '#4caf50' : '#f44336';
    const version = capability.version
      ? AgentDetailPanel.escapeHtml(capability.version)
      : '—';
    const modes = capability.modes.join(', ') || '—';

    // Agent spec details (may be undefined if agent not in registry)
    const bin = spec ? AgentDetailPanel.escapeHtml(spec.bin) : '—';
    const supportsSession = spec
      ? spec.supportsSession
        ? '✓ Yes'
        : '✗ No'
      : '—';

    const oneShotArgs = spec
      ? AgentDetailPanel.escapeHtml(spec.oneShot().join(' '))
      : '—';
    const sessionArgs = spec
      ? AgentDetailPanel.escapeHtml(spec.session().join(' '))
      : '—';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 14px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 24px 32px;
      max-width: 700px;
      margin: 0 auto;
      line-height: 1.6;
    }
    h1 {
      margin: 0 0 4px 0;
      font-size: 1.5em;
    }
    h2 {
      font-size: 1.15em;
      margin: 24px 0 8px 0;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
      padding-bottom: 4px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .agent-name {
      font-weight: 600;
      font-size: 1.1em;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.82em;
      font-weight: 600;
      color: #fff;
      background: ${installedColor};
    }
    .detail-grid {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 8px 12px;
      margin: 16px 0;
    }
    .detail-label {
      color: var(--vscode-descriptionForeground, #999);
      text-align: right;
      font-size: 0.9em;
    }
    .detail-value {
      font-size: 0.9em;
    }
    .detail-value code {
      background: var(--vscode-textCodeBlock-background, #2d2d2d);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }
    .session-yes { color: #4caf50; }
    .session-no { color: #f44336; }
    .section-divider {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, #333);
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="agent-name">🤖 ${name}</span>
    <span class="status-badge">${capability.installed ? 'Installed' : 'Not Installed'}</span>
  </div>

  <div class="detail-grid">
    <span class="detail-label">Display Name</span>
    <span class="detail-value">${name}</span>

    <span class="detail-label">Binary</span>
    <span class="detail-value"><code>${bin}</code></span>

    <span class="detail-label">Version</span>
    <span class="detail-value"><code>${version}</code></span>

    <span class="detail-label">Installed</span>
    <span class="detail-value">${installed}</span>

    <span class="detail-label">Supported Modes</span>
    <span class="detail-value">${modes}</span>

    <span class="detail-label">Session Resume</span>
    <span class="detail-value ${spec?.supportsSession ? 'session-yes' : 'session-no'}">${supportsSession}</span>
  </div>

  <hr class="section-divider">

  <h2>CLI Arguments</h2>
  <div class="detail-grid">
    <span class="detail-label">One-Shot Args</span>
    <span class="detail-value"><code>${oneShotArgs}</code></span>

    <span class="detail-label">Session Args</span>
    <span class="detail-value"><code>${sessionArgs}</code></span>
  </div>
</body>
</html>`;
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

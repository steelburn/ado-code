import * as vscode from 'vscode';
import { WebviewToExtensionMessage, WorkItemSummary } from '../shared/messages';
import { Services } from '../services';
import { getSettings, getActiveOrg } from '../config/settings';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'adoCode.chat';
  private _view?: vscode.WebviewView;
  // Forward-declared for setServices (Task 24 wires the real runner/executor).
  private agentRunner?: any;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly services: Services,
    // H11: the provider needs ExtensionContext for workspaceState (Q4 history,
    // org switching) and for the tree-refresh callback (C7).
    private readonly _context: vscode.ExtensionContext,
    private readonly onItemsFetched?: (items: any[]) => void
  ) {}

  /** C10: swap the services bundle after org switch / config change. */
  public setServices(services: Services): void {
    (this as any).services = services;
    // H-5 fix: rebuild the executor too — it captured the OLD services closure.
    if (this.agentRunner) this.setAgentRunner(this.agentRunner);
  }

  /** Task 24 wires the agent runner here (forward declaration). */
  public setAgentRunner(runner: any): void {
    this.agentRunner = runner;
  }

  /** H-4 fix: resolve the ACTIVE project from workspaceState (org switch). */
  private activeProject(): string {
    return getActiveOrg(this._context, getSettings()).project;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'userMessage':
            // Will be wired to LLM in later task; `done: true` is required by
            // the typed protocol added in Task 4
            webviewView.webview.postMessage({
              type: 'assistantMessage',
              content: 'Echo: ' + message.content,
              done: true,
            });
            break;
          case 'fetchWorkItems':
            await this.refreshWorkItems();
            break;
        }
      },
      undefined,
      []
    );
  }

  public postMessage(message: any) {
    this._view?.webview.postMessage(message);
  }

  async refreshWorkItems(): Promise<void> {
    // C10 fix: resolve the ACTIVE org from workspaceState (getActiveOrg), not raw settings.
    const active = getActiveOrg(this._context, getSettings());
    if (!active.name || !getSettings().adoPat || !active.project) {
      vscode.window.showWarningMessage('ADO Code: configure organization, project and PAT first.');
      return;
    }
    this.postMessage({ type: 'loading', loading: true });
    try {
      const items = await this.services.ado.getWorkItemsAssignedTo(active.project);
      // M5 fix: map AdoWorkItem → WorkItemSummary (protocol shape) before posting.
      const summaries: WorkItemSummary[] = items.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] ?? '',
        state: i.fields['System.State'] ?? '',
        assignedTo: i.fields['System.AssignedTo']?.displayName ?? '',
        workItemType: i.fields['System.WorkItemType'] ?? '',
      }));
      // To webview (chat / task list)
      this.postMessage({ type: 'workItems', items: summaries });
      // To the sidebar tree view (built in Task 9) — via injected callback (C7)
      this.onItemsFetched?.(summaries);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(`ADO Code: ${message}`);
    } finally {
      this.postMessage({ type: 'loading', loading: false });
    }
  }

  /** Task 10 implements the real git-branch flow; stub keeps Task 9 gate green. */
  async startTask(_workItemId: number, _title: string): Promise<void> {
    vscode.window.showInformationMessage('ADO Code: task pickup flow lands in Task 10.');
  }

  /** Task 13 implements the real detail fetch; stub keeps Task 9 gate green. */
  async selectWorkItem(_workItemId: number): Promise<void> {
    // no-op until Task 13 wires the ADO detail + system-prompt chain
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview-ui-dist', 'webview.js')
    );
    // CSP: default-src 'none' + explicit allowlists. Without this, VS Code logs
    // a warning and any HTML injected into the webview (e.g. markdown render of
    // LLM output) can execute scripts. The nonce on the script tag makes the
    // inline CSP workable.
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <title>ADO Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

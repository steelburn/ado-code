import * as vscode from 'vscode';

/**
 * Which root component the shared webview bundle mounts. It travels as
 * `<div id="root" data-mode="…">` rather than a query string or a second webpack
 * entry point: one bundle, one script tag, and the CSP nonce stays untouched.
 */
export type WebviewMode = 'chat' | 'draftQueue';

/**
 * Single builder for every webview we own (sidebar chat, editor-area chat, the
 * dedicated draft-queue page). Keeping one implementation means the CSP and the
 * asset path cannot drift between surfaces — a webview that quietly loses
 * `script-src` renders an empty page with no error anyone can see.
 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mode: WebviewMode,
  title = 'ADO Code',
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'webview-ui-dist', 'webview.js'),
  );
  // CSP: default-src 'none' + explicit allowlists. Without this, VS Code logs a
  // warning and any HTML injected into the webview (e.g. markdown render of LLM
  // output) can execute scripts. The nonce on the script tag makes the inline
  // CSP workable.
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <title>${title}</title>
</head>
<body>
  <div id="root" data-mode="${mode}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

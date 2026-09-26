/** Shared VS Code API singleton — acquireVsCodeApi() may only be called once per webview. */
declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState(): any;
  setState(state: any): void;
};

let api: any = null;
try {
  if (typeof (window as any).__vscodeApi !== 'undefined') {
    api = (window as any).__vscodeApi;
  } else if (typeof acquireVsCodeApi === 'function') {
    api = acquireVsCodeApi();
    (window as any).__vscodeApi = api;
  }
} catch {
  api = (window as any).__vscodeApi || null;
}

export const vscode = api;

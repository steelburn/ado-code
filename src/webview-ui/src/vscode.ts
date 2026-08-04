/** Shared VS Code API singleton — acquireVsCodeApi() may only be called once per webview. */
declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState(): any;
  setState(state: any): void;
};

export const vscode = acquireVsCodeApi();

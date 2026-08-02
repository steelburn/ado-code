import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider
    )
  );
}

export function deactivate() {}

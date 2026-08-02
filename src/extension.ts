import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { WorkItemsTreeProvider, WorkItemNode } from './ado/WorkItemsTreeProvider';
import { createServices, Services } from './services';
import { selectActiveOrganization } from './config/settings';

let chatProvider: ChatViewProvider;
let treeProvider: WorkItemsTreeProvider;

// H-10 fix: activate is async — the Q7 resume QuickPick (Task 24) awaits it,
// and VS Code supports returning a Promise from activate().
export async function activate(context: vscode.ExtensionContext) {
  let services = createServices(context);
  chatProvider = new ChatViewProvider(context.extensionUri, services, context, (items) => treeProvider?.refresh(items));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider
    )
  );

  treeProvider = new WorkItemsTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('adoCode.workItems', treeProvider)
  );

  // Register command to refresh work items
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.refreshWorkItems', () => {
      chatProvider.refreshWorkItems();
    })
  );

  // Task 9: tree-item commands (node-first signature — H4). The methods they
  // dispatch to land in Task 10 (startTask) and Task 13 (selectWorkItem).
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.selectWorkItem', (node: WorkItemNode) => {
      chatProvider.selectWorkItem(node.workItemId);
    }),
    vscode.commands.registerCommand('adoCode.startTask', (node: WorkItemNode) => {
      chatProvider.startTask(node.workItemId, node.workItemTitle);
    })
  );

  // C10 fix: register the org-switch command (Q1) — rebuild services and the
  // provider so the AdoClient is recreated against the new org.
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.switchOrganization', async () => {
      await selectActiveOrganization(context);
      services = createServices(context);
      chatProvider.setServices(services);
      await chatProvider.refreshWorkItems();
      vscode.window.showInformationMessage('ADO Code: switched organization.');
    })
  );

  // Keep services in sync with settings / workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('adoCode')) {
        services = createServices(context);
        chatProvider.setServices(services);
      }
    })
  );
}

export function deactivate() {}

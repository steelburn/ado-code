import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { WorkItemsTreeProvider, WorkItemNode } from './ado/WorkItemsTreeProvider';
import { createServices, Services } from './services';
import { selectActiveOrganization } from './config/settings';
import { AgentRunner } from './agents/AgentRunner';

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

  // Task 17: chat focus command (keybinding target)
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.chat.focus', () => chatProvider.focus())
  );

  // Task 25: delegate / assign-to-agent commands (context menu on work item nodes)
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.delegateToAgent', async (node?: WorkItemNode) => {
      if (!node) return;
      await chatProvider.startTaskWithAgent(node.workItemId, undefined);
    }),
    vscode.commands.registerCommand('adoCode.startTaskWithAgent', async (node?: WorkItemNode) => {
      if (!node) return;
      // QuickPick of installed agents, then hand off
      const installed = await services.agents.getInstalled();
      if (installed.length === 0) {
        vscode.window.showWarningMessage('ADO Code: no external agent CLIs installed (claude, codex, opencode, hermes, pi, openclaw, aider, gemini, cursor-agent).');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        installed.map(a => ({ label: `${a.displayName} (${a.name})`, description: a.version })),
        { placeHolder: 'Which agent should implement this task?' }
      );
      if (!pick) return;
      const agentName = installed.find(a => `${a.displayName} (${a.name})` === pick.label)?.name;
      await chatProvider.startTaskWithAgent(node.workItemId, agentName);
    })
  );

  // Task 28: review/clarification commands (context menu on work item nodes)
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.reviewTaskDetail', (node: WorkItemNode) => chatProvider.reviewTaskDetail(node.workItemId)),
    vscode.commands.registerCommand('adoCode.requestClarification', async (node: WorkItemNode) => {
      const question = await vscode.window.showInputBox({
        prompt: `Clarification request for ADO-${node.workItemId}: what detail do you need?`,
        placeHolder: 'e.g. What is the expected behavior when the user cancels?',
        ignoreFocusOut: true,
      });
      if (question) await chatProvider.requestClarification(node.workItemId, question);
    }),
    vscode.commands.registerCommand('adoCode.checkTaskReplies', (node: WorkItemNode) => chatProvider.checkTaskReplies(node.workItemId))
  );

  // Task 17: status-bar branch indicator
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'adoCode.refreshWorkItems';
  statusBar.tooltip = 'ADO Code: current task branch';
  statusBar.show();

  // Update it whenever the git branch changes (poll on window focus + workspace events)
  async function updateBranchStatus(): Promise<void> {
    const branch = await services.git.getCurrentBranch();
    statusBar.text = branch ? `$(git-branch) ${branch}` : '$(git-branch) (no repo)';
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(() => updateBranchStatus()),
    vscode.workspace.onDidChangeConfiguration(() => updateBranchStatus())
  );
  void updateBranchStatus();

  // Task 24 (H5): construct AgentRunner AFTER both services and chatProvider
  // exist, then hand it to the provider (which builds the tool executor).
  const agentRunner = new AgentRunner(
    services.agents,
    services.git,
    {
      onStatus: (run, delta) => chatProvider.postMessage({ type: 'agentStatus', run, delta }),
      onComplete: (run, summary) => chatProvider.postMessage({ type: 'agentResult', run, summary }),
    },
    {
      save: runs => context.workspaceState.update('adoCode.agentRuns', runs),
      load: () => context.workspaceState.get<import('./agents/types').AgentRun[]>('adoCode.agentRuns', []),
    }
  );
  chatProvider.setAgentRunner(agentRunner);

  // Q4: offer to restore persisted chat history (keyed by folder fsPath).
  const historyKey = `adoCode.chatHistory:${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default'}`;
  const savedHistory = context.workspaceState.get<import('./llm/types').LlmMessage[]>(historyKey, []);
  if (savedHistory.length > 0) {
    const pick = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Continue previous chat session?' });
    if (pick === 'Yes') {
      chatProvider.restoreConversation(savedHistory);
    }
  }

  // Q7: offer to resume interrupted runs (with a session id) after reload.
  const interrupted = agentRunner.listRuns().filter(r => r.status === 'interrupted' && r.sessionId);
  if (interrupted.length > 0) {
    const pick = await vscode.window.showQuickPick(
      interrupted.map(r => ({ label: `Resume ADO-${r.workItemId} (${r.agent})`, description: r.id })),
      { placeHolder: 'An agent run was interrupted by the restart. Resume it?' }
    );
    if (pick) agentRunner.resumeInterrupted(pick.description!, 'Continue where you left off and report status.');
  }

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

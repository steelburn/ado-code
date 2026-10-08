import type * as vscode from 'vscode';

/**
 * View type of the editor-area chat panel. It must stay in sync with the first
 * argument of `createWebviewPanel()` in ChatViewProvider.createChatEditorPanel()
 * — if the two drift, VS Code drops the tab on restart instead of handing it
 * back to the serializer.
 */
export const CHAT_EDITOR_VIEW_TYPE = 'adoCode.chatEditor';

/** The slice of ChatViewProvider the serializer needs to revive a tab. */
export interface ChatEditorHost {
  restoreChatInEditor(panel: vscode.WebviewPanel): void;
}

/**
 * Serializer that revives the editor-area chat tab after a window reload or IDE
 * restart. VS Code only persists editor tabs whose view type has a registered
 * serializer; on the next activation it rebuilds the panel and calls
 * `deserializeWebviewPanel()`. We simply re-attach that panel as the live chat
 * surface, so "ADO Code Chat" reopens in the Editor Area where the user left it.
 */
export function createChatEditorSerializer(host: ChatEditorHost): vscode.WebviewPanelSerializer {
  return {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
      host.restoreChatInEditor(panel);
    },
  };
}

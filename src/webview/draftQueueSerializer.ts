import type * as vscode from 'vscode';
import { DRAFT_QUEUE_VIEW_TYPE } from './draftQueuePage';

/**
 * Serializer view type for the Work Item Drafts page. Re-exported from the page
 * module so there is exactly one definition — when the serializer's view type and
 * the one passed to createWebviewPanel() drift, VS Code silently stops restoring
 * the tab.
 */
export { DRAFT_QUEUE_VIEW_TYPE };

/** The slice of ChatViewProvider the serializer needs to revive a tab. */
export interface DraftQueueHost {
  restoreDraftQueuePage(panel: vscode.WebviewPanel): void;
}

/**
 * Restores the draft-review page after a window reload or IDE restart. The queue
 * itself survives in workspaceState, so the rebuilt page shows the same rows the
 * user left behind.
 */
export function createDraftQueueSerializer(host: DraftQueueHost): vscode.WebviewPanelSerializer {
  return {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
      host.restoreDraftQueuePage(panel);
    },
  };
}

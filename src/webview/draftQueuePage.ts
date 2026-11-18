import * as vscode from 'vscode';
import { WorkItemDraft, WorkItemDraftQueue, WorkItemDraftSnapshot } from '../shared/draftQueue';
import { buildWebviewHtml } from './webviewHtml';
import { getDraftSelectionStore } from './draftQueueSelection';

/**
 * View type of the dedicated draft-queue page. Keep in sync with the first
 * argument of `createWebviewPanel()` below — when the two drift, VS Code drops
 * the tab on reload instead of restoring it.
 */
export const DRAFT_QUEUE_VIEW_TYPE = 'adoCode.draftQueuePage';

/**
 * The draft review queue as its own editor-area page.
 *
 * Why a page and not an inline Chat section: reviewing drafts is a list task with
 * a commit step (`finalize`), not a conversational one. In the chat webview the
 * queue competed with the transcript for vertical space, and it vanished with the
 * conversation — the host only mirrored it while the Chat view was resolved, so a
 * queue filled in an earlier window simply had nowhere to show up. A real tab
 * also keeps the selection and scroll position while the user reads a work item
 * elsewhere, and gives the review one obvious primary action.
 *
 * The panel OWNS nothing: the queue lives in ChatViewProvider and is passed in,
 * so every surface sees the same rows.
 */
export class DraftQueuePage {
  private static current: DraftQueuePage | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private unsubscribe: (() => void) | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly queue: WorkItemDraftQueue,
    extensionUri: vscode.Uri,
    /**
     * Reveal on construction. False for an adopted (restored) panel and for an
     * automatic open: neither may pull the keyboard out of the active editor.
     */
    reveal = true,
  ) {
    // A deserialized panel (restore()) starts with default options — no scripts,
    // no local roots — because createWebviewPanel() was never called for it. Set
    // them here so the create and restore paths cannot drift apart.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui-dist')],
    };

    panel.webview.html = buildWebviewHtml(
      panel.webview,
      extensionUri,
      'draftQueue',
      'ADO Code — Work Item Drafts',
    );

    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message as Record<string, any>),
      null,
      this.disposables,
    );

    // Every queue mutation streams to the page; the store emits once per
    // operation, so no extra throttling is needed here.
    this.unsubscribe = queue.onChange((snapshot) => this.postSnapshot(snapshot));

    if (reveal) this.panel.reveal(undefined, false);
  }

  /**
   * Show the page, or bring it forward when it is already open.
   *
   * `preserveFocus` exists for the AUTOMATIC opens — a draft a tool just queued,
   * or a restored queue with rows still undecided. Those have to appear without
   * pulling the keyboard out of whatever the user is typing in; the explicit
   * command keeps the default, where taking focus IS the point.
   */
  static show(
    extensionUri: vscode.Uri,
    queue: WorkItemDraftQueue,
    options: { preserveFocus?: boolean } = {},
  ): void {
    const preserveFocus = options.preserveFocus === true;
    if (DraftQueuePage.current) {
      DraftQueuePage.current.panel.reveal(undefined, preserveFocus);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DRAFT_QUEUE_VIEW_TYPE,
      'Work Item Drafts',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      {
        enableScripts: true,
        // Keep the tab alive while it is hidden: the page holds a selection and a
        // scroll position that must survive reading a work item in another tab.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui-dist')],
      },
    );

    // A freshly created panel is already the visible tab, so only an open that
    // is allowed to take focus needs the constructor's extra reveal().
    DraftQueuePage.current = new DraftQueuePage(panel, queue, extensionUri, !preserveFocus);
  }

  /**
   * Re-adopt the Work Item Drafts tab that VS Code restored after a window reload
   * or IDE restart (see createDraftQueueSerializer and
   * registerWebviewPanelSerializer in extension.ts).
   *
   * VS Code only revives an editor webview tab whose view type has a registered
   * serializer, so without this the tab was dropped on reload and the queue —
   * which survives in workspaceState — had no surface until the command was run
   * again. The restored panel is a brand-new webview, so it is wired exactly like
   * a freshly created one; only createWebviewPanel() and the focus grab are
   * skipped.
   */
  static restore(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    queue: WorkItemDraftQueue,
  ): void {
    if (DraftQueuePage.current) {
      // Two tabs over one queue would both drive Finalize; keep the open one and
      // let VS Code drop the duplicate it was about to restore.
      panel.dispose();
      return;
    }
    DraftQueuePage.current = new DraftQueuePage(panel, queue, extensionUri, false);
  }

  private postSnapshot(snapshot: WorkItemDraftSnapshot): void {
    void this.panel.webview.postMessage({
      type: 'draftQueue',
      drafts: snapshot,
      // Sent with every snapshot: the webview adopts it, so a reload lands
      // on the rows the reviewer had ticked instead of an empty selection.
      selectedIds: getDraftSelectionStore().load(),
    });
  }

  private handleMessage(message: Record<string, any>): void {
    // Selection is view state the host owns, so it never reaches the queue.
    if (message.type === 'draftQueueSelection') {
      getDraftSelectionStore().save(message.ids);
      return;
    }
    switch (message.type) {
      case 'draftQueueGet':
        this.postSnapshot(this.queue.list());
        break;
      case 'draftQueueUpdate':
        this.queue.update(message.id as string, message.patch);
        break;
      case 'draftQueueAction': {
        // accept/reject/undo only STAGE a decision (see WorkItemDraftQueue);
        // finalize is the single write path to ADO.
        const ids = (message.ids ?? []) as string[];
        if (message.action === 'accept' || message.action === 'retry') {
          this.queue.accept(ids);
        } else if (message.action === 'reject') {
          this.queue.reject(ids);
        } else if (message.action === 'undo') {
          this.queue.undo(ids);
        } else if (message.action === 'finalize') {
          this.queue.finalize();
        } else {
          this.queue.clearCreated();
        }
        break;
      }
      default:
        break;
    }
  }

  private dispose(): void {
    DraftQueuePage.current = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}

/** Re-exported so callers do not need the queue's shape to open the page. */
export type DraftQueuePageRow = WorkItemDraft;

/**
 * DraftQueuePage — the draft review queue as its own editor-area page.
 *
 * Why a page and not an inline Chat section: reviewing drafts is a list task with
 * a commit step, not a conversational one. In the chat webview the panel shared
 * vertical space with the transcript and lived only as long as the conversation,
 * so a queue filled in an earlier window had nowhere to appear. Mounted by
 * `index.tsx` when the host renders the bundle with `data-mode="draftQueue"`,
 * which means it reuses the same webview bundle and message protocol.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { vscode } from './vscode';
import { DraftQueuePanel, DraftQueueBulkAction } from './components/DraftQueuePanel';
import type { DraftPatch, WorkItemDraft } from '../../shared/draftQueue';

export const DraftQueuePage: React.FC = () => {
  const [drafts, setDrafts] = useState<WorkItemDraft[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Host-authoritative: undefined until the first snapshot arrives, so the
  // panel never flashes an empty selection over a restored one.
  const [selectedIds, setSelectedIds] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    if (!vscode) return undefined;

    const handler = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        drafts?: WorkItemDraft[];
        selectedIds?: string[];
      };
      // A snapshot, not a delta: the host emits exactly one per queue operation,
      // so replacing the list wholesale cannot drift from the store.
      if (message.type === 'draftQueue' && Array.isArray(message.drafts)) {
        setDrafts(message.drafts);
        setSelectedIds(Array.isArray(message.selectedIds) ? message.selectedIds : []);
        setLoaded(true);
      }
    };

    window.addEventListener('message', handler);
    // The page can mount after rows already exist (queue filled in an earlier
    // window), so ask for the current snapshot instead of waiting for a change.
    vscode.postMessage({ type: 'draftQueueGet' } as never);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleAction = useCallback((action: DraftQueueBulkAction, ids: string[]) => {
    vscode?.postMessage({ type: 'draftQueueAction', action, ids } as never);
  }, []);

  const handleSelectionChange = useCallback((ids: string[]) => {
    setSelectedIds(ids);
    vscode?.postMessage({ type: 'draftQueueSelection', ids } as never);
  }, []);

  const handleUpdate = useCallback((id: string, patch: DraftPatch) => {
    vscode?.postMessage({ type: 'draftQueueUpdate', id, patch } as never);
  }, []);

  return (
    <div style={{ height: '100vh', padding: '10px 14px', boxSizing: 'border-box', overflow: 'auto' }}>
      {!loaded && (
        <div style={{ opacity: 0.7, fontSize: 12 }}>Loading the draft queue…</div>
      )}
      <DraftQueuePanel
        drafts={drafts}
        onAction={handleAction}
        onUpdate={handleUpdate}
        selectedIds={selectedIds}
        onSelectionChange={handleSelectionChange}
        onDismiss={() => undefined}
        standalone
      />
    </div>
  );
};

export default DraftQueuePage;

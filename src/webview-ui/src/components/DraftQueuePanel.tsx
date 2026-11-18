/**
 * DraftQueuePanel — review queue for drafted work items.
 *
 * Why this exists: `create_work_item` used to write a staging Markdown file,
 * open it and wait for one confirmation card per item, so a turn that drafted
 * several items forced the user to approve them in the order the model produced
 * them. Rows now accumulate here instead: any subset can be accepted, rejected,
 * edited or retried in ANY order, and bulk actions apply to a selection.
 *
 * The panel is deliberately dumb — it renders a snapshot and posts intents. The
 * host owns the queue, the claim state and the one-at-a-time ADO writes, so a
 * row that is `creating` cannot be edited or rejected from here either.
 */
import React, { useMemo, useState } from 'react';
import type { DraftPatch, WorkItemDraft, WorkItemDraftStatus } from '../../../shared/draftQueue';

export type DraftQueueBulkAction =
  | 'accept' | 'reject' | 'undo' | 'finalize' | 'retry' | 'clearCreated';

export interface DraftQueuePanelProps {
  drafts: WorkItemDraft[];
  onAction: (action: DraftQueueBulkAction, ids: string[]) => void;
  onUpdate: (id: string, patch: DraftPatch) => void;
  onDismiss: () => void;
  /**
   * Render as a full page: no collapse toggle and no Hide button, because a page
   * IS the queue — collapsing it would leave the tab empty. The inline chat
   * section used to own those controls.
   */
  standalone?: boolean;
}

const STATUS_LABEL: Record<WorkItemDraftStatus, string> = {
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  blocked: 'waiting…',
  creating: 'creating…',
  created: 'created',
  failed: 'failed',
};

/** A staged decision — reversible until the queue is finalized. */
const isDecided = (draft: WorkItemDraft): boolean =>
  draft.status === 'accepted' || draft.status === 'rejected';

const STATUS_COLOR: Record<WorkItemDraftStatus, string> = {
  pending: 'var(--vscode-descriptionForeground)',
  accepted: 'var(--vscode-testing-iconQueued, #d29922)',
  rejected: 'var(--vscode-disabledForeground, #8b949e)',
  blocked: 'var(--vscode-testing-iconQueued, #d29922)',
  creating: 'var(--vscode-progressBar-background)',
  created: 'var(--vscode-testing-iconPassed, #3fb950)',
  failed: 'var(--vscode-errorForeground)',
};

const chipStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '0 6px',
  borderRadius: 8,
  border: '1px solid var(--vscode-panel-border, #444)',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
  whiteSpace: 'nowrap',
};

function actionStyle(primary = false): React.CSSProperties {
  return {
    cursor: 'pointer',
    fontSize: 11,
    padding: '1px 8px',
    borderRadius: 10,
    border: '1px solid var(--vscode-button-border, transparent)',
    background: primary ? 'var(--vscode-button-background)' : 'transparent',
    color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
  };
}

interface EditState {
  title: string;
  workItemType: string;
  description: string;
  acceptanceCriteria: string;
  assignedTo: string;
  tags: string;
  parentWorkItemId: string;
}

function toEditState(draft: WorkItemDraft): EditState {
  return {
    title: draft.title,
    workItemType: draft.workItemType,
    description: draft.description ?? '',
    acceptanceCriteria: draft.acceptanceCriteria ?? '',
    assignedTo: draft.assignedTo ?? '',
    tags: draft.tags ?? '',
    parentWorkItemId: draft.parentWorkItemId ? String(draft.parentWorkItemId) : '',
  };
}

/** Only pending/failed rows can be selected — in-flight and created rows are fixed. */
function isSelectable(draft: WorkItemDraft): boolean {
  return draft.status !== 'creating' && draft.status !== 'created';
}

export const DraftQueuePanel: React.FC<DraftQueuePanelProps> = ({
  drafts, onAction, onUpdate, onDismiss, standalone = false,
}) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const counts = useMemo(() => {
    const result = { pending: 0, accepted: 0, rejected: 0, creating: 0, created: 0, failed: 0 };
    for (const draft of drafts) result[draft.status] += 1;
    return result;
  }, [drafts]);

  const selectableIds = useMemo(
    () => drafts.filter(isSelectable).map((draft) => draft.id),
    [drafts],
  );
  // Selections die with the rows they referred to (accepted, rejected, cleared).
  const liveSelection = useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected],
  );

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(() => (liveSelection.length === selectableIds.length ? new Set() : new Set(selectableIds)));
  };

  const run = (action: DraftQueueBulkAction, ids: string[]) => {
    if (ids.length === 0 && action !== 'finalize') return;
    onAction(action, ids);
    if (action !== 'clearCreated') setSelected(new Set());
  };

  const startEdit = (draft: WorkItemDraft) => {
    setEditingId(draft.id);
    setEdit(toEditState(draft));
  };

  const saveEdit = () => {
    if (!editingId || !edit) return;
    const patch: DraftPatch = {
      workItemType: edit.workItemType.trim() || 'Task',
      title: edit.title.trim(),
      description: edit.description.trim() || undefined,
      acceptanceCriteria: edit.acceptanceCriteria.trim() || undefined,
      assignedTo: edit.assignedTo.trim() || undefined,
      tags: edit.tags.trim() || undefined,
    };
    const parentId = Number(edit.parentWorkItemId);
    if (edit.parentWorkItemId.trim()) patch.parentWorkItemId = Number.isFinite(parentId) ? parentId : undefined;
    if (!patch.title) return; // a work item without a title is not a draft
    onUpdate(editingId, patch);
    setEditingId(null);
    setEdit(null);
  };

  if (drafts.length === 0) {
    // Only reachable after an explicit reveal (auto-mount is gated on a non-empty
    // queue), so render the shell rather than nothing: a command that appears to
    // do nothing is indistinguishable from a broken command.
    return (
      <div style={{ border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 8, margin: '6px 0', padding: '8px 10px', fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>Work Item Drafts</strong>
          <span style={chipStyle}>empty</span>
          <div style={{ flex: 1 }} />
          <button style={actionStyle()} onClick={onDismiss}>Hide</button>
        </div>
        <div style={{ marginTop: 6, opacity: 0.8 }}>
          Nothing queued yet. Rows appear here when the model calls <code>create_work_item</code> or
          proposes a task breakdown — then accept, reject, edit or retry them in any order.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px solid var(--vscode-panel-border, #444)',
        borderRadius: 8,
        margin: '6px 0',
        padding: '6px 8px',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {!standalone && (
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? 'Expand the draft queue' : 'Collapse the draft queue'}
          style={{ ...actionStyle(), border: 'none', padding: '0 4px' }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        )}
        <strong>Work item drafts</strong>
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          {counts.creating > 0 && `${counts.creating} creating · `}
          {counts.pending} pending
          {counts.accepted > 0 && ` · ${counts.accepted} accepted`}
          {counts.rejected > 0 && ` · ${counts.rejected} rejected`}
          {counts.blocked > 0 && ` · ${counts.blocked} waiting`}
          {counts.failed > 0 && ` · ${counts.failed} failed`}
          {counts.created > 0 && ` · ${counts.created} created`}
        </span>
        <span style={{ flex: 1 }} />
        {collapsed && (
          <button type="button" style={actionStyle()} onClick={() => setCollapsed(false)}>
            Show
          </button>
        )}
        {!standalone && (
          <button
            type="button"
            style={actionStyle()}
            onClick={onDismiss}
            title="Hide the panel — new drafts bring it back"
          >
            Hide
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
              margin: '6px 0', paddingBottom: 6,
              borderBottom: '1px solid var(--vscode-panel-border, #333)',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={selectableIds.length > 0 && liveSelection.length === selectableIds.length}
                onChange={toggleAll}
                disabled={selectableIds.length === 0}
              />
              Select all ({selectableIds.length})
            </label>
            <button
              type="button"
              style={actionStyle(true)}
              disabled={liveSelection.length === 0}
              onClick={() => run('accept', liveSelection)}
            >
              Accept selected ({liveSelection.length})
            </button>
            <button
              type="button"
              style={actionStyle()}
              disabled={liveSelection.length === 0}
              onClick={() => run('reject', liveSelection)}
            >
              Reject selected
            </button>
            <button
              type="button"
              style={actionStyle()}
              disabled={liveSelection.length === 0}
              onClick={() => run('undo', liveSelection)}
              title="Take the staged accept/reject back — only possible before finalize"
            >
              Undo selected
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={{ ...actionStyle(true), fontWeight: 600 }}
              disabled={counts.accepted + counts.rejected + counts.blocked === 0}
              onClick={() => run('finalize', [])}
              title="Commit the review: accepted rows are created in ADO one write at a time, rejected rows are dropped. Undo stops being available here."
            >
              Finalize ({counts.accepted + counts.rejected + counts.blocked})
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={actionStyle()}
              disabled={selectableIds.length === 0}
              onClick={() => run('accept', selectableIds)}
              title="Accept every pending and failed draft — one ADO write at a time"
            >
              Accept all pending
            </button>
            <button
              type="button"
              style={actionStyle()}
              disabled={counts.created === 0}
              onClick={() => run('clearCreated', [])}
              title="Remove created rows only — failed rows stay until you reject them"
            >
              Clear created ({counts.created})
            </button>
          </div>

          {drafts.map((draft) => {
            const editing = editingId === draft.id && edit;
            return (
              <div
                key={draft.id}
                style={{
                  display: 'flex', gap: 6, alignItems: 'flex-start',
                  padding: '4px 0',
                  borderBottom: '1px solid var(--vscode-panel-border, #2a2a2a)',
                  opacity: draft.status === 'created' ? 0.7 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(draft.id)}
                  disabled={!isSelectable(draft)}
                  onChange={() => toggle(draft.id)}
                  title={isSelectable(draft)
                    ? 'Select this draft'
                    : 'In-flight and created drafts cannot be changed'}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editing ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          value={edit.workItemType}
                          onChange={(event) => setEdit({ ...edit, workItemType: event.target.value })}
                          style={{ width: 90 }}
                          aria-label="Work item type"
                        />
                        <input
                          value={edit.title}
                          onChange={(event) => setEdit({ ...edit, title: event.target.value })}
                          style={{ flex: 1 }}
                          placeholder="Title"
                          aria-label="Title"
                        />
                      </div>
                      <textarea
                        value={edit.description}
                        onChange={(event) => setEdit({ ...edit, description: event.target.value })}
                        rows={3}
                        placeholder="Description"
                        aria-label="Description"
                        style={{ width: '100%', resize: 'vertical' }}
                      />
                      <textarea
                        value={edit.acceptanceCriteria}
                        onChange={(event) => setEdit({ ...edit, acceptanceCriteria: event.target.value })}
                        rows={2}
                        placeholder="Acceptance criteria"
                        aria-label="Acceptance criteria"
                        style={{ width: '100%', resize: 'vertical' }}
                      />
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          value={edit.assignedTo}
                          onChange={(event) => setEdit({ ...edit, assignedTo: event.target.value })}
                          placeholder="Assigned to"
                          aria-label="Assigned to"
                          style={{ flex: 1 }}
                        />
                        <input
                          value={edit.tags}
                          onChange={(event) => setEdit({ ...edit, tags: event.target.value })}
                          placeholder="Tags"
                          aria-label="Tags"
                          style={{ flex: 1 }}
                        />
                        <input
                          value={edit.parentWorkItemId}
                          onChange={(event) => setEdit({ ...edit, parentWorkItemId: event.target.value })}
                          placeholder="Parent #"
                          aria-label="Parent work item id"
                          style={{ width: 80 }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button type="button" style={actionStyle(true)} onClick={saveEdit}>Save</button>
                        <button
                          type="button"
                          style={actionStyle()}
                          onClick={() => { setEditingId(null); setEdit(null); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={chipStyle}>{draft.workItemType}</span>
                        <span style={{ fontWeight: 500, wordBreak: 'break-word' }}>{draft.title}</span>
                        <span style={{ ...chipStyle, color: STATUS_COLOR[draft.status] }}>
                          {STATUS_LABEL[draft.status]}
                        </span>
                        {draft.origin === 'breakdown' && <span style={chipStyle}>breakdown</span>}
                        {draft.parentRef?.kind === 'ado' && (
                          <span style={{ fontSize: 11, opacity: 0.7 }}>↳ #{draft.parentRef.id}</span>
                        )}
                        {draft.parentRef?.kind === 'draft' && (
                          <span style={{ fontSize: 11, opacity: 0.7 }}>↳ waits for {draft.parentRef.id}</span>
                        )}
                        {draft.status === 'created' && draft.createdWorkItemId && (
                          <a
                            href={draft.url ?? '#'}
                            style={{ fontSize: 11 }}
                            title={draft.url ?? ''}
                          >
                            #{draft.createdWorkItemId}
                          </a>
                        )}
                      </div>
                      {(draft.description || draft.acceptanceCriteria) && (
                        <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>
                          {draft.description}
                        </div>
                      )}
                      {draft.error && (
                        <div style={{ fontSize: 11, color: 'var(--vscode-errorForeground)', marginTop: 2 }}>
                          {draft.error}
                        </div>
                      )}
                      {draft.status === 'blocked' && (
                        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                          {'\u21b3'} waits for {draft.blockedBy ?? 'its parent'} to be created — it follows automatically
                        </div>
                      )}
                      {draft.reparentedFrom && (
                        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                          Reparented to the nearest surviving parent ({draft.reparentedFrom} was rejected)
                        </div>
                      )}
                      {draft.hierarchyWarning && (
                        <div style={{ fontSize: 11, color: 'var(--vscode-editorWarning-foreground)', marginTop: 2 }}>
                          {'\u26a0'} {draft.hierarchyWarning}
                        </div>
                      )}
                      {draft.duplicateOf && (
                        <div style={{ fontSize: 11, color: 'var(--vscode-editorWarning-foreground)', marginTop: 2 }}>
                          Duplicate of {draft.duplicateOf} — accepting both creates two ADO items
                        </div>
                      )}
                      {draft.warning && (
                        <div style={{ fontSize: 11, color: 'var(--vscode-editorWarning-foreground)', marginTop: 2 }}>
                          {draft.warning}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {!editing && (
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {isDecided(draft) && (
                      <button
                        type="button"
                        style={actionStyle()}
                        onClick={() => run('undo', [draft.id])}
                        title="Take this decision back — nothing has been written to ADO yet"
                      >
                        Undo
                      </button>
                    )}
                    {isSelectable(draft) && (
                      <>
                        <button
                          type="button"
                          style={actionStyle(true)}
                          onClick={() => run(draft.status === 'failed' ? 'retry' : 'accept', [draft.id])}
                        >
                          {draft.status === 'failed' ? 'Retry' : 'Accept'}
                        </button>
                        <button type="button" style={actionStyle()} onClick={() => startEdit(draft)}>
                          Edit
                        </button>
                        <button type="button" style={actionStyle()} onClick={() => run('reject', [draft.id])}>
                          Reject
                        </button>
                      </>
                    )}
                    {draft.status === 'creating' && (
                      <span style={{ fontSize: 11, opacity: 0.7 }}>creating in ADO…</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

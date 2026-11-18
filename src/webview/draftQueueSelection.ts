import * as vscode from 'vscode';

/**
 * Row selection of the draft review page.
 *
 * Why it is not part of `WorkItemDraftQueue`: selection is a view concern. The
 * store has to stay correct with no page open, a ticked row means nothing to
 * any other consumer, and — most importantly — a selection must never be
 * mistakable for a staged decision. Keeping it out is what makes "ticked" and
 * "decided" two different words in the panel.
 */
export interface DraftSelectionStore {
  load(): string[];
  save(ids: unknown): void;
}

/** A selection larger than this is stale by definition — bound the memento. */
const MAX_SELECTED = 500;

/**
 * Drop non-strings, dedupe, cap. Storage is not trusted: a hand-edited or
 * truncated value must degrade to "nothing ticked", never wedge the page.
 */
export function sanitizeSelection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    seen.add(entry);
    if (seen.size >= MAX_SELECTED) break;
  }
  return [...seen];
}

/** Used before persistence is attached (tests, headless render probes). */
export function createMemorySelectionStore(initial: unknown = []): DraftSelectionStore {
  let ids = sanitizeSelection(initial);
  return {
    load: () => [...ids],
    save: (next) => {
      ids = sanitizeSelection(next);
    },
  };
}

/** Selection lives beside the queue in workspaceState: same scope, same life. */
export function createWorkspaceSelectionStore(
  state: vscode.Memento,
  key = 'adoCode.workItemDraftSelection',
): DraftSelectionStore {
  return {
    load: () => sanitizeSelection(state.get<unknown>(key)),
    save: (ids) => {
      void Promise.resolve(state.update(key, sanitizeSelection(ids)));
    },
  };
}

let active: DraftSelectionStore = createMemorySelectionStore();

/** Swapped once at activation; the page module reads it through the getter. */
export function setDraftSelectionStore(store: DraftSelectionStore): void {
  active = store;
}

export function getDraftSelectionStore(): DraftSelectionStore {
  return active;
}

/** Test hook — restores the in-memory default between suites. */
export function resetDraftSelectionStore(): void {
  active = createMemorySelectionStore();
}

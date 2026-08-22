/**
 * Dataset shown by the merged Work Items tree — shared between the tree
 * provider (header row), the chat provider (fetch orchestration) and the
 * extension entry (toggle command).
 */
export type WorkItemsMode = 'mine' | 'all' | 'unassigned';

/** Human labels for the mode QuickPick / tree header, in display order. */
export const WORK_ITEMS_MODES: ReadonlyArray<{ label: string; value: WorkItemsMode; description: string }> = [
  { label: 'My Work Items', value: 'mine', description: 'Assigned to you' },
  { label: 'All Work Items', value: 'all', description: 'Everything open in the project' },
  { label: 'Unassigned Work Items', value: 'unassigned', description: 'No assignee yet' },
];

/** Short human label for a mode (used in the tree header row). */
export function workItemsModeLabel(mode: WorkItemsMode): string {
  return WORK_ITEMS_MODES.find(m => m.value === mode)?.label ?? 'Work Items';
}

import { AdoClient } from './client';

/**
 * Per-project cache of work-item-type states (ADO states endpoint).
 *
 * States are stable per (project, work item type) — the workflow rarely
 * changes — so they are fetched ONCE per project and reused until the user
 * explicitly refreshes (via the "Refresh states from ADO" entry in the state
 * picker) or the org/project switches. The ADO client is resolved lazily
 * through a getter so an org switch (which rebuilds services) picks up the
 * new client without rebuilding the cache.
 */
export class WorkItemStatesCache {
  // project -> (work item type -> state names, in workflow order)
  private byProject = new Map<string, Map<string, string[]>>();

  constructor(private readonly ado: () => AdoClient) {}

  /** State names for a type in a project — fetches on first use, caches after. */
  async getStates(project: string, workItemType: string): Promise<string[]> {
    const byType = this.byProject.get(project) ?? new Map<string, string[]>();
    const cached = byType.get(workItemType);
    if (cached) return cached;

    const states = (await this.ado().getWorkItemTypeStates(project, workItemType)).map(s => s.name);
    byType.set(workItemType, states);
    this.byProject.set(project, byType);
    return states;
  }

  /** Drop cached states for a project (optionally one type) so the next call refetches. */
  refresh(project: string, workItemType?: string): void {
    if (workItemType) {
      this.byProject.get(project)?.delete(workItemType);
    } else {
      this.byProject.delete(project);
    }
  }

  clearAll(): void {
    this.byProject.clear();
  }
}

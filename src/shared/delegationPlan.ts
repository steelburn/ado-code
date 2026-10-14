/**
 * AD-01 — prompt-only agent delegation planning.
 *
 * Delegation used to require an active ADO work item AND a selected project:
 * `ChatViewProvider.delegateToAgent` threw `select a work item first` and then
 * resolved `activeProject()` for its ADO lookups. The planning below decouples
 * the two — with no work item (or no project) the delegation runs on the prompt
 * alone and performs NO ADO request at all.
 *
 * Everything here is pure (no VS Code API, no network) and lives in
 * `src/shared`, so it is unit-testable headlessly — see
 * `src/test/suite/shared/delegationPlan.test.ts`.
 */

/** The chat's active work item, when it has one. */
export interface DelegationWorkItem {
  id: number;
  title: string;
}

/**
 * One child task of a delegated parent. Structurally identical to
 * `ChildChecklistItem` (`llm/prompts`), so `fetchChildSubtree` plugs straight in.
 */
export interface DelegationChildTask {
  id: number;
  title: string;
  type: string;
  state: string;
}

/**
 * `work-item` — the run is linked to an active work item.
 * `prompt-only` — no work item: the run is started from the prompt alone.
 */
export type DelegationMode = 'work-item' | 'prompt-only';

export interface DelegationPlan {
  mode: DelegationMode;
  /** Present only when a work item is active; `undefined` for prompt-only runs. */
  workItemId?: number;
  /** Work-item title (used by the run card and the branch slug). */
  title?: string;
  /** Child delivery checklist — always empty in prompt-only mode. */
  childTasks: DelegationChildTask[];
}

export interface DelegationPlanningSource {
  /** The chat's active work item, if any. */
  workItem?: DelegationWorkItem;
  /** The selected ADO project — required for ANY ADO call. */
  project?: string;
  /** ADO lookup of the descendant subtree; never called without a project. */
  fetchChildSubtree(project: string, workItemId: number): Promise<DelegationChildTask[]>;
}

/**
 * Decide how a delegation runs. The only side effect is the ADO child lookup,
 * and that is skipped unless BOTH a work item AND a project are present — so a
 * prompt-only delegation provably issues no ADO call (AD-01 AC3).
 */
export async function planDelegation(src: DelegationPlanningSource): Promise<DelegationPlan> {
  const { workItem, project } = src;

  // No active work item: run on the prompt alone. Skip every ADO lookup.
  if (!workItem) {
    return { mode: 'prompt-only', childTasks: [] };
  }

  // Work item but no selected project: the run stays linked to the item (run
  // card + branch naming), but ADO cannot be reached — so no call is attempted.
  const childTasks = project ? await src.fetchChildSubtree(project, workItem.id) : [];

  return {
    mode: 'work-item',
    workItemId: workItem.id,
    title: workItem.title,
    childTasks: childTasks ?? [],
  };
}

/** Git-branch slug: lower-cased, non-alphanumerics collapsed, max 40 chars. */
export function slugifyBranchTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Sequence for prompt-only run ids. Work-item runs are keyed by the ADO number
 * and protected by the one-run-per-item guard; a prompt-only run has neither,
 * so two delegations could otherwise start in the same millisecond and share
 * an id (which would silently overwrite the first run in the registry).
 */
let promptRunSeq = 0;

/**
 * Run id. Work-item runs keep the historic `run-<ts>-<id>` shape; prompt-only
 * runs use a `prompt` marker plus a sequence instead of the literal
 * `undefined`.
 */
export function delegationRunId(workItemId: number | undefined, now: number): string {
  if (workItemId === undefined) {
    promptRunSeq += 1;
    return `run-${now}-prompt-${promptRunSeq}`;
  }
  return `run-${now}-${workItemId}`;
}

/**
 * Branch name for a delegated run. With a work item this is byte-for-byte the
 * historic `feature/ADO-<id>-<slug>`; without one it degrades to
 * `feature/agent-<slug>` — never `feature/ADO-undefined-…`.
 */
export function delegationBranchName(workItemId: number | undefined, title: string): string {
  const slug = slugifyBranchTitle(title);
  if (workItemId === undefined) {
    // A prompt-only run has no ADO number to key on; fall back to the task slug.
    return `feature/agent-${slug || 'task'}`;
  }
  return `feature/ADO-${workItemId}-${slug}`;
}

/**
 * The in-thread "delegation started" card. Work-item runs keep the historic
 * wording; prompt-only runs say so explicitly instead of printing `#undefined`.
 */
export function formatDelegationStartMessage(args: {
  agentDisplayName: string;
  plan: DelegationPlan;
  childCount?: number;
}): string {
  const { agentDisplayName, plan } = args;
  const childCount = args.childCount ?? plan.childTasks.length;
  const childInfo = childCount > 0 ? ` (including ${childCount} child task(s))` : '';
  const scope = plan.workItemId !== undefined
    ? `#${plan.workItemId} — ${plan.title ?? ''}`
    : 'this chat — not linked to a work item';

  return `🤖 **Delegated to ${agentDisplayName}** for ${scope}${childInfo}\n\n_⏳ Running… this card updates as the run progresses._`;
}

/** Short scope suffix for the "delegation started" conversation trail line. */
export function delegationTrailScope(plan: DelegationPlan): string {
  return plan.workItemId !== undefined ? `#${plan.workItemId}` : 'this chat (no work item)';
}

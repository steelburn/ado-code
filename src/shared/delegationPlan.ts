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
 * Branch name for a delegated run (AD-02). With a work item this is
 * byte-for-byte the historic `feature/ADO-<id>-<slug>`; any run id is ignored.
 * Without one it is `feature/agent-<slug>-<token>`, the token being derived
 * from the run id so concurrent prompt-only runs of the SAME prompt never
 * share a branch (no worktree / branch clash, no silent main-repo fallback).
 * With no run id at all it degrades to `feature/agent-<slug>`, and never
 * emits the literal `undefined`.
 */
export function delegationBranchName(
  workItemId: number | undefined,
  title: string,
  runId?: string,
): string {
  const slug = slugifyBranchTitle(title) || 'task';
  if (workItemId !== undefined) {
    return `feature/ADO-${workItemId}-${slug}`;
  }
  return runId
    ? `feature/agent-${slug}-${delegationBranchToken(runId)}`
    : `feature/agent-${slug}`;
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

/** Deterministic, branch-safe (lowercase base36) token for a run id (AD-02). */
export function delegationBranchToken(runId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** Max characters of a prompt-derived run title (AD-02). */
export const DELEGATION_TITLE_MAX = 80;

/**
 * Title for a delegated run (AD-02). A caller-supplied title always wins;
 * otherwise the prompt's first non-empty line; otherwise a stable
 * placeholder. Never empty, so a prompt-only run card / commit message never
 * renders blank or `undefined`.
 */
export function delegationRunTitle(prompt: string, title?: string): string {
  const explicit = (title ?? '').trim();
  if (explicit) return explicit.slice(0, DELEGATION_TITLE_MAX).trim();
  const firstLine = (prompt || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (firstLine) return firstLine.slice(0, DELEGATION_TITLE_MAX).trim();
  return 'Agent delegation';
}
/**
 * AD-03 — the post-run ADO surface. A run may be work-item-less (AD-01): then
 * nothing about it may be routed through ADO — no child completion sync, no
 * parent auto-close, no comment/state write — and no completion surface may
 * render `#undefined` / `#?`. These helpers are the single, unit-tested
 * decision point for that.
 */

/** True when the id is a usable ADO work item id (not undefined, NaN or 0). */
export function isAdoLinked(workItemId: number | undefined): boolean {
  return typeof workItemId === 'number' && Number.isInteger(workItemId) && workItemId > 0;
}

/** `ADO-<id>` for a linked run, `''` otherwise — never `ADO-undefined`. */
export function runAdoRef(workItemId: number | undefined): string {
  return isAdoLinked(workItemId) ? `ADO-${workItemId}` : '';
}

/** Compact run label: `#<id>` when linked, a neutral phrase otherwise. */
export function runWorkItemLabel(workItemId: number | undefined): string {
  return isAdoLinked(workItemId) ? `#${workItemId}` : 'no work item';
}

/** What the post-run ADO completion path is allowed to do for a finished run. */
export interface RunCompletionPlan {
  adoLinked: boolean;
  /** The validated work item id — `undefined` when the run is not ADO-linked. */
  workItemId?: number;
  /** Validated child ids to sync — empty when the run is not ADO-linked. */
  childIds: number[];
  workItemLabel: string;
  /** Parse the Delivery Report and complete child work items. */
  syncChildren: boolean;
  /** Close the parent once every open child is done. */
  completeParent: boolean;
  /** Comment on / transition the run's own work item. */
  recordOnWorkItem: boolean;
}

/**
 * Decide the ADO completion path for a finished run. A work-item-less run
 * (even one delegated with child ids) performs NO ADO work, so callers gate
 * every ADO call on one tested predicate instead of re-deriving it.
 */
export function planRunCompletion(run: {
  workItemId?: number;
  childIds?: number[];
}): RunCompletionPlan {
  const adoLinked = isAdoLinked(run.workItemId);
  const childIds = adoLinked ? run.childIds ?? [] : [];
  const hasChildren = childIds.length > 0;
  return {
    adoLinked,
    workItemId: adoLinked ? run.workItemId : undefined,
    childIds,
    workItemLabel: runWorkItemLabel(run.workItemId),
    syncChildren: hasChildren,
    completeParent: hasChildren,
    recordOnWorkItem: adoLinked,
  };
}

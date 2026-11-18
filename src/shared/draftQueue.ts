/**
 * Work item draft queue.
 *
 * Why this exists: `create_work_item` used to run a BLOCKING per-item flow —
 * write a staging Markdown file, open it, post a confirmation card and wait for
 * that one decision. A turn that drafted several items could therefore only
 * review them one at a time, in the order the model produced them (the
 * SerialQueue in ChatViewProvider existed purely to keep that single staging
 * slot sane).
 *
 * The queue inverts the flow: drafting only APPENDS a row. The user reviews the
 * rows in any order — accept, reject, edit, retry — and bulk actions apply to a
 * selection. Nothing is awaited by the tool.
 *
 * Concurrency: clicks are order-independent, EXECUTION is not parallel. Accepts
 * are handed to an internal SerialQueue so a bulk accept of 10 rows is 10
 * sequential ADO writes rather than a throttled parallel burst. A failed row
 * never aborts the batch; its error is captured per row.
 *
 * Ancestry is modelled as a `ParentRef` union from the start:
 *   - { kind: 'ado' }   the parent already exists in ADO (the flat shape the
 *                       tool and the task breakdown both produce today).
 *   - { kind: 'draft' } the parent is another row in this queue. Reserved for
 *                       nested breakdowns; no producer emits it yet, and a row
 *                       whose draft-parent has no ADO id fails with an
 *                       actionable message instead of being created as an
 *                       orphan.
 * Keeping both variants in the model now avoids a snapshot migration later.
 *
 * Pure data + serial pumping: no vscode import, so it is directly unit tested.
 */
import { SerialQueue } from './serialQueue';

/**
 * `pending` → `accepted` | `rejected` → (`finalize`) → `creating` → `created`
 * | `failed`.
 *
 * Decisions are STAGED: accept and reject only record intent, so both stay
 * reversible (`undo`) right up to the moment `finalize()` commits them. ADO is
 * written nowhere else — which is what makes "undo accept" honest: once a POST
 * has landed, un-accepting it would need a DELETE, not a state change.
 */
export type WorkItemDraftStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'creating'
  /** Accepted, but its draft parent is not in ADO yet — waits, does not fail. */
  | 'blocked'
  | 'created'
  | 'failed';

/** Which producer drafted the row — for badging, not for behaviour. */
export type WorkItemDraftOrigin = 'tool' | 'breakdown';

/** Where a draft's parent lives. See the header comment. */
export type ParentRef =
  | { kind: 'ado'; id: number }
  | { kind: 'draft'; id: string };

/** What a producer knows about a draft: content, no identity and no state. */
export interface WorkItemDraftInput {
  workItemType: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  assignedTo?: string;
  tags?: string;
  /** Parent that already exists in ADO (the flat / "case A" shape). */
  parentWorkItemId?: number;
  /** Parent that is another row in THIS queue — the nested breakdown shape. */
  localId?: string;
  parentLocalId?: string;
  /** Type of the parent, when the producer knows it (validation only). */
  parentWorkItemType?: string;
  origin?: WorkItemDraftOrigin;
}

/** A queued row: input + identity + lifecycle. */
export interface WorkItemDraft extends WorkItemDraftInput {
  id: string;
  origin: WorkItemDraftOrigin;
  status: WorkItemDraftStatus;
  /** Normalised ancestry — the single source of truth (see `normalizeParentRef`). */
  parentRef?: ParentRef;
  /** ADO id of the item this draft became, once accepted and created. */
  createdWorkItemId?: number;
  /** Deep link to the created item, once accepted. */
  url?: string;
  /** Non-fatal notice from ADO (e.g. a tag it refused). */
  warning?: string;
  /**
   * Id of an EARLIER row with the same type + title + parent. A soft warning,
   * never a block (re-drafting can be intentional) — but the user must see the
   * collision before bulk-accept turns it into two ADO items.
   */
  duplicateOf?: string;
  /** Id of the draft row this one is waiting on while `blocked`. */
  blockedBy?: string;
  /** Set when a rejected ancestor was skipped and this row moved up a level. */
  reparentedFrom?: string;
  /**
   * Soft warning: the (type, parent type) edge breaks ADO's hierarchy. A hard
   * block here would be wrong — the process template can differ — but the user
   * must see it before bulk-accept turns it into an opaque 400.
   */
  hierarchyWarning?: string;
  /** Why the last creation attempt failed. */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * What an inline edit may change. Deliberately cannot reach `id`, `status`,
 * `origin`, `createdWorkItemId` — editing those would desync a row from ADO.
 */
export type DraftPatch = Partial<Pick<
  WorkItemDraftInput,
  'workItemType' | 'title' | 'description' | 'acceptanceCriteria'
  | 'assignedTo' | 'tags' | 'parentWorkItemId'
>>;

/** Plain array so a snapshot JSON-round-trips for persistence and webview posts. */
export type WorkItemDraftSnapshot = WorkItemDraft[];

/** What the host told us about the row's ancestry when creating it. */
export interface DraftCreateContext {
  /** ADO id of the parent to create under, already resolved from `parentRef`. */
  parentAdoId?: number;
}

export interface DraftCreateResult {
  id: number;
  url: string;
  warning?: string;
}

/** The only side effect the queue performs; injected so tests run headless. */
export type DraftExecutor =
  (draft: WorkItemDraft, ctx: DraftCreateContext) => Promise<DraftCreateResult>;

/**
 * Persisted envelope for the draft queue.
 *
 * The queue used to be stored as a bare `WorkItemDraft[]`, which made the
 * stored blob indistinguishable from any other array: a release that changes
 * the row shape could only be detected by guessing row by row. The envelope
 * carries an explicit version, so a reader can say "this is not mine" instead
 * of coercing garbage into rows that look plausible and behave wrongly.
 *
 * Version history:
 *   1 — bare `WorkItemDraftSnapshot` (no envelope)
 *   2 — `{ v: 2, drafts: WorkItemDraftSnapshot }`
 */
export const DRAFT_QUEUE_SCHEMA_VERSION = 2;

export interface PersistedDraftQueue {
  v: number;
  drafts: WorkItemDraftSnapshot;
}

export type DecodedDraftQueue =
  /** Nothing stored (or nothing recognisable) — start empty. */
  | { kind: 'empty' }
  /** Rows to restore; `needsRewrite` asks the host to store them in the current shape. */
  | { kind: 'ok'; items: WorkItemDraftSnapshot; version: number; needsRewrite: boolean }
  /** Written by a NEWER build — readable or not, it must not be overwritten. */
  | { kind: 'unsupported'; version: number };

export function encodeDraftQueue(snapshot: WorkItemDraftSnapshot): PersistedDraftQueue {
  return { v: DRAFT_QUEUE_SCHEMA_VERSION, drafts: snapshot };
}

/**
 * Read whatever is in workspaceState. Never throws and never mutates: the caller
 * decides whether to hydrate and whether to rewrite.
 */
export function decodeDraftQueue(raw: unknown): DecodedDraftQueue {
  if (raw === undefined || raw === null) return { kind: 'empty' };

  // Version 1: a bare array.
  if (Array.isArray(raw)) {
    return { kind: 'ok', items: raw as WorkItemDraftSnapshot, version: 1, needsRewrite: true };
  }
  if (typeof raw !== 'object') return { kind: 'empty' };

  const record = raw as { v?: unknown; drafts?: unknown };
  const version = typeof record.v === 'number' && Number.isFinite(record.v) ? record.v : 0;

  if (version > DRAFT_QUEUE_SCHEMA_VERSION) {
    // A newer build owns this key. Downgrading it would lose fields this build
    // cannot name, so the caller leaves it untouched instead of rewriting it.
    return { kind: 'unsupported', version };
  }
  if (version < 2 || !Array.isArray(record.drafts)) return { kind: 'empty' };

  return {
    kind: 'ok',
    items: record.drafts as WorkItemDraftSnapshot,
    version,
    needsRewrite: version !== DRAFT_QUEUE_SCHEMA_VERSION,
  };
}

export interface WorkItemDraftCounts {
  pending: number;
  /** Decided yes, not yet written to ADO — still revocable. */
  accepted: number;
  /** Decided no, row retained — still revocable, dropped by finalize(). */
  rejected: number;
  /** Accepted but waiting on a draft parent; release is automatic. */
  blocked: number;
  creating: number;
  created: number;
  failed: number;
}

/** Message used when a reload stranded a row mid-create. */
export const INTERRUPTED_CREATE_ERROR =
  'Creation was interrupted by a reload — check ADO before retrying';

/**
 * Collapse the two ways a producer can name a parent into one reference.
 * A local id wins over an ADO id (it is the more specific statement), and
 * anything non-numeric/zero means "no parent" rather than a broken ref.
 */
export function normalizeParentRef(
  input: { parentWorkItemId?: number; parentLocalId?: string },
): ParentRef | undefined {
  const local = typeof input.parentLocalId === 'string' ? input.parentLocalId.trim() : '';
  if (local) return { kind: 'draft', id: local };

  const id = Number(input.parentWorkItemId);
  if (Number.isFinite(id) && id > 0) return { kind: 'ado', id: Math.trunc(id) };
  return undefined;
}

/**
 * Repair the `localId` / `parentLocalId` wiring of a breakdown batch.
 *
 * The model is asked for unique local ids, but a prompt is not a schema: a
 * legacy flat breakdown carries none at all, a copy-paste can duplicate one, and
 * a hallucinated parent id can dangle or close a cycle. None of that deserves an
 * error — it deserves a REPAIR. Missing/duplicate ids are synthesised from the
 * entry position, and a parent ref that does not resolve to a different entry of
 * the same batch is DROPPED, which makes the row fall back to its ADO parent
 * (today's flat behaviour) instead of becoming an uncreatable orphan.
 */
export function normalizeBreakdownParents(
  inputs: WorkItemDraftInput[],
): WorkItemDraftInput[] {
  // Pass 1 — give every entry a usable id. Positional ids (`t1..tN`) are what
  // the prompt asks for anyway, so a repaired id looks normal downstream.
  const ids: string[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    const raw = typeof input.localId === 'string' ? input.localId.trim() : '';
    // A synthesised id must not collide with an explicit id that ANOTHER entry
    // claims (e.g. [{localId:'t2'}, {}] would otherwise both become 't2'): bump
    // from this position until free, or two rows share an id and `byLocalId`
    // silently resolves a child to the wrong parent — the exact failure this
    // pass exists to prevent.
    let id = raw && !seen.has(raw) ? raw : '';
    for (let n = index + 1; !id; n += 1) {
      if (!seen.has(`t${n}`)) id = `t${n}`;
    }
    seen.add(id);
    ids.push(id);
  });
  const known = new Set(ids);

  // Pass 2 — keep a parent ref only when it names a DIFFERENT entry of this
  // batch and the chain from it terminates; a cycle would leave every member
  // permanently blocked, i.e. unreachable through the UI.
  const parentOf = new Map<string, string>();
  inputs.forEach((input, index) => {
    const parent = typeof input.parentLocalId === 'string' ? input.parentLocalId.trim() : '';
    if (!parent || parent === ids[index] || !known.has(parent)) return;
    parentOf.set(ids[index], parent);
  });
  const terminates = (id: string): boolean => {
    const walked = new Set<string>([id]);
    let current = parentOf.get(id);
    while (current) {
      if (walked.has(current)) return false;
      walked.add(current);
      current = parentOf.get(current);
    }
    return true;
  };

  return inputs.map((input, index) => {
    const id = ids[index];
    const parent = parentOf.get(id);
    const clean: WorkItemDraftInput = { ...input, localId: id };
    if (parent && terminates(id)) clean.parentLocalId = parent;
    else delete clean.parentLocalId;
    return clean;
  });
}

export class WorkItemDraftQueue {
  private drafts: WorkItemDraft[] = [];
  /** Monotonic suffix behind `draft-N` ids; restored from the snapshot. */
  private seq = 0;
  private readonly listeners = new Set<(snapshot: WorkItemDraftSnapshot) => void>();
  /** Serializes ACCEPTED creates — order-independent clicks, ordered writes. */
  private readonly pump = new SerialQueue();

  constructor(
    private readonly executor: DraftExecutor,
    snapshot?: WorkItemDraftSnapshot,
  ) {
    if (snapshot) {
      this.restore(snapshot);
      this.demoteRestoredBlocked();
    }
  }

  /**
   * Append a draft. Never throws, never blocks, never touches ADO — the whole
   * point of the queue is that drafting has no side effects beyond a row.
   */
  enqueue(input: WorkItemDraftInput): WorkItemDraft {
    const draft = this.buildDraft(input);
    this.drafts.push(draft);
    this.emit();
    return { ...draft, parentRef: draft.parentRef ? { ...draft.parentRef } : undefined };
  }

  /** Append a batch (task breakdown) as ONE change notification. */
  enqueueMany(inputs: WorkItemDraftInput[]): WorkItemDraft[] {
    if (inputs.length === 0) return [];
    const prepared = normalizeBreakdownParents(inputs);
    const added = prepared.map((input) => this.buildDraft(input));
    // A local id only means something inside its batch, so it is resolved HERE,
    // once the rows have real draft ids: the model names entries `t1`, the queue
    // names them `draft-N`, and only the batch knows the mapping.
    const byLocalId = new Map<string, string>();
    prepared.forEach((input, index) => {
      if (input.localId) byLocalId.set(input.localId, added[index].id);
    });
    prepared.forEach((input, index) => {
      if (!input.parentLocalId) return;
      const target = byLocalId.get(input.parentLocalId);
      if (!target || target === added[index].id) return;
      added[index].parentRef = { kind: 'draft', id: target };
    });
    this.drafts.push(...added);
    this.emit();
    return added.map((draft) => ({ ...draft }));
  }

  /**
   * Inline edit. Refused while a row is in flight (`creating`) or already
   * created — mutating either would report an item that no longer matches the
   * row. Editing a FAILED row clears the error and returns it to `pending`, so
   * "fix the typo and retry" is one gesture.
   */
  update(id: string, patch: DraftPatch): boolean {
    const draft = this.drafts.find((candidate) => candidate.id === id);
    if (!draft || draft.status === 'creating' || draft.status === 'created') return false;

    for (const key of EDITABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const value = patch[key];
        if (value === undefined) delete draft[key];
        else (draft as unknown as Record<string, unknown>)[key] = value;
      }
    }

    // The parent may have been edited — re-derive the single source of truth.
    draft.parentRef = normalizeParentRef(draft);
    draft.error = undefined;
    // Editing a DECIDED row is a change of mind: it goes back to undecided, so a
    // patch can never ride along on a staged accept or a staged reject.
    draft.status = 'pending';
    draft.updatedAt = Date.now();
    this.emit();
    return true;
  }

  /**
   * Accept rows in any order. Each eligible row is CLAIMED (`creating`) before
   * the pump touches it, so a second click or a concurrent update cannot slip in
   * between. Returns how many rows were accepted.
   */
  accept(ids: string[]): number {
    const wanted = new Set(ids);
    const eligible = this.drafts.filter((draft) =>
      wanted.has(draft.id) && draft.status !== 'creating' && draft.status !== 'created');

    if (eligible.length === 0) return 0;
    for (const draft of eligible) {
      draft.status = 'accepted';
      draft.updatedAt = Date.now();
    }
    this.emit();
    return eligible.length;
  }

  /** A failed row is just a pending row with a scar, so retry IS accept. */
  retry(ids: string[]): number {
    return this.accept(ids);
  }

  /**
   * Stage a reject. The row is KEPT as `rejected` (struck through in the panel)
   * so the decision can still be undone; `finalize()` is what drops it. Rows in
   * flight or already created are refused — cancelling a sent ADO write needs a
   * delete call, a far worse failure mode than "accept the rest, retry one".
   */
  reject(ids: string[]): number {
    const wanted = new Set(ids);
    let changed = 0;
    for (const draft of this.drafts) {
      if (!wanted.has(draft.id)) continue;
      if (draft.status === 'creating' || draft.status === 'created') continue;
      draft.status = 'rejected';
      draft.updatedAt = Date.now();
      changed += 1;
    }
    if (changed > 0) this.emit();
    return changed;
  }

  /**
   * Take a staged decision back — only possible before `finalize()`. A row that
   * carries an error returns to `failed` rather than `pending`, so the reason
   * survives the round trip.
   */
  undo(ids: string[]): number {
    const wanted = new Set(ids);
    let changed = 0;
    for (const draft of this.drafts) {
      if (!wanted.has(draft.id)) continue;
      if (draft.status !== 'accepted' && draft.status !== 'rejected') continue;
      draft.status = draft.error ? 'failed' : 'pending';
      draft.updatedAt = Date.now();
      changed += 1;
    }
    if (changed > 0) this.emit();
    return changed;
  }

  /**
   * COMMIT the review — the point of no return and the ONLY place ADO is written.
   * Staged rejects are dropped; staged accepts are CLAIMED (`creating`) and then
   * pumped one write at a time, so a 10-row bulk accept is 10 sequential POSTs
   * rather than a self-inflicted rate limit. A failed write stays `failed` and
   * never aborts its siblings. Undo is not offered past this point.
   */
  finalize(): { queued: number; removed: number; blocked: number } {
    this.reparentAroundRejected();
    const before = this.drafts.length;
    this.drafts = this.drafts.filter((draft) => draft.status !== 'rejected');
    const removed = before - this.drafts.length;

    const eligible = this.drafts.filter((draft) => draft.status === 'accepted');
    for (const draft of eligible) {
      const unmet = this.unmetDependency(draft);
      if (unmet) {
        draft.status = 'blocked';
        draft.blockedBy = unmet;
      } else {
        draft.status = 'creating';
        draft.blockedBy = undefined;
        draft.error = undefined;
      }
      draft.updatedAt = Date.now();
    }

    if (removed > 0 || eligible.length > 0) this.emit();
    const claimed = eligible.filter((draft) => draft.status === 'creating');
    for (const draft of claimed) {
      void this.pump.run(() => this.runCreate(draft.id));
    }
    return {
      queued: claimed.length,
      removed,
      blocked: eligible.length - claimed.length,
    };
  }

  /**
   * Drop COMPLETED rows only. Failures are deliberately kept: they carry the
   * only record of what went wrong, and clearing them silently would throw away
   * the retry story. A failed row leaves the queue only through an explicit
   * reject, and finalize() is what actually drops it.
   */
  clearCreated(): number {
    const before = this.drafts.length;
    this.drafts = this.drafts.filter((draft) => draft.status !== 'created');
    const removed = before - this.drafts.length;
    if (removed > 0) this.emit();
    return removed;
  }

  /**
   * Load a snapshot into a queue that was built empty. Same rules as the
   * constructor path, exposed because the host has the persisted state in hand
   * only AFTER the provider (which owns the queue) exists.
   */
  hydrate(snapshot: WorkItemDraftSnapshot): void {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return;
    this.restore(snapshot);
    this.demoteRestoredBlocked();
    this.emit();
  }

  /**
   * The draft id this row must wait for, or undefined when it may be claimed.
   * Depth is irrelevant: only DIRECT dependencies matter, because a blocked
   * child is released by its parent's settle and re-checks its own edge.
   */
  private unmetDependency(draft: WorkItemDraft): string | undefined {
    const ref = draft.parentRef;
    if (!ref || ref.kind !== 'draft') return undefined;
    const parent = this.drafts.find((candidate) => candidate.id === ref.id);
    // A dangling ref can never resolve; report it so the row says why.
    if (!parent) return ref.id;
    return parent.createdWorkItemId === undefined ? ref.id : undefined;
  }

  /**
   * Re-check every blocked row and claim the ones whose parent now exists in
   * ADO. Called after a successful settle, which is the only event that can
   * change the answer. Descendants of a failed parent stay blocked on purpose —
   * they carry the id, so the panel can say what they are waiting for.
   */
  private releaseBlocked(): void {
    for (const draft of this.drafts) {
      if (draft.status !== 'blocked') continue;
      if (this.unmetDependency(draft)) continue;
      draft.status = 'creating';
      draft.blockedBy = undefined;
      draft.updatedAt = Date.now();
      void this.pump.run(() => this.runCreate(draft.id));
    }
  }

  /**
   * Reparent children of STAGED rejects to the nearest surviving ancestor,
   * before the rejected rows are dropped. Cascade-deleting them is the other
   * defensible rule, but it destroys drafts the user never touched — wrong for
   * a review interface. Every promoted row records `reparentedFrom`.
   */
  private reparentAroundRejected(): void {
    const rejected = new Set(
      this.drafts.filter((draft) => draft.status === 'rejected').map((draft) => draft.id),
    );
    if (rejected.size === 0) return;

    for (const draft of this.drafts) {
      const ref = draft.parentRef;
      if (!ref || ref.kind !== 'draft' || !rejected.has(ref.id)) continue;
      const next = this.nearestSurvivingParentRef(ref.id);
      draft.parentRef = next;
      draft.reparentedFrom = ref.id;
      draft.blockedBy = undefined;
      if (next?.kind === 'ado') draft.parentWorkItemId = next.id;
      else delete draft.parentWorkItemId;
      draft.updatedAt = Date.now();
    }
  }

  /** Walk up through rejected rows; a cycle or a missing row means "no parent". */
  private nearestSurvivingParentRef(id: string): ParentRef | undefined {
    const seen = new Set<string>();
    let currentId: string | undefined = id;
    while (currentId) {
      if (seen.has(currentId)) return undefined;
      seen.add(currentId);
      const row = this.drafts.find((candidate) => candidate.id === currentId);
      if (!row) return undefined;
      if (row.status !== 'rejected') return { kind: 'draft', id: row.id };
      const grand = row.parentRef;
      if (!grand) return undefined;
      if (grand.kind === 'ado') return grand;
      currentId = grand.id;
    }
    return undefined;
  }

  /**
   * Recompute hierarchy warnings for the rows that are still undecided. Lives
   * here (called from `emit`) for the same reason as `markDuplicates`: every
   * mutation funnels through one place, so the flag can never drift from the
   * rows that are actually present.
   */
  private markHierarchy(): void {
    for (const draft of this.drafts) {
      draft.hierarchyWarning = undefined;
      if (draft.status === 'creating' || draft.status === 'created') continue;
      const parentType = this.parentTypeOf(draft);
      if (!parentType) continue;
      const allowed = CHILD_TYPES[parentType.trim().toLowerCase()];
      if (!allowed) continue;
      const childType = (draft.workItemType || '').trim().toLowerCase();
      if (!childType) continue;
      if (allowed.includes(childType)) continue;
      draft.hierarchyWarning =
        `${draft.workItemType} cannot be a child of ${parentType} in ADO's hierarchy`;
    }
  }

  /** Type of this row's parent, from the parent row or the producer's hint. */
  private parentTypeOf(draft: WorkItemDraft): string | undefined {
    const ref = draft.parentRef;
    if (ref?.kind === 'draft') {
      return this.drafts.find((candidate) => candidate.id === ref.id)?.workItemType;
    }
    return draft.parentWorkItemType;
  }

  counts(): WorkItemDraftCounts {
    const counts: WorkItemDraftCounts = {
      pending: 0, accepted: 0, rejected: 0, blocked: 0, creating: 0, created: 0, failed: 0,
    };
    for (const draft of this.drafts) counts[draft.status] += 1;
    return counts;
  }

  list(): WorkItemDraftSnapshot {
    return this.drafts.map((draft) => ({
      ...draft,
      parentRef: draft.parentRef ? { ...draft.parentRef } : undefined,
    }));
  }

  get(id: string): WorkItemDraft | undefined {
    const draft = this.drafts.find((candidate) => candidate.id === id);
    return draft ? { ...draft, parentRef: draft.parentRef ? { ...draft.parentRef } : undefined } : undefined;
  }

  /**
   * A restored `blocked` row goes back to `accepted`: the decision survived
   * the reload, the dependency answer did not (its parent may now be missing),
   * so the claim has to be re-decided by the next finalize().
   */
  private demoteRestoredBlocked(): void {
    for (const draft of this.drafts) {
      if (draft.status !== 'blocked') continue;
      draft.status = 'accepted';
      draft.blockedBy = undefined;
    }
  }

  /** Derived, never stored — a stored tree is a tree that can disagree with itself. */
  childrenOf(id: string): WorkItemDraft[] {
    return this.list().filter((draft) =>
      draft.parentRef?.kind === 'draft' && draft.parentRef.id === id);
  }

  /** Rows whose parent is not another row in this queue. */
  roots(): WorkItemDraft[] {
    return this.list().filter((draft) => draft.parentRef?.kind !== 'draft');
  }

  /**
   * The ADO id a row must be created under, resolved from its `ParentRef`:
   * an `ado` ref answers directly, a `draft` ref answers via the parent's
   * created item (undefined until that parent exists in ADO).
   */
  parentAdoIdOf(draft: WorkItemDraft): number | undefined {
    const ref = draft.parentRef;
    if (!ref) return undefined;
    if (ref.kind === 'ado') return ref.id;
    return this.drafts.find((candidate) => candidate.id === ref.id)?.createdWorkItemId;
  }

  onChange(listener: (snapshot: WorkItemDraftSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.listeners.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private buildDraft(input: WorkItemDraftInput): WorkItemDraft {
    const now = Date.now();
    this.seq += 1;
    return {
      ...input,
      id: `draft-${this.seq}`,
      origin: input.origin ?? 'tool',
      status: 'pending',
      parentRef: normalizeParentRef(input),
      createdAt: now,
      updatedAt: now,
    };
  }

  /** One create, on the pump: claim → execute → settle. Never throws. */
  private async runCreate(id: string): Promise<void> {
    const draft = this.drafts.find((candidate) => candidate.id === id);
    // Rejected or cleared while it waited in the pump.
    if (!draft || draft.status !== 'creating') return;

    const parentAdoId = this.parentAdoIdOf(draft);
    if (draft.parentRef?.kind === 'draft' && parentAdoId === undefined) {
      // Unreachable through finalize() (it gates the claim); this is the safety
      // net for a parent that failed or was rejected while the child waited.
      draft.status = 'blocked';
      draft.blockedBy = draft.parentRef.id;
      draft.updatedAt = Date.now();
      this.emit();
      return;
    }

    try {
      const result = await this.executor(
        { ...draft, parentRef: draft.parentRef ? { ...draft.parentRef } : undefined },
        { parentAdoId },
      );
      this.settle(draft, {
        createdWorkItemId: result.id,
        url: result.url,
        warning: result.warning,
      });
    } catch (error) {
      this.settle(draft, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private settle(
    draft: WorkItemDraft,
    outcome: { createdWorkItemId?: number; url?: string; warning?: string; error?: string },
  ): void {
    draft.status = outcome.error ? 'failed' : 'created';
    draft.createdWorkItemId = outcome.createdWorkItemId;
    draft.url = outcome.url;
    draft.warning = outcome.warning;
    draft.error = outcome.error;
    draft.updatedAt = Date.now();
    if (!outcome.error) this.releaseBlocked();
    this.emit();
  }

  /**
   * Restore a persisted snapshot. Rows stranded in `creating` are demoted to
   * `failed`: a reload can kill the host mid-POST, so the item may or may not
   * exist — quietly returning them to `pending` invites a duplicate, and leaving
   * them `creating` would be a row no gesture can clear.
   */
  private restore(snapshot: WorkItemDraftSnapshot): void {
    const restored: WorkItemDraft[] = [];
    for (const raw of snapshot) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue;
      // A staged decision is restored as-is — a reload must not silently
      // accept or reject on the user's behalf.
      const status: WorkItemDraftStatus =
        raw.status === 'creating' ? 'failed'
          : raw.status === 'created' || raw.status === 'failed' || raw.status === 'pending'
            || raw.status === 'accepted' || raw.status === 'rejected' ? raw.status
            : 'pending';
      restored.push({
        ...raw,
        status,
        origin: raw.origin === 'breakdown' ? 'breakdown' : 'tool',
        parentRef: normalizeParentRef(raw),
        error: raw.status === 'creating' ? INTERRUPTED_CREATE_ERROR : raw.error,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
      });
    }
    this.drafts = restored;

    let highest = 0;
    for (const draft of restored) {
      const match = /^draft-(\d+)$/.exec(draft.id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    this.seq = highest;
    this.markDuplicates();
    this.markHierarchy();
  }

  /** Type + title + parent, normalised: the identity the duplicate check uses. */
  private fingerprint(draft: WorkItemDraft): string {
    const type = draft.workItemType.trim().toLowerCase();
    const title = draft.title.trim().replace(/\s+/g, ' ').toLowerCase();
    const parent = draft.parentRef ? `${draft.parentRef.kind}:${draft.parentRef.id}` : 'none';
    return `${type}|${title}|${parent}`;
  }

  /**
   * Flag rows repeating an earlier row's type + title + parent. Only pending and
   * failed rows are tagged: an in-flight row's payload is already decided and a
   * created one is history, so re-tagging them would churn persistence for
   * nothing.
   */
  private markDuplicates(): void {
    const firstSeen = new Map<string, string>();
    for (const draft of this.drafts) {
      // A rejected row is not a competing item any more, so it must never become
      // the "original" a live row is compared against.
      if (draft.status === 'rejected') {
        draft.duplicateOf = undefined;
        continue;
      }
      const key = this.fingerprint(draft);
      const original = firstSeen.get(key);
      if (original === undefined) firstSeen.set(key, draft.id);
      if (draft.status === 'pending' || draft.status === 'accepted' || draft.status === 'failed') {
        draft.duplicateOf = original;
      }
    }
  }

  private emit(): void {
    // Every mutation funnels through here, so duplicate flags can never drift
    // away from the rows that are actually present.
    this.markDuplicates();
    this.markHierarchy();
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken listener must never stop the pump.
      }
    }
  }
}

/** The fields an inline edit may rewrite; mirrors `DraftPatch`. */
const EDITABLE_KEYS = [
  'workItemType', 'title', 'description', 'acceptanceCriteria',
  'assignedTo', 'tags', 'parentWorkItemId',
] as const;

/**
 * ADO's default (Agile) parent → child matrix, lower-cased for lookup. Kept
 * deliberately small and non-authoritative: it only drives a WARNING, so an
 * unknown type is left alone rather than guessed at. A process template that
 * adds a custom type simply falls outside the table and is never warned about.
 */
const CHILD_TYPES: Record<string, string[]> = {
  epic: ['feature', 'epic'],
  feature: ['user story', 'bug', 'feature'],
  'user story': ['task', 'bug'],
  bug: ['task'],
  task: [],
};

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../logger';

/**
 * Durable, per-session to-do lists under `<workspace>/.ado-code/todos/`.
 *
 * A to-do list belongs to ONE chat session (the active one) and is written by
 * the AI through the `update_todo_list` tool as it plans and executes work —
 * the harness ticks each item off the moment the model marks it completed.
 * The list is the AI's own task ledger, so it is metadata about the work
 * rather than workspace source, and it never travels through git.
 *
 * One JSON file per session: the session id is not a safe filename (ISO
 * timestamps carry `:`), so the file name is a readable, truncated slug plus
 * a short hash of the FULL id — unique even when two ids share a prefix.
 */

/** Lifecycle state of a single to-do item. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item of an AI-generated (or user-added) to-do list. */
export interface TodoItem {
  /** Stable id derived from the content — survives list replacement. */
  id: string;
  content: string;
  /** Present-participle label ("Running the tests") shown while in progress. */
  activeForm?: string;
  status: TodoStatus;
}

/** Who authored a goal. */
export type TodoGoalSource = 'ai' | 'user';

/**
 * The session's objective — what the to-do items are steps toward. One per
 * session, authored by the AI (`set_goal`) or by the user (`/goal`).
 */
export interface TodoGoal {
  text: string;
  source: TodoGoalSource;
  setAt: string;
}

/** A session's persisted to-do list. */
export interface TodoList {
  sessionId: string;
  /** Display name of the owning chat session (kept in sync on rename). */
  sessionName: string;
  updatedAt: string;
  items: TodoItem[];
  /** The session objective, when one has been set. */
  goal?: TodoGoal;
}

/** A list plus its derived progress counts — what the tree renders. */
export interface TodoListSummary extends TodoList {
  total: number;
  completed: number;
  inProgress: number;
}

/**
 * Why a goal left the live list. `completed` — every step was ticked off;
 * `superseded` — a NEW objective arrived while steps were still open. Open steps
 * are archived together with the goal instead of being carried into the
 * successor goal's plan, where they would read as work toward the new objective.
 */
export type TodoArchiveReason = 'completed' | 'superseded';

/**
 * A goal that left the live list — either fully completed or superseded by a
 * NEW objective — moved into the session's archive file so a session's history
 * stays traceable instead of being silently overwritten when the work moves on.
 */
export interface TodoArchiveEntry {
  /** When the goal was archived (a newer goal replaced it). */
  archivedAt: string;
  /** Why it was archived. */
  reason: TodoArchiveReason;
  goal: TodoGoal;
  /** The steps the archived goal had, with the statuses they ended on. */
  items: TodoItem[];
  /** How many of `items` were still open (pending / in progress). */
  remaining: number;
}

/**
 * Outcome of a goal write — in particular what happened to the PREVIOUS goal, so
 * the model is TOLD when its checklist was archived instead of silently losing
 * it (or silently inheriting steps that belong to someone else's objective).
 */
export interface TodoGoalWrite {
  list: TodoList | null;
  /** The previous goal was archived because this write is a NEW objective. */
  superseded: boolean;
  /** Set when `superseded`. */
  reason?: TodoArchiveReason;
  /** Steps archived together with the previous goal. */
  archivedItems: number;
  /** Archived steps that were still open — labels, capped for the tool result. */
  archivedPending: string[];
}

/** Outcome of a list write: the list plus what the item cap had to evict. */
export interface TodoListWrite {
  list: TodoList;
  truncated: number;
}

/** Upper bound on items kept per list — a runaway model cannot flood the tree. */
export const MAX_TODO_ITEMS = 50;
/** Upper bound on one item's label, so a pasted paragraph can't become a row. */
export const MAX_TODO_ITEM_CHARS = 300;
/** Upper bound on the goal text — it is a one-line objective, not a brief. */
export const MAX_TODO_GOAL_CHARS = 300;

/**
 * Coerce arbitrary goal input (model or user) into a clean one-line objective.
 * Returns '' when there is nothing usable, which callers treat as "no goal".
 */
export function normalizeGoalText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TODO_GOAL_CHARS);
}

/** Words that say nothing about WHAT a goal is about, so they never match it. */
const GOAL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'than', 'then', 'that', 'this',
  'these', 'those', 'its', 'our', 'your', 'you', 'all', 'any', 'via', 'per',
  'are', 'was', 'were', 'been', 'being', 'has', 'have', 'had', 'does', 'did',
  'will', 'would', 'shall', 'should', 'could', 'must', 'can', 'may', 'might',
  'not', 'but', 'also', 'when', 'while', 'out', 'off', 'own', 'same',
]);

/**
 * How much of the previous goal's vocabulary the new text must keep to count as
 * the SAME objective merely reworded. Below this the goal is a new objective
 * (archive it); at or above it, an edit (keep the plan).
 */
export const GOAL_SAME_OBJECTIVE_RATIO = 0.7;

/**
 * Content words of a goal: lowercased, hyphens joined ("to-do" -> "todo"),
 * crudely singularised, stopwords dropped.
 */
function goalTokens(text: string): Set<string> {
  const out = new Set<string>();
  const cleaned = normalizeGoalText(text).toLowerCase().replace(/-+/g, '');
  for (const rawToken of cleaned.split(/[^\p{L}\p{N}+#_.]+/u)) {
    let token = rawToken.replace(/^[_.]+|[_.]+$/g, '');
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
      token = token.slice(0, -1);
    }
    if (token.length < 3 || GOAL_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/**
 * Jaccard (word-overlap) similarity of two goal texts, 0..1. Used to tell "the
 * same objective, reworded" from "a different objective": a reword keeps the
 * plan, a new objective archives it.
 */
export function goalSimilarity(a: string, b: string): number {
  const left = goalTokens(a);
  const right = goalTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * True when `next` is a DIFFERENT objective than `previous`, i.e. the previous
 * goal must be archived and its steps cleared instead of treated as a reword.
 * Identical text is never a new objective, and neither is a text that keeps at
 * least {@link GOAL_SAME_OBJECTIVE_RATIO} of the previous goal's content words.
 */
export function isNewObjective(previous: string, next: string): boolean {
  const before = normalizeGoalText(previous).toLowerCase();
  const after = normalizeGoalText(next).toLowerCase();
  if (!before || !after || before === after) return false;
  // Goals made of nothing but stopwords/number noise: compare the texts instead.
  if (goalTokens(before).size === 0 || goalTokens(after).size === 0) return true;
  return goalSimilarity(before, after) < GOAL_SAME_OBJECTIVE_RATIO;
}

/** Placeholder shown when an item carries no `activeForm`. */
function defaultActiveForm(content: string): string {
  return content;
}

/** Stable per-content id: the same item text keeps its identity across calls. */
function itemId(content: string): string {
  return 'it-' + crypto.createHash('sha1').update(content).digest('hex').slice(0, 10);
}

/** How an AI list write is applied to the session's existing list. */
export type TodoUpdateMode = 'merge' | 'replace';

/**
 * Fold an incoming (untrusted, often PARTIAL) list into the session's existing
 * one. Models routinely re-send only the steps they are working on, so a blind
 * overwrite silently deletes the rest of the plan - the "my list got replaced
 * while items were still open" failure. Merge keeps the existing order, applies
 * the statuses the model sent, leaves an omitted item in place with its status,
 * and appends genuinely new steps. `replace` stays available as the explicit
 * escape hatch for a deliberate rewrite of the plan.
 */
export function mergeTodoItems(
  previous: readonly TodoItem[],
  incoming: readonly TodoItem[],
  mode: TodoUpdateMode = 'merge'
): TodoItem[] {
  if (mode === 'replace') return [...incoming];
  const previousById = new Map(previous.map(item => [item.id, item]));
  const incomingById = new Map(incoming.map(item => [item.id, item]));
  const merged: TodoItem[] = [];
  // Existing items keep their place in the plan (and their status when the
  // update does not mention them); a completed item is done work, so an update
  // that forgets the tick must not un-tick it.
  for (const prior of previous) {
    const next = incomingById.get(prior.id);
    if (!next) {
      merged.push(prior);
    } else if (prior.status === 'completed' && next.status !== 'completed') {
      merged.push({ ...next, status: 'completed' as TodoStatus });
    } else {
      merged.push(next);
    }
  }
  // Steps the model added since the last write land at the end, in its order.
  for (const item of incoming) {
    if (!previousById.has(item.id)) merged.push(item);
  }
  return merged;
}

/**
 * Coerce arbitrary tool input into a clean list. The model supplies JSON, so
 * every field is untrusted: unknown statuses degrade to `pending`, blank
 * entries are dropped, duplicates (same id) collapse, and both the item count
 * and each label are capped. `max` bounds the item count: callers that
 * PRUNE for the live list should pass a generous ceiling and let the reported
 * prune downstream (see `applyItems`) trim visibly instead of silently here.
 */
export function normalizeTodoItems(
  raw: unknown,
  max: number = MAX_TODO_ITEMS
): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  for (const entry of raw) {
    // Only a hard ceiling against a pathological paste: the real cap is applied
    // by eviction below, so a long plan is never cut off in the middle.
    if (out.length >= max * 10) break;
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
    const rawContent = typeof entry === 'string'
      ? entry
      : record
        ? String(record.content ?? '')
        : '';
    // One-line labels only: collapse newlines/tabs so a stray multi-line
    // string cannot break the tree row.
    const content = rawContent.replace(/\s+/g, ' ').trim().slice(0, MAX_TODO_ITEM_CHARS);
    if (!content) continue;
    const id = itemId(content);
    if (seen.has(id)) continue;
    seen.add(id);
    const rawStatus = record ? String(record.status ?? '') : '';
    const status: TodoStatus =
      rawStatus === 'completed' || rawStatus === 'in_progress' ? rawStatus : 'pending';
    const rawActiveForm = record && typeof record.activeForm === 'string'
      ? record.activeForm.replace(/\s+/g, ' ').trim().slice(0, MAX_TODO_ITEM_CHARS)
      : '';
    out.push({
      id,
      content,
      status,
      ...(rawActiveForm ? { activeForm: rawActiveForm } : {}),
    });
  }
  return pruneTodoItems(out, max).items;
}

/**
 * Trim a list to `max` items by EVICTION, never by refusing the newest steps: a
 * model that sends a longer plan must not have the work it just added dropped on
 * the floor. The OLDEST COMPLETED steps go first (they are history, not work),
 * then the oldest open ones. Reports how many steps were evicted so the tool
 * result can say so.
 */
export function pruneTodoItems(
  items: readonly TodoItem[],
  max: number = MAX_TODO_ITEMS
): { items: TodoItem[]; truncated: number } {
  if (items.length <= max) return { items: [...items], truncated: 0 };
  const excess = items.length - max;
  const dropped = new Set<number>();
  for (const status of ['completed', 'in_progress', 'pending'] as const) {
    for (let i = 0; i < items.length && dropped.size < excess; i++) {
      if (items[i].status === status) dropped.add(i);
    }
  }
  return {
    items: items.filter((_, i) => !dropped.has(i)),
    truncated: dropped.size,
  };
}

/**
 * True when a list's goal is DONE: it has a goal, at least one step, and every
 * step is completed. A goal on its own (no steps) is never "completed" — there
 * is nothing to have finished.
 */
export function isGoalCompleted(list: TodoList): boolean {
  return !!list.goal && list.items.length > 0 && list.items.every(i => i.status === 'completed');
}

/** Coerce a partial/hand-edited archive record into a clean entry, or null. */
function normalizeArchiveEntry(raw: unknown): TodoArchiveEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const goalRec = (rec.goal ?? {}) as Partial<TodoGoal>;
  const text = normalizeGoalText(goalRec.text);
  if (!text) return null;
  const items = normalizeTodoItems(rec.items);
  return {
    archivedAt: typeof rec.archivedAt === 'string' ? rec.archivedAt : new Date(0).toISOString(),
    reason: rec.reason === 'superseded' ? 'superseded' : 'completed',
    goal: {
      text,
      source: goalRec.source === 'user' ? 'user' : 'ai',
      setAt: typeof goalRec.setAt === 'string' ? goalRec.setAt : new Date(0).toISOString(),
    },
    items,
    remaining: items.filter(i => i.status !== 'completed').length,
  };
}

/** Count completed / in-progress items for a list. */
export function summarizeTodoList(list: TodoList): TodoListSummary {
  let completed = 0;
  let inProgress = 0;
  for (const item of list.items) {
    if (item.status === 'completed') completed++;
    else if (item.status === 'in_progress') inProgress++;
  }
  return { ...list, total: list.items.length, completed, inProgress };
}

/** Render a list as a markdown checklist — used for tool results and prompts. */
export function renderTodoChecklist(list: TodoList): string {
  if (list.items.length === 0) return '(the to-do list is empty)';
  const lines = list.items.map(item => {
    const box = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
    const active = item.status === 'in_progress'
      ? ` — in progress: ${item.activeForm?.trim() || defaultActiveForm(item.content)}`
      : '';
    return `- ${box} ${item.content}${active}`;
  });
  const done = list.items.filter(i => i.status === 'completed').length;
  return `${lines.join('\n')}\n\nProgress: ${done}/${list.items.length} completed.`;
}

export class TodoStore {
  private readonly dir: string;
  /** Finished goals superseded by a newer one, kept per session (traceability). */
  private readonly archiveDir: string;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after any mutation — or when the active session changes. */
  readonly onDidChange = this._onDidChange.event;

  /**
   * Chat session the AI's tool writes to. Owned here (rather than in the tree)
   * so the store is the single source of truth for "whose list is live" and
   * every surface re-renders from the same event.
   */
  private activeSessionId: string | null = null;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, '.ado-code', 'todos');
    this.archiveDir = path.join(this.dir, 'archive');
  }

  /** Create the to-do directory. Idempotent. */
  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Absolute path of the backing directory (surfaced in tree tooltips). */
  getDir(): string {
    return this.dir;
  }

  /** Absolute path of the archive directory (superseded goals, per session). */
  getArchiveDir(): string {
    return this.archiveDir;
  }

  // ── Active session ────────────────────────────────────────────────

  /**
   * Point the store at the session whose list is live. Called by the chat
   * provider on load / create / delete so the tree follows the open chat.
   * The stored session NAME is refreshed too (a rename must not leave the
   * tree showing the old name).
   */
  setActiveSession(sessionId: string | null, sessionName?: string): void {
    const changed = this.activeSessionId !== sessionId;
    this.activeSessionId = sessionId;
    if (sessionId && sessionName) {
      const list = this.read(sessionId);
      if (list && list.sessionName !== sessionName) {
        this.write({ ...list, sessionName });
        return; // write() already fired the change event
      }
    }
    if (changed) this._onDidChange.fire();
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  // ── Reads ─────────────────────────────────────────────────────────

  /** Read one session's list, or null when it has none. */
  read(sessionId: string): TodoList | null {
    const file = this.fileFor(sessionId);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TodoList>;
      // A hand-edited or partially written file must never crash the tree.
      const goalText = normalizeGoalText(parsed.goal?.text);
      return {
        sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : sessionId,
        sessionName: typeof parsed.sessionName === 'string' && parsed.sessionName ? parsed.sessionName : 'Chat session',
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
        items: normalizeTodoItems(parsed.items),
        ...(goalText
          ? {
              goal: {
                text: goalText,
                source: parsed.goal?.source === 'user' ? 'user' as const : 'ai' as const,
                setAt: typeof parsed.goal?.setAt === 'string' ? parsed.goal.setAt : new Date(0).toISOString(),
              },
            }
          : {}),
      };
    } catch (err) {
      logger.error(`TodoStore: failed to read ${file}`, err);
      return null;
    }
  }

  /** A session's list with progress counts, or null when it has none. */
  summary(sessionId: string): TodoListSummary | null {
    const list = this.read(sessionId);
    return list ? summarizeTodoList(list) : null;
  }

  /** Every stored list, most recently updated first. */
  list(): TodoListSummary[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: TodoListSummary[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      logger.error('TodoStore: failed to list to-do directory', err);
      return [];
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as Partial<TodoList>;
        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
        if (!sessionId) continue;
        const list = this.read(sessionId);
        if (list) out.push(summarizeTodoList(list));
      } catch {
        // Skip unreadable/corrupt files rather than failing the whole tree.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * True when any session has anything worth showing: items OR a goal. A
   * goal-only session still belongs in the view — it is the objective the
   * work has not been broken down for yet.
   */
  hasAny(): boolean {
    return this.list().some(l => l.items.length > 0 || !!l.goal);
  }

  // ── Mutations ─────────────────────────────────────────────────────

  /**
   * Apply an AI-authored list to a session (the `update_todo_list` primitive).
   * By default the incoming list is MERGED into the existing one: items the
   * model omitted are kept with their status instead of being dropped, so a
   * partial update can never wipe work that is still open (or already ticked).
   * `mode: 'replace'` is the deliberate-rewrite escape hatch. The session's
   * goal is a SEPARATE concern and is always preserved — rewriting the steps
   * must never silently drop the objective.
   */
  replace(
    sessionId: string,
    rawItems: unknown,
    sessionName?: string,
    mode: TodoUpdateMode = 'merge'
  ): TodoList {
    return this.applyItems(sessionId, rawItems, sessionName, mode).list;
  }

  /**
   * `replace`, but reporting how many steps the cap had to evict — a silent drop
   * hides work the model still believes is on the list.
   */
  applyItems(
    sessionId: string,
    rawItems: unknown,
    sessionName?: string,
    mode: TodoUpdateMode = 'merge'
  ): TodoListWrite {
    const previous = this.read(sessionId);
    // Normalize with the hard ceiling, not the live cap: the single reported
    // prune below must see the WHOLE merged list, otherwise an oversized incoming
    // plan is trimmed silently inside normalize and `truncated` comes back as 0.
    const merged = mergeTodoItems(
      previous?.items ?? [],
      normalizeTodoItems(rawItems, MAX_TODO_ITEMS * 10),
      mode
    );
    const { items, truncated } = pruneTodoItems(merged);
    const list: TodoList = {
      sessionId,
      sessionName: sessionName || previous?.sessionName || 'Chat session',
      updatedAt: new Date().toISOString(),
      items,
      ...(previous?.goal ? { goal: previous.goal } : {}),
    };
    this.write(list);
    return { list, truncated };
  }

  /**
   * Set (or, with empty text, clear) the session's goal. Creates the session's
   * file when it does not exist yet, so an objective can be recorded before
   * any steps are known.
   */
  setGoal(
    sessionId: string,
    text: unknown,
    source: TodoGoalSource,
    sessionName?: string
  ): TodoList | null {
    return this.applyGoal(sessionId, text, source, sessionName).list;
  }

  /**
   * Record the session's goal, reporting what happened to the previous one.
   *
   * A goal whose TEXT CHANGED always leaves the live list; the only question is
   * whether it is archived or merely retitled:
   *  - a NEW objective (word overlap below `GOAL_SAME_OBJECTIVE_RATIO`) is
   *    archived WITH its steps and the successor goal starts from a clean plan;
   *  - the SAME objective reworded keeps the plan and only updates the title.
   * Archiving deliberately does NOT require the previous plan to be finished: a
   * step only a human can tick (a manual run, an approval, a deploy) would
   * otherwise pin that goal in place forever, and every later objective would
   * pile its steps onto a plan nobody is working on any more.
   */
  applyGoal(
    sessionId: string,
    text: unknown,
    source: TodoGoalSource,
    sessionName?: string
  ): TodoGoalWrite {
    const goalText = normalizeGoalText(text);
    if (!goalText) {
      return {
        list: this.clearGoal(sessionId),
        superseded: false,
        archivedItems: 0,
        archivedPending: [],
      };
    }
    const previous = this.read(sessionId) ?? {
      sessionId,
      sessionName: sessionName || 'Chat session',
      updatedAt: new Date().toISOString(),
      items: [],
    };
    const previousGoal = previous.goal;
    const newObjective = !!previousGoal && isNewObjective(previousGoal.text, goalText);
    const reason: TodoArchiveReason | undefined = newObjective
      ? (isGoalCompleted(previous) ? 'completed' : 'superseded')
      : undefined;
    const archivedItems = newObjective ? previous.items.length : 0;
    const archivedPending = newObjective
      ? previous.items.filter(i => i.status !== 'completed').map(i => i.content)
      : [];
    if (reason) this.archiveGoal(sessionId, reason);
    const list: TodoList = {
      ...previous,
      sessionName: sessionName || previous.sessionName,
      updatedAt: new Date().toISOString(),
      items: newObjective ? [] : previous.items,
      goal: { text: goalText, source, setAt: new Date().toISOString() },
    };
    this.write(list);
    return {
      list,
      superseded: newObjective,
      ...(reason ? { reason } : {}),
      archivedItems,
      archivedPending: archivedPending.slice(0, 5),
    };
  }

  /**
   * Drop the session's goal. The session's file is deleted only when nothing
   * else is left in it (no items either).
   */
  clearGoal(sessionId: string): TodoList | null {
    const list = this.read(sessionId);
    if (!list) return null;
    if (!list.goal) return list;
    if (list.items.length === 0) {
      this.remove(sessionId);
      return null;
    }
    const { goal: _dropped, ...rest } = list;
    const next: TodoList = { ...rest, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  /** Set one item's status (the tree's checkbox + the AI's completion tick). */
  setStatus(sessionId: string, itemIdToSet: string, status: TodoStatus): TodoList | null {
    const list = this.read(sessionId);
    if (!list) return null;
    const item = list.items.find(i => i.id === itemIdToSet);
    if (!item || item.status === status) return list;
    item.status = status;
    list.updatedAt = new Date().toISOString();
    this.write(list);
    return list;
  }

  /** Append a manually authored item (never a duplicate of an existing one). */
  addItem(sessionId: string, content: string, sessionName?: string): TodoList {
    const list = this.read(sessionId) ?? {
      sessionId,
      sessionName: sessionName || 'Chat session',
      updatedAt: new Date().toISOString(),
      items: [],
    };
    const merged = normalizeTodoItems([...list.items, { content, status: 'pending' }]);
    const next: TodoList = { ...list, updatedAt: new Date().toISOString(), items: merged };
    this.write(next);
    return next;
  }

  /**
   * Drop one item. The session's file survives while a GOAL remains — losing
   * the last step must not lose the objective it belonged to.
   */
  removeItem(sessionId: string, itemIdToRemove: string): TodoList | null {
    const list = this.read(sessionId);
    if (!list) return null;
    const items = list.items.filter(i => i.id !== itemIdToRemove);
    if (items.length === list.items.length) return list;
    if (items.length === 0 && !list.goal) {
      this.remove(sessionId);
      return null;
    }
    const next: TodoList = { ...list, updatedAt: new Date().toISOString(), items };
    this.write(next);
    return next;
  }

  /** Rename the owning session on its stored list (session rename). */
  rename(sessionId: string, sessionName: string): void {
    const list = this.read(sessionId);
    if (!list || list.sessionName === sessionName) return;
    this.write({ ...list, sessionName });
  }

  /**
   * Delete a session's LIVE list only. A plain to-do "Clear" leaves the
   * session's archive intact so its history stays traceable.
   */
  remove(sessionId: string): boolean {
    const file = this.fileFor(sessionId);
    if (!fs.existsSync(file)) return false;
    try {
      fs.unlinkSync(file);
    } catch (err) {
      logger.error(`TodoStore: failed to delete ${file}`, err);
      return false;
    }
    this._onDidChange.fire();
    return true;
  }

  /**
   * Delete a session entirely — its live list AND its archive. Used when the
   * chat session itself is deleted (not a plain to-do "Clear").
   */
  removeSession(sessionId: string): boolean {
    const removed = this.remove(sessionId);
    this.removeArchive(sessionId);
    return removed;
  }

  /** Delete EVERY session's list AND archive (all chat sessions wiped). */
  removeAll(): number {
    this.clearArchiveDir();
    if (!fs.existsSync(this.dir)) return 0;
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        fs.unlinkSync(path.join(this.dir, name));
        removed++;
      }
    } catch (err) {
      logger.error('TodoStore: failed to clear to-do directory', err);
    }
    if (removed > 0) this._onDidChange.fire();
    return removed;
  }

  // ── Archive (superseded goals, per session) ───────────────────────

  /** Archived (superseded) goals for a session, most recent first. */
  readArchive(sessionId: string): TodoArchiveEntry[] {
    const file = this.archiveFileFor(sessionId);
    if (!fs.existsSync(file)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      logger.error(`TodoStore: failed to read archive ${file}`, err);
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: TodoArchiveEntry[] = [];
    for (const raw of parsed) {
      const entry = normalizeArchiveEntry(raw);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Move the session's current goal AND its steps into the session's archive
   * file, then clear the live list. Returns the archived entry, or null when
   * there is no goal to archive. The caller is responsible for writing the
   * successor list (e.g. `setGoal` writes the new goal right after).
   */
  archiveGoal(
    sessionId: string,
    reason: TodoArchiveReason = 'completed'
  ): TodoArchiveEntry | null {
    const list = this.read(sessionId);
    if (!list || !list.goal) return null;
    const entry: TodoArchiveEntry = {
      archivedAt: new Date().toISOString(),
      reason,
      goal: list.goal,
      items: list.items,
      remaining: list.items.filter(i => i.status !== 'completed').length,
    };
    const existing = this.readArchive(sessionId);
    this.writeArchive(sessionId, [entry, ...existing]);
    const file = this.fileFor(sessionId);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      logger.error(`TodoStore: failed to clear archived live list ${file}`, err);
    }
    return entry;
  }

  /**
   * Archive the session's goal as finished — thin alias for {@link archiveGoal},
   * which also records WHY it was archived.
   */
  archiveCompletedGoal(sessionId: string): TodoArchiveEntry | null {
    return this.archiveGoal(sessionId, 'completed');
  }

  private writeArchive(sessionId: string, entries: TodoArchiveEntry[]): void {
    try {
      fs.mkdirSync(this.archiveDir, { recursive: true });
      fs.writeFileSync(this.archiveFileFor(sessionId), JSON.stringify(entries, null, 2), 'utf8');
    } catch (err) {
      logger.error(`TodoStore: failed to write archive for session ${sessionId}`, err);
    }
  }

  private removeArchive(sessionId: string): void {
    const file = this.archiveFileFor(sessionId);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      logger.error(`TodoStore: failed to delete archive ${file}`, err);
    }
  }

  private clearArchiveDir(): void {
    if (!fs.existsSync(this.archiveDir)) return;
    try {
      for (const name of fs.readdirSync(this.archiveDir)) {
        if (!name.endsWith('.json')) continue;
        fs.unlinkSync(path.join(this.archiveDir, name));
      }
    } catch (err) {
      logger.error('TodoStore: failed to clear archive directory', err);
    }
  }

  private archiveFileFor(sessionId: string): string {
    const slug = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
    const digest = crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 8);
    return path.join(this.archiveDir, `${slug}-${digest}.json`);
  }

  // ── Prompt / rendering ────────────────────────────────────────────

  /**
   * The active session's list as a prompt block, or '' when there is nothing
   * to inject. Injected into the system prompt so the model keeps sight of its
   * plan across iterations and context condensation. The *discipline* for
   * using the list lives in the system prompt itself; this block is the live
   * state it refers to.
   */
  toPromptString(sessionId: string | null = this.activeSessionId): string {
    if (!sessionId) return '';
    const list = this.read(sessionId);
    if (!list) return '';
    const hasItems = list.items.length > 0;
    // A goal on its own is still worth injecting: it tells the model what the
    // session is FOR even before any steps exist.
    if (!hasItems && !list.goal) return '';
    return [
      '## Current To-do List (this session)',
      '',
      ...(list.goal ? [`**Goal:** ${list.goal.text}`, ''] : []),
      renderTodoChecklist(list),
    ].join('\n');
  }

  // ── Internals ─────────────────────────────────────────────────────

  private write(list: TodoList): void {
    this.init();
    fs.writeFileSync(this.fileFor(list.sessionId), JSON.stringify(list, null, 2), 'utf8');
    this._onDidChange.fire();
  }

  /**
   * Backing file for a session id. The readable slug is a debugging aid; the
   * hash guarantees uniqueness (two ISO timestamps differing past the slug
   * cut-off would otherwise collide) and keeps the name filesystem-safe.
   */
  private fileFor(sessionId: string): string {
    const slug = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
    const digest = crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 8);
    return path.join(this.dir, `${slug}-${digest}.json`);
  }
}

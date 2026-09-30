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

/** Placeholder shown when an item carries no `activeForm`. */
function defaultActiveForm(content: string): string {
  return content;
}

/** Stable per-content id: the same item text keeps its identity across calls. */
function itemId(content: string): string {
  return 'it-' + crypto.createHash('sha1').update(content).digest('hex').slice(0, 10);
}

/**
 * Coerce arbitrary tool input into a clean list. The model supplies JSON, so
 * every field is untrusted: unknown statuses degrade to `pending`, blank
 * entries are dropped, duplicates (same id) collapse, and both the item count
 * and each label are capped.
 */
export function normalizeTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_TODO_ITEMS) break;
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
  return out;
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
  }

  /** Create the to-do directory. Idempotent. */
  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Absolute path of the backing directory (surfaced in tree tooltips). */
  getDir(): string {
    return this.dir;
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
   * Replace a session's list (the AI tool's primitive — TodoWrite semantics:
   * the model sends the COMPLETE list each call, including the items it just
   * ticked off). The session's goal is a SEPARATE concern and is preserved —
   * rewriting the steps must never silently drop the objective.
   */
  replace(sessionId: string, rawItems: unknown, sessionName?: string): TodoList {
    const previous = this.read(sessionId);
    const list: TodoList = {
      sessionId,
      sessionName: sessionName || previous?.sessionName || 'Chat session',
      updatedAt: new Date().toISOString(),
      items: normalizeTodoItems(rawItems),
      ...(previous?.goal ? { goal: previous.goal } : {}),
    };
    this.write(list);
    return list;
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
    const goalText = normalizeGoalText(text);
    if (!goalText) return this.clearGoal(sessionId);
    const previous = this.read(sessionId) ?? {
      sessionId,
      sessionName: sessionName || 'Chat session',
      updatedAt: new Date().toISOString(),
      items: [],
    };
    const list: TodoList = {
      ...previous,
      sessionName: sessionName || previous.sessionName,
      updatedAt: new Date().toISOString(),
      goal: { text: goalText, source, setAt: new Date().toISOString() },
    };
    this.write(list);
    return list;
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

  /** Delete a session's list entirely (session deleted, or "Clear"). */
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

  /** Delete EVERY session's list (all chat sessions wiped). Returns how many. */
  removeAll(): number {
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

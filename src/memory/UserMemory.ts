/**
 * UserMemory — persistent user memory system backed by VS Code globalState.
 *
 * Stores key-value memory entries categorized as preferences, instructions,
 * corrections, and context. These are injected into the system prompt so the
 * LLM remembers user preferences across sessions.
 */

import * as vscode from 'vscode';

/** Supported memory categories. */
export type MemoryCategory = 'preference' | 'instruction' | 'correction' | 'context';

/** A single memory entry persisted in globalState. */
export interface UserMemoryEntry {
  /** Unique key identifying this memory (e.g. 'code_style', 'no_semicolons'). */
  key: string;
  /** Category for organizing/grouping memories. */
  category: MemoryCategory;
  /** The memory content — a free-text description. */
  content: string;
  /** ISO-8601 timestamp of last update. */
  timestamp: string;
}

/** Shape of the persisted memory store in globalState. */
interface MemoryStore {
  entries: UserMemoryEntry[];
}

const GLOBAL_STATE_KEY = 'adoCode.userMemory';

/**
 * Manages persistent user memories that are injected into the system prompt
 * so the LLM can respect user preferences, instructions, and context.
 */
export class UserMemory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Get all stored memory entries. */
  getAll(): UserMemoryEntry[] {
    const store = this.context.globalState.get<MemoryStore>(GLOBAL_STATE_KEY);
    return store?.entries ?? [];
  }

  /** Get entries filtered by category. */
  getByCategory(category: MemoryCategory): UserMemoryEntry[] {
    return this.getAll().filter((e) => e.category === category);
  }

  /**
   * Generate a prompt string from all memory entries.
   * Returns an empty string if no memories exist.
   */
  toPromptString(): string {
    const entries = this.getAll();
    if (entries.length === 0) return '';

    const lines: string[] = ['## User Memories', ''];
    for (const entry of entries) {
      lines.push(`- **[${entry.category}] ${entry.key}:** ${entry.content}`);
    }
    return lines.join('\n');
  }

  /**
   * Set (create or update) a memory entry.
   * If an entry with the same key exists, it is updated; otherwise created.
   */
  set(key: string, category: MemoryCategory, content: string): void {
    const entries = this.getAll();
    const existing = entries.findIndex((e) => e.key === key);

    const entry: UserMemoryEntry = {
      key,
      category,
      content,
      timestamp: new Date().toISOString(),
    };

    if (existing >= 0) {
      entries[existing] = entry;
    } else {
      entries.push(entry);
    }

    this.context.globalState.update(GLOBAL_STATE_KEY, { entries } satisfies MemoryStore);
  }

  /** Delete a memory entry by key. Returns true if found and deleted. */
  delete(key: string): boolean {
    const entries = this.getAll();
    const before = entries.length;
    const filtered = entries.filter((e) => e.key !== key);
    if (filtered.length === before) return false;

    this.context.globalState.update(GLOBAL_STATE_KEY, { entries: filtered } satisfies MemoryStore);
    return true;
  }

  /** Clear all memory entries. */
  clear(): void {
    this.context.globalState.update(GLOBAL_STATE_KEY, { entries: [] } satisfies MemoryStore);
  }
}

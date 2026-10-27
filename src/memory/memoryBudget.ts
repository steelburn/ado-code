/**
 * Memory budgets — hard caps for the memory block injected into a prompt, plus
 * the write-side ceiling for a single memory entry.
 *
 * Why: `wrapMemoryContext` (llm/prompts) used to inline the whole memory string
 * verbatim into EVERY prompt, so one oversized entry — or a handful of large
 * ones — could consume a large slice of the context window on every turn.
 *
 * The injected form is now a compact digest, one single line per entry, under
 * hard budgets of
 *   - `adoCode.memory.maxEntries`       (default 25)   — at most 25 entries,
 *   - `adoCode.memory.maxCharsPerEntry` (default 400)  — at most 400 chars each,
 *   - `adoCode.memory.maxTotalChars`    (default 4000) — at most 4000 chars total.
 * Anything dropped because of the entry count is reported on one pointer line
 * telling the model it can call `list_workspace_memory`, which still returns the
 * full, untruncated entries. Small memories are unaffected: below the budgets
 * the rendering is byte-for-byte what it was before.
 *
 * Everything here is pure except `readMemoryBudget()`, which reads the settings.
 */

import * as vscode from 'vscode';

/** Caps applied to one injected memory block. */
export interface MemoryBudget {
  /** Maximum number of entries rendered in the block. */
  maxEntries: number;
  /** Maximum characters rendered per entry (the body is cut, marker appended). */
  maxCharsPerEntry: number;
  /** Maximum characters of the rendered block, header and footer included. */
  maxTotalChars: number;
}

/** Budgets used when a setting is missing or nonsensical. */
export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  maxEntries: 25,
  maxCharsPerEntry: 400,
  maxTotalChars: 4000,
};

/** Fully-qualified setting ids, so messages point at the exact knob. */
export const MEMORY_SETTINGS = {
  maxEntries: 'adoCode.memory.maxEntries',
  maxCharsPerEntry: 'adoCode.memory.maxCharsPerEntry',
  maxTotalChars: 'adoCode.memory.maxTotalChars',
} as const;

/** Marker appended to text that had to be cut. */
const ELLIPSIS = '…';
/** A single entry handed to `renderMemoryBlock`. */
export interface MemoryBlockEntry {
  /** Bold lead-in for the line (e.g. `[instruction] memory_handling`). */
  title: string;
  /** Free-text body; flattened to one line and cut to `maxCharsPerEntry`. */
  body: string;
}

/** Result of validating what the model wants to write. */
export type MemoryEntryCheck = { ok: true } | { ok: false; error: string };

function positiveInt(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

/**
 * Read the memory budget from settings. Falls back to `DEFAULT_MEMORY_BUDGET`
 * when the host is unavailable (headless tests) or a value is unusable.
 */
export function readMemoryBudget(): MemoryBudget {
  let cfg: vscode.WorkspaceConfiguration | undefined;
  try {
    cfg = vscode.workspace.getConfiguration('adoCode.memory');
  } catch {
    cfg = undefined;
  }
  if (!cfg || typeof cfg.get !== 'function') return { ...DEFAULT_MEMORY_BUDGET };

  return {
    maxEntries: positiveInt(cfg.get('maxEntries'), DEFAULT_MEMORY_BUDGET.maxEntries, 1),
    maxCharsPerEntry: positiveInt(cfg.get('maxCharsPerEntry'), DEFAULT_MEMORY_BUDGET.maxCharsPerEntry, 40),
    maxTotalChars: positiveInt(cfg.get('maxTotalChars'), DEFAULT_MEMORY_BUDGET.maxTotalChars, 200),
  };
}

/**
 * Budget left once `usedChars` have already been spent on another memory block
 * (user memory + workspace memory share ONE total).
 */
export function remainingMemoryBudget(budget: MemoryBudget, usedChars: number): MemoryBudget {
  const remaining = Math.floor(budget.maxTotalChars) - Math.max(0, Math.floor(usedChars));
  return {
    maxEntries: Math.max(0, Math.floor(budget.maxEntries)),
    maxCharsPerEntry: Math.max(1, Math.floor(budget.maxCharsPerEntry)),
    maxTotalChars: Math.max(0, remaining),
  };
}

/** Collapse whitespace (newlines included) so an entry renders on exactly one line. */
export function flattenMemoryText(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Cut arbitrary text to `maxChars`, appending the ellipsis marker when
 * something was dropped. Line structure is preserved — this is the general
 * purpose helper used for whole memory blocks.
 */
export function truncateMemoryText(text: string, maxChars: number): string {
  const value = String(text ?? '').trim();
  const limit = Math.max(1, Math.floor(maxChars));
  if (value.length <= limit) return value;
  if (limit === 1) return ELLIPSIS;
  return value.slice(0, limit - 1).trimEnd() + ELLIPSIS;
}

/** Flatten an entry to one line, then cut it to `maxChars`. */
function digestMemoryText(text: string, maxChars: number): { text: string; shortened: boolean } {
  const flat = flattenMemoryText(text);
  const cut = truncateMemoryText(flat, maxChars);
  return { text: cut, shortened: cut !== flat };
}

/** Default one-line digest format: `- **title:** body`. */
function defaultEntryFormat(title: string, body: string): string {
  return `- **${title}:** ${body}`;
}

/** Rendering hooks for `renderMemoryBlock`. */
export interface MemoryRenderOptions {
  /** On-line digest used once a budget is hit. */
  digest?: (title: string, body: string) => string;
  /**
   * Legacy, possibly multi-line rendering (heading sections etc.) used verbatim
   * while every entry fits the budgets, so small memories keep the exact shape
   * the model has seen until now.
   */
  verbose?: (entries: MemoryBlockEntry[], header: string) => string;
}

function omittedPointer(omitted: number): string {
  return `_…plus ${omitted} more ${omitted === 1 ? 'entry' : 'entries'} — call list_workspace_memory (then read_workspace_memory) for the full text._`;
}

/**
 * Render memory entries as a budgeted block.
 *
 * While everything fits — `maxEntries` entries, every body within
 * `maxCharsPerEntry`, the whole block within `maxTotalChars` — the caller's
 * `verbose` renderer is used verbatim, so small memories are unchanged. Once
 * any budget is hit the block switches to a compact digest: one line per entry,
 * bodies flattened and cut, and a pointer line naming `list_workspace_memory`
 * for the full text.
 *
 * Returns `''` when there is nothing to inject (or no budget left).
 */
export function renderMemoryBlock(
  header: string,
  entries: MemoryBlockEntry[],
  budget: MemoryBudget = DEFAULT_MEMORY_BUDGET,
  options: MemoryRenderOptions = {}
): string {
  if (!entries || entries.length === 0) return '';

  const total = Math.max(0, Math.floor(budget.maxTotalChars));
  const maxEntries = Math.max(0, Math.floor(budget.maxEntries));
  const perEntry = Math.max(1, Math.floor(budget.maxCharsPerEntry));
  // Header, then a blank line before the first entry.
  if (maxEntries === 0 || total <= header.length + 2) return '';

  const digestFormat = options.digest ?? defaultEntryFormat;

  // Fast path: nothing is over budget, so keep the legacy rendering.
  if (options.verbose && entries.length <= maxEntries) {
    const everyBodyFits = entries.every((e) => flattenMemoryText(e.body).length <= perEntry);
    if (everyBodyFits) {
      const legacy = options.verbose(entries, header);
      if (legacy.length <= total) return legacy;
    }
  }

  const pointerReserve = Math.max(
    omittedPointer(entries.length).length,
    `_…${entries.length} of ${entries.length} entries shortened to fit the ${total}-char memory budget._`.length
  ) + 2; // + the blank line the footer is separated by

  const lines: string[] = [];
  let shortened = 0;
  let omitted = 0;
  let used = header.length + 2;

  for (let i = 0; i < entries.length; i++) {
    if (lines.length >= maxEntries) {
      omitted = entries.length - i;
      break;
    }
    const entry = entries[i];
    const digest = digestMemoryText(entry.body, perEntry);
    if (digest.shortened) shortened++;
    const line = digestFormat(entry.title, digest.text);
    const needsFooter = i < entries.length - 1;
    if (used + line.length + 1 + (needsFooter ? pointerReserve : 0) > total) {
      omitted = entries.length - i;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  if (lines.length === 0) return '';

  const parts = [header, lines.join('\n')];
  if (omitted > 0) {
    parts.push(omittedPointer(omitted));
  } else if (shortened > 0) {
    parts.push(`_…${shortened} of ${entries.length} entries shortened to fit the ${total}-char memory budget._`);
  }

  const block = parts.join('\n\n');
  // Defensive: never hand back more than the budget even if the accounting above
  // is defeated by a pathological formatter.
  return block.length <= total ? block : block.slice(0, Math.max(0, total - 1)) + ELLIPSIS;
}

/**
 * Validate what the model wants to store in memory. Writes above the per-entry
 * ceiling are refused rather than silently truncated: a memory that got cut in
 * half is worse than no memory at all, and the model can simply split it.
 */
export function validateMemoryEntry(
  value: string,
  budget: MemoryBudget = DEFAULT_MEMORY_BUDGET
): MemoryEntryCheck {
  const flat = flattenMemoryText(value);
  if (!flat) {
    return { ok: false, error: 'Memory content is empty — nothing was stored.' };
  }
  if (flat.length <= budget.maxCharsPerEntry) return { ok: true };

  return {
    ok: false,
    error:
      `Memory entry is ${flat.length} chars, over the ${budget.maxCharsPerEntry}-char ceiling ` +
      `(${MEMORY_SETTINGS.maxCharsPerEntry}). Keep a memory to one or two sentences: shorten it, ` +
      `or split it into several entries.`,
  };
}

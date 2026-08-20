/**
 * Context Manager — prevents context window overflow via priority-based
 * truncation of older messages while preserving critical content.
 *
 * Priority order (highest → lowest):
 *  1. System prompt (first message, role='system') — never removed
 *  2. Tool results (role='tool') — contain file content & execution output
 *  3. Recent messages (last N pairs) — most relevant to current conversation
 *  4. Older messages — first to be truncated
 *
 * When truncation occurs, a summary message is inserted so the model is
 * aware that earlier context was removed.
 */

import type { LlmMessage } from "../types";
import { countMessageTokens } from "./tokenCounter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Percentage of maxTokens at which truncation kicks in. */
const TRUNCATION_THRESHOLD = 0.8;

/** Number of most-recent user+assistant pairs to always keep. */
const RECENT_PAIRS_KEEP = 10;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UsageStats {
  used: number;
  remaining: number;
  percentage: number;
}

/**
 * Rough token cost of the dynamic system prompt that rides along with every
 * agentic request but is NOT part of `this.conversation`. Used by the host to
 * size the context-overhead so truncation/status reflect true per-request cost
 * (see ContextManager.setOverheadTokens).
 */
export const SYSTEM_PROMPT_OVERHEAD_TOKENS = 2000;
// ---------------------------------------------------------------------------
// Helper — shared by ContextManager and ConversationCondenser
// ---------------------------------------------------------------------------

/**
 * Return a Set of body-array indices for the last `count` user+assistant
 * pairs, walking backward from the end.
 */
export function getRecentPairIndices(
  body: LlmMessage[],
  count: number,
): Set<number> {
  const indices = new Set<number>();
  let pairsFound = 0;

  for (let i = body.length - 1; i >= 0 && pairsFound < count; i--) {
    if (body[i].role === "assistant") {
      if (i > 0 && body[i - 1].role === "user") {
        indices.add(i);
        indices.add(i - 1);
        pairsFound++;
        i--; // skip the user message we just added
      } else {
        // Orphan assistant message — still keep it
        indices.add(i);
      }
    }
  }

  return indices;
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

export class ContextManager {
  private maxTokens: number;
  private currentTokens: number = 0;
  /** Tokens NOT in the tracked messages but sent with every request (system
   *  prompt + tool schemas). Added to usage so budgets reflect true cost. */
  private overheadTokens: number = 0;

  constructor(maxTokens: number) {
    this.maxTokens = maxTokens;
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /** Update the max token budget (e.g. when live model data is available). */
  setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  /**
   * Account for tokens sent with every request outside the message array
   * (system prompt, tool schemas). Truncation/remaining-token checks then
   * reflect the true per-request size instead of only the conversation.
   */
  setOverheadTokens(tokens: number): void {
    this.overheadTokens = Math.max(0, tokens);
  }

  // -----------------------------------------------------------------------
  // Tracking
  // -----------------------------------------------------------------------

  /**
   * Count and store the token usage for the given message array.
   *
   * Call this whenever the conversation changes so that `getRemainingTokens`,
   * `shouldTruncate`, and `getUsageStats` return accurate values.
   */
  trackMessages(messages: LlmMessage[]): void {
    this.currentTokens = countMessageTokens(messages);
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Tokens still available in the context window (accounting for overhead). */
  getRemainingTokens(): number {
    return Math.max(0, this.maxTokens - this.currentTokens - this.overheadTokens);
  }

  /**
   * Whether the context is close enough to the limit that new content
   * risks an overflow.  Returns `true` when usage ≥ 80 % of maxTokens
   * (overhead included).
   */
  shouldTruncate(): boolean {
    return (this.currentTokens + this.overheadTokens) / this.maxTokens > TRUNCATION_THRESHOLD;
  }

  /** Convenience snapshot of current token budget. */
  getUsageStats(): UsageStats {
    const used = this.currentTokens + this.overheadTokens;
    const remaining = Math.max(0, this.maxTokens - used);
    const percentage =
      this.maxTokens > 0 ? (used / this.maxTokens) * 100 : 0;
    return { used, remaining, percentage };
  }

  // -----------------------------------------------------------------------
  // Truncation
  // -----------------------------------------------------------------------

  /**
   * Remove older messages so the total fits within `maxTokens`.
   *
   * Strategy:
   *  1. Always keep the system prompt (first message when role='system').
   *  2. Always keep the last `RECENT_PAIRS_KEEP` user+assistant message pairs.
   *  3. From the remaining "middle" messages, drop the ones with lowest
   *     priority first:
   *        - Tool results (high priority) are kept as long as possible.
   *        - Regular user/assistant messages (medium priority) go first.
   *  4. Insert a summary message indicating how many messages were removed.
   *
   * Returns the new (possibly shorter) message array.
   */
  truncateMessages(messages: LlmMessage[]): LlmMessage[] {
    // Fast path — already fits
    const totalTokens = countMessageTokens(messages);
    if (totalTokens <= this.maxTokens) {
      return messages;
    }

    // ---- Partition messages ----
    const systemPrompt: LlmMessage | null =
      messages.length > 0 && messages[0].role === "system" ? messages[0] : null;

    const body = systemPrompt ? messages.slice(1) : [...messages];

    // Determine which indices belong to the "recent window" (last N pairs).
    const recentIndices = this.getRecentPairIndices(body, RECENT_PAIRS_KEEP);

    // Indices eligible for removal = everything except system prompt & recent.
    const removableIndices: number[] = [];
    for (let i = 0; i < body.length; i++) {
      if (!recentIndices.has(i)) {
        removableIndices.push(i);
      }
    }

    // ---- Sort removable messages by priority (lowest first) ----
    // Priority: regular user/assistant < tool result
    removableIndices.sort((a, b) => {
      return this.getPriority(body[a]) - this.getPriority(body[b]);
    });

    // ---- Iteratively drop lowest-priority messages until we fit ----
    const toRemove = new Set<number>();
    let tokensBudget = totalTokens;

    for (const idx of removableIndices) {
      if (tokensBudget <= this.maxTokens) {
        break;
      }
      tokensBudget -= countMessageTokens([body[idx]]);
      toRemove.add(idx);
    }

    // If we still overflow after dropping all removable messages, also drop
    // some recent messages (still respecting priority).
    if (tokensBudget > this.maxTokens) {
      const recentArray = Array.from(recentIndices).sort((a, b) => a - b);
      // Drop from the oldest recent pair first
      for (let i = 0; i < recentArray.length; i++) {
        const idx = recentArray[i];
        if (tokensBudget <= this.maxTokens) {
          break;
        }
        tokensBudget -= countMessageTokens([body[idx]]);
        toRemove.add(idx);
      }
    }

    if (toRemove.size === 0) {
      // Nothing was removed — should not happen, but return as-is.
      return messages;
    }

    // ---- Build truncated message array ----
    const keptMessages: LlmMessage[] = [];

    for (let i = 0; i < body.length; i++) {
      if (!toRemove.has(i)) {
        keptMessages.push(body[i]);
      }
    }

    // Insert summary message right after the system prompt (or at position 0).
    const summaryMsg: LlmMessage = {
      role: "user",
      content: `[Context truncated: ${toRemove.size} older message(s) removed to stay within token budget]`,
    };

    const result: LlmMessage[] = [];
    if (systemPrompt) {
      result.push(systemPrompt);
    }
    result.push(summaryMsg);
    result.push(...keptMessages);

    // Update tracked token count
    this.currentTokens = countMessageTokens(result);

    return result;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Return a Set of body-array indices for the last `count` user+assistant pairs.
   * Delegates to the shared standalone helper.
   */
  private getRecentPairIndices(
    body: LlmMessage[],
    count: number,
  ): Set<number> {
    return getRecentPairIndices(body, count);
  }

  /**
   * Priority score for a message (lower = dropped first).
   *
   *  0 → regular user / assistant message (lowest priority — drop first)
   *  1 → tool result (higher priority — keep as long as possible)
   */
  private getPriority(msg: LlmMessage): number {
    if (msg.role === "tool") {
      return 1;
    }
    return 0;
  }
}

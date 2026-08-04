/**
 * Conversation Condenser — summarizes long conversations to save context.
 *
 * When the context window gets full, older messages are summarized via a
 * caller-provided `summarizeFn` and replaced with a concise summary that
 * preserves key information (file changes, decisions, errors).
 *
 * Strategy:
 *  1. Keep the system prompt always.
 *  2. Keep the last 5 user+assistant message pairs intact.
 *  3. Summarize everything else into 2-3 sentences.
 *  4. Prepend the summary as a system message.
 *  5. Preserve key file changes in the summary.
 */

import type { LlmMessage } from "../types";
import { ContextManager, getRecentPairIndices } from "./contextManager";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Percentage of context window at which condensing is recommended. */
const CONDENSE_THRESHOLD = 0.75;

/** Number of most-recent user+assistant pairs to always keep. */
const PRESERVE_RECENT_PAIRS = 5;

/** The summarization system prompt prepended before the summary text. */
const SUMMARY_PREFIX =
  "[Conversation Summary]\n" +
  "The following is a summary of the earlier part of this conversation. " +
  "Key files, decisions, and errors have been preserved.\n\n";

// ---------------------------------------------------------------------------
// ConversationCondenser
// ---------------------------------------------------------------------------

export class ConversationCondenser {
  private contextManager: ContextManager;

  constructor(contextManager: ContextManager) {
    this.contextManager = contextManager;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Returns `true` when the conversation has exceeded 75 % of the context
   * window, meaning condensation should be triggered.
   */
  shouldCondense(messages: LlmMessage[]): boolean {
    this.contextManager.trackMessages(messages);
    const stats = this.contextManager.getUsageStats();
    return stats.percentage >= CONDENSE_THRESHOLD * 100;
  }

  /**
   * Summarize older messages and return a condensed message array.
   *
   * The `summarizeFn` parameter allows callers to plug in any summarization
   * backend (local model, API call, etc.).
   *
   * Strategy:
   *  - Always keep the system prompt (first message if role='system').
   *  - Keep the last `PRESERVE_RECENT_PAIRS` user+assistant pairs.
   *  - Feed the remaining older messages to `summarizeFn`.
   *  - Prepend the summary as a system message so the model knows what
   *    was condensed.
   */
  async condense(
    messages: LlmMessage[],
    summarizeFn: (text: string) => Promise<string>,
  ): Promise<LlmMessage[]> {
    if (messages.length === 0) {
      return messages;
    }

    // ---- Partition ----
    const systemPrompt: LlmMessage | null =
      messages[0].role === "system" ? messages[0] : null;
    const body = systemPrompt ? messages.slice(1) : [...messages];

    if (body.length === 0) {
      return messages;
    }

    // ---- Determine recent-pair indices to preserve ----
    const recentIndices = getRecentPairIndices(body, PRESERVE_RECENT_PAIRS);

    // ---- Build the "old" segment (indices NOT in the recent window) ----
    const oldMessages: LlmMessage[] = [];
    for (let i = 0; i < body.length; i++) {
      if (!recentIndices.has(i)) {
        oldMessages.push(body[i]);
      }
    }

    // If there's nothing to summarize, return as-is.
    if (oldMessages.length === 0) {
      return messages;
    }

    // ---- Flatten old messages into a single text block for summarization ----
    const oldText = this.flattenedText(oldMessages);

    // Prepend key-info extraction so the summary preserves it.
    const keyInfo = this.preserveKeyInfo(oldMessages);
    const textToSummarize =
      keyInfo.length > 0
        ? `Key information to preserve:\n${keyInfo}\n\nConversation:\n${oldText}`
        : oldText;

    // ---- Call the summarizer ----
    const summary = await summarizeFn(textToSummarize);

    // ---- Build the condensed message array ----
    const result: LlmMessage[] = [];

    // System prompt goes first (always).
    if (systemPrompt) {
      result.push(systemPrompt);
    }

    // Summary as a system message.
    result.push({
      role: "system",
      content: `${SUMMARY_PREFIX}${summary.trim()}`,
    });

    // Then the preserved recent pairs.
    for (let i = 0; i < body.length; i++) {
      if (recentIndices.has(i)) {
        result.push(body[i]);
      }
    }

    // Update the context manager so stats stay accurate.
    this.contextManager.trackMessages(result);

    return result;
  }

  // -----------------------------------------------------------------------
  // Key-info extraction
  // -----------------------------------------------------------------------

  /**
   * Scans a message array and extracts important context that should be
   * preserved in the summary:
   *  - File changes (write_file, edit_file, create_file)
   *  - Decisions made by the assistant
   *  - Errors encountered
   */
  preserveKeyInfo(messages: LlmMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      const content = msg.content;

      // ---- File changes ----
      const filePatterns = [
        /(?:write_file|create_file|edit_file|save_file)\s*\(([^)]+)\)/gi,
        /(?:wrote|created|edited|saved|modified)\s+(?:file\s+)?[`"']([^`"']+)[`"']?/gi,
        /(?:path|file)\s*[=:]\s*[`"']([^`"']+)[`"']?/gi,
      ];
      for (const pattern of filePatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          parts.push(`File changed: ${match[1].trim()}`);
        }
      }

      // ---- Decisions ----
      if (msg.role === "assistant") {
        const decisionPatterns = [
          /(?:we(?:'ll| will| would) |I(?:'ll| will| would) |decided to |chose to |going to )(.{10,80})/gi,
        ];
        for (const pattern of decisionPatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            parts.push(`Decision: ${match[0].trim()}`);
          }
        }
      }

      // ---- Errors ----
      if (msg.role === "assistant" || msg.role === "tool") {
        const errorPatterns = [
          /error[:\s]+(.{10,100})/gi,
          /failed to (.{10,100})/gi,
          /exception[:\s]+(.{10,100})/gi,
        ];
        for (const pattern of errorPatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            parts.push(`Error: ${match[0].trim()}`);
          }
        }
      }
    }

    // Deduplicate while preserving order.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const p of parts) {
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }

    return unique.join("\n");
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Flatten an array of messages into a single text string suitable for
   * summarization.
   */
  private flattenedText(messages: LlmMessage[]): string {
    return messages
      .map((m) => {
        const prefix =
          m.role === "tool" ? "[Tool result]" : `[${m.role}]`;
        return `${prefix} ${m.content}`;
      })
      .join("\n\n");
  }

}

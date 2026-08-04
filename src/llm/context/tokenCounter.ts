/**
 * Token counting utility for context window management.
 *
 * Uses a simple heuristic (~4 characters per token) — fast, zero external
 * dependencies, good enough for context-budget decisions.  A future iteration
 * can swap in tiktoken or a similar library for precision when needed.
 */

import type { LlmMessage } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Average number of characters per token (English text heuristic). */
const CHARS_PER_TOKEN = 4;

/** Approximate overhead tokens added by each message's role / framing. */
const ROLE_OVERHEAD_TOKENS = 4;

/** Approximate overhead tokens for a single tool-call block. */
const TOOL_CALL_OVERHEAD_TOKENS = 8;

/** Approximate overhead tokens for a single tool-result block. */
const TOOL_RESULT_OVERHEAD_TOKENS = 4;

// ---------------------------------------------------------------------------
// Model → context-window mapping
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-3.5-turbo": 16_385,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o3": 200_000,

  // Anthropic
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-3-sonnet-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  "claude-4-sonnet": 200_000,
};

/** Default context window when the model is unknown. */
const DEFAULT_CONTEXT_WINDOW = 8_192;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic token count for a plain string.
 *
 * Roughly: `ceil(text.length / 4)`.  Works well enough for budgeting without
 * pulling in a tokenizer dependency.
 */
export function countTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Count total tokens across an array of `LlmMessage` objects.
 *
 * Accounts for:
 *  - content tokens (via `countTokens`)
 *  - per-message role overhead
 *  - tool-call metadata (assistant messages that invoked tools)
 *  - tool-result metadata (role:'tool' messages)
 */
export function countMessageTokens(messages: LlmMessage[]): number {
  let total = 0;

  for (const msg of messages) {
    // Base content tokens
    total += countTokens(msg.content);

    // Role / framing overhead
    total += ROLE_OVERHEAD_TOKENS;

    // Tool-call overhead (assistant messages that carried tool invocations)
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      total += msg.toolCalls.length * TOOL_CALL_OVERHEAD_TOKENS;

      // Also count the serialised arguments string of each call
      for (const tc of msg.toolCalls) {
        if (tc.arguments) {
          total += countTokens(tc.arguments);
        }
      }
    }

    // Tool-result overhead
    if (msg.role === "tool" && msg.toolCallId) {
      total += TOOL_RESULT_OVERHEAD_TOKENS;
    }
  }

  return total;
}

/**
 * Return the estimated context-window size (max tokens) for a given model.
 *
 * Lookup order:
 *  1. Exact match in `MODEL_CONTEXT_WINDOWS`
 *  2. Substring match (e.g. "gpt-4o-2024-05-13" → "gpt-4o")
 *  3. `DEFAULT_CONTEXT_WINDOW`
 */
export function estimateContextWindow(config: {
  apiModelId?: string;
}): number {
  const model = config.apiModelId;

  if (!model) {
    return DEFAULT_CONTEXT_WINDOW;
  }

  // Exact match
  if (model in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[model];
  }

  // Substring match — check if any known key is a prefix of the model id
  for (const [key, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key)) {
      return tokens;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Calculate the number of tokens remaining in the context window.
 *
 * Returns `0` when the conversation already exceeds the limit.
 */
export function getRemainingTokens(
  messages: LlmMessage[],
  config: { apiModelId?: string },
): number {
  const used = countMessageTokens(messages);
  const max = estimateContextWindow(config);
  return Math.max(0, max - used);
}

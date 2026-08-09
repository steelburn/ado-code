/**
 * Token counting utility for context window management.
 *
 * Uses a simple heuristic (~4 characters per token) — fast, zero external
 * dependencies, good enough for context-budget decisions.  A future iteration
 * can swap in tiktoken or a similar library for precision when needed.
 */

import type { LlmMessage } from "../types";
import { messageText } from "../types";
import type { ModelInfo } from "../modelCapabilities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Average number of characters per token (fallback for mixed content). */
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
  "o1-pro": 200_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,

  // Anthropic
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-sonnet": 200_000,
  "claude-3-haiku": 200_000,
  "claude-4-sonnet": 200_000,
  "claude-4-opus": 200_000,

  // Google
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,

  // DeepSeek
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,

  // Meta
  "llama-4": 1_000_000,
  "llama-3.3": 128_000,
  "llama-3.1": 128_000,
};

/** Default context window when the model is unknown. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic characters-per-token ratio based on content type.
 *
 * Code uses more symbols and shorter words (lower ratio ≈ 3.5), while prose
 * has longer words and fewer symbols (higher ratio ≈ 4.5).  Mixed content
 * falls back to the default of 4.
 */
function charsPerToken(text: string): number {
  if (!text) return CHARS_PER_TOKEN;
  const codeChars = text.match(/[^a-zA-Z0-9\s]/g)?.length ?? 0;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const avgWordLength = words.length > 0 ? text.length / words.length : 5;
  const codeRatio = codeChars / Math.max(text.length, 1);
  // Code: high density of non-alphanumeric symbols and short words
  if (codeRatio > 0.15 || avgWordLength < 3.5) return 3.5;
  // Prose: few symbols, long words
  if (codeRatio < 0.05 && avgWordLength > 5) return 4.5;
  return CHARS_PER_TOKEN;
}

/**
 * Heuristic token count for a plain string.
 *
 * Uses a content-aware chars-per-token ratio instead of a flat constant,
 * giving better estimates for code (~3.5) and prose (~4.5) while staying
 * zero-dependency.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken(text));
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
    total += countTokens(messageText(msg.content));

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
 *  1. Live model data from the /models endpoint (most accurate — covers
 *     custom/local models, Ollama n_ctx, OpenRouter context_length, etc.)
 *  2. Exact match in `MODEL_CONTEXT_WINDOWS`
 *  3. Substring match (e.g. "gpt-4o-2024-05-13" → "gpt-4o")
 *  4. `DEFAULT_CONTEXT_WINDOW`
 */
export function estimateContextWindow(config: {
  apiModelId?: string;
}, liveModels?: ModelInfo[]): number {
  const model = config.apiModelId;

  if (!model) {
    return DEFAULT_CONTEXT_WINDOW;
  }

  // 1. Check live data from /models endpoint (most accurate)
  if (liveModels) {
    const lower = model.toLowerCase();
    const live = liveModels.find(
      m => m.id === model || m.id.toLowerCase() === lower || lower.includes(m.id.toLowerCase()) || m.id.toLowerCase().includes(lower)
    );
    if (live?.contextWindow && live.contextWindow > 0) {
      return live.contextWindow;
    }
  }

  // 2. Check hardcoded table
  const lower = model.toLowerCase();

  // Exact match
  if (lower in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[lower];
  }

  // Substring match — check if any known key appears inside the model id
  for (const [key, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) {
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

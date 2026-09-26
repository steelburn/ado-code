/**
 * Token counting utility for context window management.
 *
 * Uses a simple heuristic (~4 characters per token) — fast, zero external
 * dependencies, good enough for context-budget decisions.  A future iteration
 * can swap in tiktoken or a similar library for precision when needed.
 */

import type { LlmMessage } from "../types";
import type { ModelInfo } from "../modelCapabilities";
import type { ContentBlockParam } from "../providers/BaseProvider";

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

// Vision-image token estimates (OpenAI-style pricing; other providers are
// in the same ballpark). A base cost per image plus per-tile cost derived
// from the encoded payload size, capped like the API caps high-detail tiles.
const IMAGE_BASE_TOKENS = 85;
const IMAGE_MAX_TOKENS = 1105;
/** ~1 tile token per 900 raw image bytes beyond the base. */
const IMAGE_BYTES_PER_TOKEN = 900;

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
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Regex matching CJK ideographs, Hangul, Hiragana, and Katakana characters.
 * Non-Latin scripts tokenize at ~1 to 2.5 tokens per character in modern BPE tokenizers
 * (~0.6 chars/token) rather than the Latin/English ~4 chars/token.
 */
const CJK_REGEX = /[\u2E80-\u2EFF\u2F00-\u2FDF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g;

/**
 * Heuristic characters-per-token ratio based on content type.
 *
 * Code uses more symbols and shorter words (lower ratio ≈ 2.8 - 3.5), while prose
 * has longer words and fewer symbols (higher ratio ≈ 4.5). Mixed content
 * falls back to the default of 4.
 */
function charsPerToken(text: string): number {
  if (!text) return CHARS_PER_TOKEN;
  // Match standard ASCII code symbols / punctuation, excluding non-ASCII
  const codeChars = text.match(/[!-/:-@[-`{-~]/g)?.length ?? 0;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const avgWordLength = words.length > 0 ? text.length / words.length : 5;
  const codeRatio = codeChars / Math.max(text.length, 1);
  // Dense code / JSON / symbols: high density of punctuation symbols
  if (codeRatio > 0.25) return 2.8;
  // Code: moderate density of non-alphanumeric symbols or short words
  if (codeRatio > 0.15 || avgWordLength < 3.5) return 3.5;
  // Prose: few symbols, long words
  if (codeRatio < 0.05 && avgWordLength > 5) return 4.5;
  return CHARS_PER_TOKEN;
}

/**
 * Heuristic token count for a plain string.
 *
 * Uses a content-aware chars-per-token ratio for Latin/code content, and
 * accurately weights CJK characters (~1.5 tokens/char) to prevent massive
 * undercounting on non-Latin text.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  if (cjkCount === 0) {
    return Math.ceil(text.length / charsPerToken(text));
  }
  const nonCjkText = text.replace(CJK_REGEX, '');
  const nonCjkTokens = nonCjkText.length > 0 ? Math.ceil(nonCjkText.length / charsPerToken(nonCjkText)) : 0;
  // In BPE tokenizers (cl100k, Claude, LLaMA), each CJK character is typically 1 to 2.5 tokens
  const cjkTokens = Math.ceil(cjkCount * 1.5);
  return nonCjkTokens + cjkTokens;
}

/**
 * Token estimate for a single image content block. Providers bill vision
 * input as a flat cost plus per-tile cost; we derive a rough tile count from
 * the payload size (base64 overhead is ~4/3, so chars * 0.75 ≈ raw bytes).
 * URL images carry no size hint — count the flat base only.
 */
export function countImageTokens(source: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string }): number {
  if (source.type !== 'base64' || !source.data) {
    return IMAGE_BASE_TOKENS;
  }
  const bytes = Math.floor(source.data.length * 0.75); // base64 → raw bytes
  const tiles = Math.floor(bytes / IMAGE_BYTES_PER_TOKEN);
  return Math.min(IMAGE_MAX_TOKENS, IMAGE_BASE_TOKENS + tiles);
}

/**
 * Token count of a message's content: text blocks via the heuristic, image
 * blocks via a size-based estimate, and ANY other structured block (tool_use
 * inputs, tool_result payloads, …) via its serialized JSON — providers bill
 * structured content roughly by payload size, so treating it as free would
 * undercount every tool-assisted request. This is the count that reflects
 * what is actually passed to the LLM.
 */
export function countContentTokens(content: string | ContentBlockParam[]): number {
  if (typeof content === 'string') {
    return countTokens(content);
  }
  let total = 0;
  for (const block of content) {
    if (block.type === 'text') {
      total += countTokens(block.text);
    } else if (block.type === 'image') {
      total += countImageTokens(block.source);
    } else {
      // Unknown/structured block (tool_use, tool_result, …): serialize it.
      total += countTokens(JSON.stringify(block));
    }
  }
  return total;
}

/**
 * Count total tokens across an array of `LlmMessage` objects.
 *
 * Accounts for everything that is actually serialized and sent to the
 * provider:
 *  - content tokens: text AND image blocks, plus any structured block
 *    (tool_use / tool_result) carried inside a content array;
 *  - per-message role overhead;
 *  - tool-call metadata (assistant messages that invoked tools) — the call
 *    id + serialized argument JSON the provider re-sends on later iterations;
 *  - tool-result metadata + payload (role:'tool' messages).
 */
export function countMessageTokens(messages: LlmMessage[]): number {
  let total = 0;

  for (const msg of messages) {
    // Base content tokens (text + images + any embedded structured blocks)
    total += countContentTokens(msg.content);

    // Role / framing overhead
    total += ROLE_OVERHEAD_TOKENS;

    // Tool-call overhead (assistant messages that carried tool invocations).
    // Providers re-send each call's id/name/arguments JSON on every later
    // request until the matching tool result lands — count it all.
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        total += TOOL_CALL_OVERHEAD_TOKENS;
        // The arguments string is the bulk of a tool-call block.
        if (tc.arguments) {
          total += countTokens(tc.arguments);
        }
        if (tc.name) {
          total += countTokens(tc.name);
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

  // Substring match: check longer keys first (e.g. "o1-mini" before "o1", "claude-3-5-sonnet" before "claude-3-sonnet")
  // and ensure delimiter boundary so "demo1" doesn't falsely match "o1".
  const sortedEntries = Object.entries(MODEL_CONTEXT_WINDOWS).sort((a, b) => b[0].length - a[0].length);
  for (const [key, tokens] of sortedEntries) {
    const escaped = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (regex.test(lower)) {
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

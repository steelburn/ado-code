/**
 * Model capability inference — determines whether an LLM model id supports
 * image (vision) input and tool/function calling.
 *
 * Strategy: curated exact matches + conservative name-pattern heuristics.
 * Unknown models default to tools=true (nearly all modern chat models support
 * function calling) and vision=false (safe: image pasting stays disabled
 * until the model is known-capable). Deliberately vscode-free for fast tests.
 */

export interface ModelCapabilities {
  /** Model accepts image input (multimodal/vision). */
  vision: boolean;
  /** Model supports tool/function calling. */
  tools: boolean;
}

/** Models known to have NO function-calling support. */
const NO_TOOLS_EXACT = new Set([
  'dall-e-3',
  'dall-e-2',
  'whisper-1',
  'tts-1',
  'tts-1-hd',
  'gpt-3.5-turbo-instruct',
  'text-embedding-3-large',
  'text-embedding-3-small',
  'text-embedding-ada-002',
]);

/** Name fragments that indicate a non-tool endpoint (embeddings, TTS, image gen). */
const NO_TOOLS_PATTERN = /embedding|whisper|\btts\b|dall-?e/i;

/**
 * Name fragments that indicate multimodal/vision input. Covers OpenAI GPT-4o/
 * 4.1/4.5 + o-series, Claude (all 3+ models are multimodal), Gemini (all),
 * Qwen-VL, Pixtral, LLaVA-family, Phi-3-vision, and any id containing
 * "vision"/"vl" (e.g. cogvlm, internvl, glm-4v, smolvlm).
 */
const VISION_PATTERN =
  /vision|gemini|claude|4o|4\.1|4\.5|pixtral|llava|idefics|cogvlm|moondream|firellava|bakllava|smolvlm|paligemma|internvl|glm-4v|qwen[^ ]*\bvl\b|gpt-4-turbo|\bo[134]\b/i;

/**
 * Infer capabilities for a model id. Empty/unknown ids → { vision: false, tools: true }.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const id = (modelId ?? '').toLowerCase().trim();
  if (!id) return { vision: false, tools: true };

  const vision = VISION_PATTERN.test(id);
  const tools = !NO_TOOLS_EXACT.has(id) && !NO_TOOLS_PATTERN.test(id);
  return { vision, tools };
}

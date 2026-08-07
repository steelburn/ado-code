/**
 * Model capability inference — determines whether an LLM model id supports
 * image (vision) input and tool/function calling.
 *
 * Strategy (two layers, live data wins):
 * 1. LIVE (authoritative when present): gateways that expose capabilities on
 *    their /models endpoint (OpenRouter `architecture.input_modalities`,
 *    Ollama `capabilities[]`) are parsed by `capabilitiesFromGateway`. This
 *    never goes stale and covers arbitrary/custom model ids.
 * 2. HEURISTIC (fallback): curated exact matches + name-pattern heuristics
 *    for endpoints that only return ids (OpenAI, Anthropic, vLLM, …).
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

/** A model id plus OPTIONAL live capability hints from the gateway. */
export interface ModelInfo {
  id: string;
  vision?: boolean;
  tools?: boolean;
}

/** Per-model user override: { model, vision?, tools? } — user knowledge beats
 *  both live gateway hints and the name heuristic. Stored as an array so the
 *  Configuration page can edit rows; the empty model id is ignored. */
export interface CapabilityOverride {
  model: string;
  vision?: boolean;
  tools?: boolean;
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
 * 4.1/4.5/5 + o-series, Claude (all 3+ models are multimodal), Gemini (all),
 * Qwen-VL, Pixtral, LLaVA-family, Phi-3-vision, Llama 4, Gemma 3, DeepSeek-VL,
 * GLM-4v/4.5v, MiniCPM-V, and any id containing "vision" (cogvlm, internvl,
 * smolvlm, etc.).
 */
const VISION_PATTERN =
  /vision|gemini|claude|4o|4\.1|4\.5|gpt-5|pixtral|llava|idefics|cogvlm|moondream|firellava|bakllava|smolvlm|paligemma|internvl|glm-4v|glm-4\.5v|qwen[^ ]*\bvl\b|gpt-4-turbo|\bo[1-9]\b|llama-4|gemma-3|deepseek-vl|minicpm/i;

/**
 * Parse capability hints from a gateway's /models entry (OpenRouter shape:
 * { id, architecture: { input_modalities: ["text","image"] } }; Ollama shape:
 * { name|model, capabilities: ["vision","tools"] }). Returns only fields the
 * gateway explicitly declared — undefined means "unknown, use the heuristic".
 */
export function capabilitiesFromGateway(raw: unknown): { vision?: boolean; tools?: boolean } {
  if (!raw || typeof raw !== 'object') return {};
  const entry = raw as Record<string, any>;

  // OpenRouter: architecture.input_modalities is an array of modality ids
  // ("text", "image", "audio", ...). Vision ⇔ "image" present.
  const modalities = entry.architecture?.input_modalities;
  if (Array.isArray(modalities)) {
    return { vision: modalities.includes('image') };
  }

  // Ollama: capabilities is an array of strings ("vision", "tools", "completion"…).
  const capabilities = entry.capabilities;
  if (Array.isArray(capabilities)) {
    const set = new Set(capabilities);
    const hints: { vision?: boolean; tools?: boolean } = {};
    if (set.has('vision')) hints.vision = true;
    if (set.has('tools')) hints.tools = true;
    return hints;
  }

  return {};
}

/**
 * Infer capabilities for a model id. Empty/unknown ids → { vision: false, tools: true }.
 * Precedence: user `overrides` (exact model-id match) > `live` gateway hints >
 * the name heuristic. Each field is resolved independently, so a partial
 * override (e.g. only vision) leaves the other field to live/heuristic.
 */
export function getModelCapabilities(
  modelId: string,
  live?: { vision?: boolean; tools?: boolean },
  overrides?: CapabilityOverride[]
): ModelCapabilities {
  const id = (modelId ?? '').toLowerCase().trim();
  const override = overrides?.find(o => (o.model ?? '').toLowerCase().trim() === id);
  if (!id) return { vision: false, tools: true };

  const vision = override?.vision !== undefined
    ? override.vision
    : live?.vision !== undefined ? live.vision : VISION_PATTERN.test(id);
  const tools = override?.tools !== undefined
    ? override.tools
    : live?.tools !== undefined
      ? live.tools
      : !NO_TOOLS_EXACT.has(id) && !NO_TOOLS_PATTERN.test(id);
  return { vision, tools };
}

/** Map a raw gateway model entry to a ModelInfo (id + only the hints the gateway declared). */
export function toModelInfo(raw: unknown): ModelInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, any>;
  const id = String(entry.id ?? entry.name ?? entry.model ?? '').trim();
  if (!id) return null;
  const live = capabilitiesFromGateway(entry);
  const info: ModelInfo = { id };
  if (live.vision !== undefined) info.vision = live.vision;
  if (live.tools !== undefined) info.tools = live.tools;
  return info;
}

/**
 * Detect when an AI response contains a choice prompt — a question followed
 * by numbered or bulleted options. Returns the extracted options, or null
 * if the response doesn't look like a choice prompt.
 *
 * Three paths, cheapest first:
 * - `parseChoiceFence` — the MAIN model appends a ```choice fenced JSON block
 *   when its answer offers the user a choice (see the output-format
 *   instruction in prompts/system.ts). Zero extra cost.
 * - `parseChoicePrompt` — fast regex (no extra LLM cost). Misses responses
 *   that ask a question WITHOUT numbered/bulleted options (e.g. "Want me to
 *   run X and/or update Y?").
 * - `detectChoicePrompt` — async fallback: only when the response still
 *   looks question-like, asks the (optionally cheaper) model to extract a
 *   structured { question, options } prompt, so natural-language offers
 *   still surface as clickable options.
 */
import { LlmClient } from './client';
import { LlmMessage } from './types';

export interface ChoicePrompt {
  question: string;
  options: Array<{ label: string; value: string }>;
}

export function parseChoicePrompt(text: string): ChoicePrompt | null {
  if (!text || text.length > 2000) return null;

  // Patterns that signal the AI is asking the user to choose
  const questionPatterns = [
    /(?:which|what|would you|do you|shall|should|can I|may I|want me to|prefer|like me to|suggest|recommend)\b.*[?？]\s*$/im,
    /(?:choose|select|pick|enter|type)\s+(?:one|an?|the)\b.*[?？]?\s*$/im,
    /(?:options?|choices?|alternatives?|possibilities?)\s*[:：]\s*$/im,
    /(?:here are|these are|the following)\s+(?:the\s+)?(?:options?|choices?|alternatives?)\s*[:：]/im,
  ];

  // Check if the text ends with a question or choice prompt
  const lines = text.split('\n');
  const lastLines = lines.slice(-5).join('\n').trim();

  let hasQuestion = false;
  for (const pattern of questionPatterns) {
    if (pattern.test(lastLines)) {
      hasQuestion = true;
      break;
    }
  }

  if (!hasQuestion) return null;

  // Extract numbered or bulleted options
  const optionPatterns = [
    /^\s*(?:\d+[.)]\s*[-–—]?\s*|[-–—•*]\s+)(.+)$/gm,
  ];

  const options: Array<{ label: string; value: string }> = [];
  for (const pattern of optionPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const label = match[1].trim();
      if (label && label.length > 0 && label.length < 200) {
        options.push({ label, value: label });
      }
    }
  }

  // Need at least 2 options to be a choice prompt
  if (options.length < 2 || options.length > 10) return null;

  // Extract the question (everything before the first option)
  const firstOptionIdx = text.search(/^\s*(?:\d+[.)]\s*[-–—]?\s*|[-–—•*]\s+)/m);
  const question = firstOptionIdx > 0
    ? text.substring(0, firstOptionIdx).trim()
    : text.trim();

  return { question, options };
}

// ---------------------------------------------------------------------------
// Main-model fence (primary path)
// ---------------------------------------------------------------------------

/**
 * Extract a choice prompt from a ```choice fenced block that the MAIN model
 * appends when its response ends with a choice offer (see the output-format
 * instruction in prompts/system.ts). Returns null when no valid fence is
 * present — the caller then falls back to the regex path and, optionally,
 * the LLM detector.
 */
export function parseChoiceFence(text: string): ChoicePrompt | null {
  if (!text) return null;
  // Tolerates a missing closing fence (models occasionally forget it) and
  // any prose inside the fence (parseChoiceDetectorJson skips to the first {).
  const fence = text.match(/```choice\s*\n([\s\S]*?)(?:```|$)/);
  if (!fence) return null;
  return parseChoiceDetectorJson(fence[1] ?? '');
}

/**
 * Remove ```choice fenced blocks from assistant text so the JSON never
 * renders in the chat bubble, leaks into the persisted conversation, or is
 * re-sent on later turns. Collapses the blank lines a removed fence leaves
 * behind; text without a fence is returned untouched.
 */
export function stripChoiceFence(text: string): string {
  if (!text) return text;
  const stripped = text.replace(/```choice[\s\S]*?(?:```|$)/g, '');
  if (stripped === text) return text;
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// LLM-assisted detection fallback
// ---------------------------------------------------------------------------

const MAX_DETECT_CHARS = 4000;
const DETECT_TIMEOUT_MS = 12000;

/**
 * Cheap heuristic gate: should we spend an LLM call on this response?
 * Only when the text is a plausible question-and-offer: 40..4000 chars and
 * either ends with '?' or uses an offer phrasing. The regex path handles
 * numbered/bulleted lists; this gate catches the rest.
 */
export function looksLikeChoiceQuestion(text: string): boolean {
  if (!text || text.length < 40 || text.length > MAX_DETECT_CHARS) return false;
  const tail = text.slice(-400);
  return (
    /[?？]\s*$/.test(tail) ||
    /(want me to|should i|would you (like|want)|shall i|do you (want|need|prefer)|may i|can i)\b/i.test(tail)
  );
}

/**
 * Defensive parse of the detector model's output: strips ``` fences, finds
 * the first {...} block, and validates the shape. Accepts either
 * {"question": "...", "options": ["...", ...]} or {"none": true}.
 */
export function parseChoiceDetectorJson(raw: string): ChoicePrompt | null {
  if (!raw) return null;
  // Strip markdown fences and leading prose.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let body = fenced ? fenced[1] : raw;
  const brace = body.indexOf('{');
  if (brace >= 0) body = body.slice(brace);
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed && parsed.none === true) return null;
  const question = typeof parsed?.question === 'string' ? parsed.question.trim() : '';
  const options = Array.isArray(parsed?.options)
    ? parsed.options
        .filter((o: any) => typeof o === 'string' && o.trim().length > 0)
        .map((o: string) => { const label = o.trim().slice(0, 160); return { label, value: label }; })
    : [];
  if (!question || options.length < 2 || options.length > 6) return null;
  return { question: question.slice(0, 400), options };
}

/**
 * Extract a choice prompt from a finished response, using an LLM call as
 * fallback when the regex path misses. Returns null when the response is
 * not a choice question, when the model says so, or on any failure — the
 * caller must never break the chat over detection.
 *
 * @param client The LLM client for the detection call — construct it with
 *               the (optionally cheaper) model override at the call site.
 */
export async function detectChoicePrompt(
  text: string,
  client: LlmClient
): Promise<ChoicePrompt | null> {
  // 1. Regex fast path — zero extra cost.
  const fast = parseChoicePrompt(text);
  if (fast) return fast;

  // 2. Heuristic gate — only spend a call on plausible questions.
  if (!looksLikeChoiceQuestion(text)) return null;

  const system = [
    'You are a strict JSON extractor for a coding assistant UI.',
    'The user just received the following AI response. Decide whether it ends with a question OFFERING the user a choice of next actions (e.g. "Want me to ...?", "Should I ... or ...?", "Would you like ...?").',
    'If YES, reply with ONLY valid JSON: {"question": "<the question, without the options>", "options": ["<imperative option 1>", "<imperative option 2>", ...]} — 2 to 6 options, each a short actionable phrase (max 120 chars), NO numbering or bullets.',
    'If NO (it is not a choice offer), reply with ONLY valid JSON: {"none": true}.',
    'Reply with raw JSON only — no markdown fences, no commentary.',
  ].join('\n');

  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: text.length > MAX_DETECT_CHARS ? text.slice(-MAX_DETECT_CHARS) : text },
  ];

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DETECT_TIMEOUT_MS);
  try {
    let raw = '';
    for await (const chunk of client.streamChat(messages, abort.signal)) {
      raw += chunk.content;
    }
    return parseChoiceDetectorJson(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

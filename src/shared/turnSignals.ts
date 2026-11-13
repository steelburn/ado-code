// Per-turn agentic signals (AI-engineering roadmap #1, stage 1).
//
// Every field here is something the agentic loop ALREADY detects while it runs
// — these are counters, not new instrumentation. The loop stops at an iteration
// limit, halts on a repetitive loop, blocks exact-repeat calls, nudges the model
// out of read-only spinning, cuts oversized tool results and returns `{ error }`
// JSON when a tool fails; today each of those ends in a transcript line and is
// then forgotten, which leaves every prompt/loop change unfalsifiable.
//
// Kept in `shared/` with no imports so the model-facing loop (`llm/`) and the
// aggregation layer (`services/metrics/`) can both use it without either one
// depending on the other.

export interface TurnSignals {
  /** Model round-trips consumed by the turn — what the iteration budget meters. */
  iterations: number;
  /** Tool calls the model requested (including ones the loop detector blocked). */
  toolCalls: number;
  /** Tool results actually returned to the model. */
  toolResults: number;
  /** Results whose payload was `{ error: ... }` — a failed tool, not a failed turn. */
  toolErrors: number;
  /** Results the size cap cut down (a truncation marker is present). */
  truncatedResults: number;
  /** Calls refused by the loop detector as exact repeats. */
  loopBlocks: number;
  /** "You are reading, not deciding" nudges injected after N read-only rounds. */
  readSynthesisNudges: number;
  /** User steering messages injected mid-run. */
  steeringMessages: number;
  /**
   * Self-review round-trips spent at a distress point (AI-engineering
   * roadmap #2). 0 or 1 per turn: the reflection is once-per-turn by design.
   */
  reflectionTurns: number;
  /**
   * Review round-trips over the turn's own diff (AI-engineering roadmap #3).
   * 0 or 1 per turn: the gate is once-per-turn by design.
   */
  reviewTurns: number;
  /**
   * Gates that demanded a fix and named it — i.e. turns that would have been
   * reported as finished while the change was wrong.
   */
  reviewRevisions: number;
}

/** Order matters only for the report tables (cheapest signal first). */
export const TURN_SIGNAL_KEYS: readonly (keyof TurnSignals)[] = [
  'iterations',
  'toolCalls',
  'toolResults',
  'toolErrors',
  'truncatedResults',
  'loopBlocks',
  'readSynthesisNudges',
  'steeringMessages',
  'reflectionTurns',
  'reviewTurns',
  'reviewRevisions',
];

export function emptyTurnSignals(): TurnSignals {
  return {
    iterations: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    truncatedResults: 0,
    loopBlocks: 0,
    readSynthesisNudges: 0,
    steeringMessages: 0,
    reflectionTurns: 0,
    reviewTurns: 0,
    reviewRevisions: 0,
  };
}

/** Component-wise sum. Returns a NEW object (callers treat signals as immutable). */
export function addTurnSignals(a: TurnSignals, b: TurnSignals): TurnSignals {
  const out = emptyTurnSignals();
  for (const key of TURN_SIGNAL_KEYS) out[key] = a[key] + b[key];
  return out;
}

/**
 * A tool result is an error when the harness contract held: failures come back
 * as JSON `{ "error": "..." }` rather than being thrown (AGENTS.md).
 */
export function isToolErrorResult(content: string): boolean {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{')) return false;
  return /^\{\s*"error"\s*:/.test(trimmed);
}

/**
 * True when a tool result carries one of the harness size-cap markers, e.g.
 * `…[truncated; omitted 12,345 chars]…`, `…[result truncated: … / ~N tokens]…`
 * or `…[read_file truncated: showing first 400 of 649 lines]…`. They all share
 * the shape `…[<kind> truncated: …]…`, so one pattern covers the family.
 */
const TRUNCATION_MARKER = /…\[[^\]]{0,40}truncated/;

export function isTruncatedResult(content: string): boolean {
  return TRUNCATION_MARKER.test(content);
}

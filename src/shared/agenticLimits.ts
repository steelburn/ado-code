/**
 * Max agentic loop iterations per chat turn.
 *
 * One iteration = one model round-trip in the agentic tool loop
 * (runAgenticChat); a single iteration may execute a BATCH of parallel tool
 * calls, so this is an ITERATION budget, not a tool-call budget. A turn that
 * exhausts the budget ends with a concluding chat reply
 * (`reachedIterationLimit`), not a thrown error.
 *
 * Single source of truth for both the `adoCode.act.toolBudget` setting
 * default (config/settings.ts; package.json contributes mirrors the value)
 * and the runAgenticChat() parameter default (llm/agentic.ts) — import this
 * constant instead of hardcoding the number twice so the two can never
 * drift apart again.
 */
export const DEFAULT_MAX_ITERATIONS = 50;

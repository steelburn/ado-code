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
export const DEFAULT_MAX_ITERATIONS = 100;

/**
 * ADO Code's own bookkeeping tools. A round-trip that calls ONLY these tools
 * is internal to the harness (recording the session goal, ticking to-do
 * items) and must NOT consume the user's iteration budget — see
 * runAgenticChat() in llm/agentic.ts.
 */
export const INTERNAL_TODO_TOOLS: ReadonlySet<string> = new Set(['set_goal', 'update_todo_list']);

/**
 * Safety ceiling on internal-only round-trips. Excluding INTERNAL_TODO_TOOLS
 * from the iteration budget must not let a misbehaving model loop forever, so
 * once this many internal-only round-trips have occurred the loop concludes
 * normally (reachedIterationLimit) instead of continuing to call them.
 */
export const MAX_INTERNAL_ITERATIONS = 50;


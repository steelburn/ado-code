# Chat Token & Tool-Call Optimization Plan

Goal: reduce token consumption (and often cost/latency) of the agentic chat loop
without changing user-facing behavior.

## Problem statement

The agentic loop (`src/llm/agentic.ts`) re-sends the **entire** conversation on
**every** iteration: system prompt (~8KB) + all 20+ tool schemas + every prior
message + every accumulated tool **result**. `maxIterations=8` /
`actToolBudget=50` mean a multi-tool turn resends the full history many times.

Two compounding drivers:
1. **Tool results are large and persistent.** `read_file` returns whole files
   (unbounded), `run_terminal_command` up to 8k chars, `get_work_item` the full
   comment thread. `ContextManager` deliberately keeps tool results at the
   HIGHEST priority (`getPriority`), so they survive truncation.
2. **The token budget ignores the system prompt and tool schemas.**
   `trimConversation` / status bar / condense threshold count only
   `this.conversation`, which are re-sent with every request anyway.

## Status

- [x] **1. Choke-point result capper + bounded `read_file`** — `capToolResult` (head+tail, ~4k-token budget) applied to `read_file` (defaults to first ~200 lines), `run_terminal_command`, `get_work_item` (capped description/AC/thread), `list_workspace`.
- [x] **2. Compact prior tool results** — `agentic.ts` stubs tool results older than the most recent iteration (kept messages preserve C1 id-referencing), so the model still gets the latest output full while older ones stop re-sending.
- [x] **3. Mode-based tool filtering + description trim** — plan mode now offers only read-only tools; trimmed the most prose-heavy descriptions.
- [x] **4. Overhead in the budget** — `ContextManager.setOverheadTokens()` includes system prompt + tool schemas in truncation/remaining/status-bar accounting.
- [x] **5. Diagnostics** — per-turn cost debug log (iterations, tool calls, conversation + overhead tokens).
- [x] **6. Provider-native token counting** — `LlmProvider.countTokens()` (Anthropic `/v1/messages/count_tokens`, always free; OpenAI-compatible via `usage.prompt_tokens` from a throttled minimal request), wired into the token status bar with heuristic fallback. Toggle `adoCode.llm.useNativeTokenCounting` (default on). Gemini/openai-compatible gateways that report usage benefit automatically.
- [x] **7. Parallel tool execution (0.6.0)** — independent tool calls in a batch run concurrently (`Promise.all`), results re-ordered to call order; a batch containing a consent-requiring call runs sequentially (no stacked cards). Cuts wall-clock latency per turn, which also caps how much context accumulates under a fixed iteration budget.
- [x] **8. Truncated-response guard (0.6.0)** — `stopReason` `length`/`max_tokens` ⇒ the whole batch is failed with "re-issue with complete arguments" instead of executing salvage-parsed, possibly truncated tool args (a wasted execute + poisoned history).
- [x] **9. Batched edits (0.6.0)** — `edit_file` accepts `edits[]` for multiple disjoint changes in one call; per-file mutation queue serializes same-file mutations so parallel batches can't race.
- [x] **10. Grep with per-line truncation (0.6.0)** — new live `search_files` tool caps each match line at 500 chars (`truncateMatchLine`, pi-style `truncateLine`), bounded result count (100–200), and excludes `node_modules/.git/dist/.vscode/out` — searching no longer risks dumping huge lines or binaries into context.
- [x] **11. Structure-first, read-lazy exploration guidance (0.6.4)** — instead of only capping what a tool MAY return, the model is told to READ LESS: orient on the directory structure + docs first (cached Repository Understanding, `list_workspace`, README/AGENTS.md/docs/package.json) before implementation files, then drill into key files with narrow `read_file` ranges / `search_files` — bulk whole-file reads (which persist in the conversation for the whole session) are discouraged. Guidance lives in the chat system prompt's read guidelines, the `read_file`/`list_workspace` tool descriptions, the agent-handoff prompt (`buildAgentPrompt`), and the repo-understanding summarizer's prompt (which must lead with structure/docs so future sessions navigate without reading many files).

## Work items (ordered, each independently shippable)

### 1. Choke-point result capper + bounded `read_file`  (`src/llm/tools.ts`)
- `read_file` defaults to a bounded line window (first ~200 lines) and still
  honors explicit `startLine/endLine`, with a `[truncated]` note.
- Add a token-aware `capToolResult(content)` helper (head+tail trimming with a
  truncation marker; ~4–6k token budget default) applied to the high-volume
  tool returns: `read_file`, `run_terminal_command`, `get_work_item`,
  `list_workspace`.
- Keeps the model's view of the file for the whole turn small without losing
  tool-calling correctness.

### 2. Compact prior tool results in the loop  (`src/llm/agentic.ts`)
- After a few iterations, stub out older `role:'tool'` results to
  `[result truncated: <tool>]` while keeping the newest 1–2 in full.
- Messages are KEPT (not removed) so C1 tool-id referencing still holds for
  OpenAI (`tool_call_id`) and Anthropic (`tool_use_id`); only the payload
  shrinks. Removes the biggest sustained driver on long turns.

### 3. Mode-based tool filtering + description trim  (`src/llm/tools.ts`)
- **Plan mode sends only read-only tools** (the model can't legally call the
  mutating ones anyway — filtering them saves tokens and reduces wrong calls).
- Lightly trim the most prose-heavy tool descriptions (commit_worktree,
  create_pull_request, delegate_to_agent) preserving core semantics.

### 4. Account for system prompt + tools in the budget  (`src/llm/context/`)
- Add a fixed-overhead token budget to `ContextManager` (system prompt + tool
  definitions) so `shouldTruncate`/`getRemainingTokens`/status bar reflect the
  real per-request size, not just `this.conversation`.

### 5. Diagnostics
- Per-turn token cost debug log (`system + tools + history + results`) so
  before/after can be measured.

## Out of scope (future)
- Smarter recency window tuning (e.g. per-item staleness instead of whole-iteration stubbing).
- Adaptive iteration budgets (raise `actToolBudget` when a turn is going well).
- Semantic result dedup/caching across turns (same file read twice = one fetch).

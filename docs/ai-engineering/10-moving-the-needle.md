# 10 — Moving the Needle

The other articles describe the state. This one ranks what to do about it.

Ordering principle: **cheap work that creates a feedback loop beats expensive
work that adds capability**, because a project with no measurement cannot tell
whether any capability work helped. That is why eval sits first despite being the
least exciting item on the list.

## Ranked

### 1. Outcome counters, then a golden set — eval harness

**Buys:** turns every prompt and loop change from unfalsifiable into testable.
**Cost:** small. The hard part already exists.
**Unlocks:** [01](01-prompt-engineering.md), [07](07-tool-use-and-model-routing.md),
[04](04-loop-engineering.md) — three dimensions currently maintained by care
rather than feedback.

Three stages, cheapest first:

1. **Aggregate what already happens. — shipped.** `reachedIterationLimit`, the
   repeat-loop halt, read-synthesis nudges, truncation markers, tool errors and
   mid-run steering are now counted per turn: the loop returns a `signals` block
   on `LlmAgenticResult`, `src/services/metrics/` folds each finished turn into
   `.ado-code/metrics/turn-outcomes.json`, and **Show Turn Outcome Counters**
   renders a completion rate, per-100-turns signal rates and a last-50 window.
   Adding a signal is now one field in `shared/turnSignals.ts`, not a new
   pipeline. Two deliberate limits: it judges completion, never quality (that is
   stage 2), and it only sees turns that reach the agentic loop — a turn that dies
   before the first model round-trip is still invisible.
2. **Record real runs as fixtures.** Session files already contain
   `{prompt, tool sequence, outcome}`. Promote a handful of representative ones
   into a corpus.
3. **Assert shapes, not text.** Golden expectations should be about behaviour:
   *reads before editing*, *runs the test command after editing*, *does not read
   the same file three times*, *does not exceed N iterations for a one-file
   change*. Prose diffs are too brittle to gate on; sequences are not.

Do not start with a benchmark. Start with "did this turn succeed?".

### 2. Review before finishing — shipped (both halves)

**Buys:** fewer wrong-but-confident completions; less reliance on loop
heuristics to catch bad work.
**Cost:** one extra round-trip per turn, in the existing loop, no new machinery.
**Category:** [02](02-agentic-engineering.md).

Before the model concludes, ask it to review its own diff against the original
request: did it do everything, did it verify, did it leave debris. This is the
single highest quality-per-line change available. It is also the change most
likely to make item 1's completion rate visibly move, which is a nice property
for a first experiment.

**Shipped, narrower than proposed.** The reflection fires where a halt is a
*heuristic* rather than the user's budget — the repeat-loop circuit breaker.
The loop builds a factual digest of the turn (iterations, per-tool call counts
with failures, files touched, blocked repeats, read-only streak, steering),
asks for a `VERDICT` / `GAP` / `NEXT` block, and honours a `continue` only when
it names a different next step — then grants four extra iterations. A
plan-less `continue` degrades to the wrap-up: resuming with no change of
strategy would just re-trip the same heuristic.

Two deliberate boundaries. It does **not** run when the iteration budget is
exhausted, because the budget is the user's, the wrap-up already spends a
round-trip asking for a summary, and a reflection there could not change the
outcome — it would only double the cost of the most expensive turns. And the diff
review fires only when the turn actually MUTATED files, only once, so a read-only
turn pays nothing.

The second half — reviewing a *successful* finish, where wrong-but-confident
completions actually live — shipped as roadmap #3: one tool-free round-trip over
the real diff, an actionable `revise` resuming the loop with a bounded bonus, and
`reviewRevisions` recording every gate that caught something.

What is left is independence: the reviewer is the author, in the same context on
the same model. It catches a change that is incomplete — a stub, a caller never
updated, a claim the diff does not contain — but not a design that is wrong and
plausible. Routing the review to a different model, or to a fresh context holding
only the task and the diff, is the next step, and it is a routing change rather
than a new agent.

### 3. Per-run cost and time ceiling

**Buys:** removes the only ungoverned resource in the loop.
**Cost:** small — token accounting exists in `tokenCounter.ts`; the loop already
counts iterations.
**Category:** [04](04-loop-engineering.md), [07](07-tool-use-and-model-routing.md).

Iterations are capped, money is not. A per-run token budget with the same
graceful-exhaustion behaviour as `reachedIterationLimit` would close the gap, and
the "conclude normally" path is already written.

### 4. Cheap-model offloading for compaction

**Buys:** large cost reduction on long runs; latency win on every condensation.
**Cost:** small — `condenser.ts` and the understanding digest are already
isolated call sites.
**Category:** [07](07-tool-use-and-model-routing.md).

Summarisation does not need a flagship model. Routing `condense` and
`understanding` to a small model is the clearest case of "routing" the project
currently lacks entirely.

### 5. Spec enforcement for the unguarded invariants — shipped

**Shipped.** `src/test/suite/shared/specInvariants.test.ts`, 8 tests: zero
runtime dependencies (including optional/peer), exactly one non-test
`generateSystemPrompt()` call site, and an `api-version` allowlist pinned to
`7.1` plus the documented comments preview. Each was checked against an
injected violation first; the dependency test also asserts `AGENTS.md` still
documents the versions, so the spec and the test cannot drift apart. Detail in
[09](09-boundaries-sandboxing-spec-driven.md).

**Buys:** converts `AGENTS.md` from advice into constraints.
**Cost:** very small — three or four tests.
**Category:** [09](09-boundaries-sandboxing-spec-driven.md).

`dependencies === {}`, exactly one caller of `generateSystemPrompt`, and GA-only
API versions. The rules that have tests hold; the ones that do not, drift. This
is the cheapest possible way to make the existing discipline stick.

### 6. Run state machine with resumable snapshots

**Buys:** resume-after-crash, deterministic multi-stage flows (implement →
verify → review → PR), diffable traces.
**Cost:** medium — ~400–600 lines, zero dependencies, in this codebase's style.
**Category:** [05](05-graph-engineering.md), [04](04-loop-engineering.md).

Worth doing when multi-stage repeatability becomes a product requirement. Note
that it upgrades *two* grades at once, and that the existing loop becomes the body
of a node unchanged — it is additive, not a rewrite.

### 7. Prompt craft: exemplars and per-provider overlays

**Buys:** fewer format-error iterations on the hard tools.
**Cost:** small, but only worth doing *after* item 1 exists to measure it.
**Category:** [01](01-prompt-engineering.md).

Worked examples for `apply_diff`, batched `edit_file` and the choice block; then
a per-provider delta layer applied after the static prefix so caching is
preserved.

### 8. In-process subagent for search-heavy subtasks — shipped

**Shipped.** `explore_codebase` runs a nested read-only loop
(`src/llm/subagent.ts`) against its own narrowed executor, with a 12-iteration
budget and a 2,500-token report. The allowlist is enforced in `gateTool`, so
the child cannot write even when it tries; the report is never empty, because
a blank result would read as "nothing found". Design and limits in
[02](02-agentic-engineering.md).

**Buys:** the one multi-agent pattern that pays off without a graph.
**Cost:** medium.
**Category:** [02](02-agentic-engineering.md).

A nested loop with a narrow tool surface that returns a summary. Valuable for
"find every place X is used across this repo" work, which currently burns main-loop
iterations on sequential searches.

### 9. Sandbox middle ground

**Buys:** protection against the one genuinely destructive action class.
**Cost:** small.
**Category:** [09](09-boundaries-sandboxing-spec-driven.md).

Wall-clock timeout per terminal command, a confirmation for destructive verbs
(`rm`, `reset --hard`, `clean -fd`), and a read denylist for secret-shaped paths.
Not a container — just the cheap 80%.

## What not to do

- **Don't add a framework.** Zero runtime dependencies is a real asset; LangGraph
  in a VS Code extension is a supply-chain and bundling problem for a benefit
  obtainable in ~500 lines of hand-rolled executor.
- **Don't grow the system prompt.** The budget test's message — *trim it, do not
  raise the budget* — is right. Every addition should displace something.
- **Don't chase graph engineering for its own sake.** Single-agent loops with
  good tools beat hand-drawn graphs of mediocre nodes. Item 6 is worth doing for
  *resume* and *repeatability*, not for the topology.
- **Don't build a benchmark before a counter.** A public benchmark measures
  general capability; a completion-rate counter measures *this product*. The
  second is cheaper, more relevant, and a prerequisite for interpreting the first.
- **Don't add retrieval before measuring the context budget.** Progressive
  disclosure plus grep-plus-range-reads is already the right shape for a local
  repository ([06](06-context-and-memory-engineering.md)); RAG would add
  infrastructure to a problem this codebase does not have.

## If only one thing gets done

**Item 1, stage 1.** One counter per turn outcome, aggregated and visible.

It is hours of work, it uses instrumentation that already exists, it makes every
subsequent decision testable, and it is the difference between a project that is
well engineered and a project that can *prove* it is getting better.

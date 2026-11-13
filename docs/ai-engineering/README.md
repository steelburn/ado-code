# AI-Engineering Maturity of ADO Code

An assessment of how ADO Code measures up against the current AI-engineering
vocabulary — prompt, agentic, harness, loop, graph, context, memory, tool-use,
routing, eval. One article per discipline, each graded, each with the file
evidence behind the grade and the specific gap that keeps it off an A.

Written against `main` @ `7562c65` (0.8.4).

## Why this exists

"Agentic" gets used as a compliment rather than a measurement. This set breaks
the word into the separate engineering disciplines it actually hides, so the
strong parts are not taken for granted and the weak parts cannot hide behind
them. It is also the honest counterweight to the README: the features list says
what the product does, these articles say how well each layer is engineered.

## Method

1. Each dimension is graded **A → F** against what the discipline demands, not
   against what the code happens to do.
2. Every grade is backed by named files and symbols, verified by reading the
   source at the commit above — not inferred from the feature list.
3. Numbers (iteration budgets, token caps, test counts) are read from the code
   or from `AGENTS.md`, and the number is cited where it matters.
4. Missing capabilities are stated as gaps only after checking they are not
   implemented under a different name. Two claims were corrected this way while
   writing: the repo *does* have file-restore checkpoints (but not run resum),
   and it *does* have one structured-output contract with a parser
   (`parseChoicePrompt.ts`).

## Scorecard

| # | Discipline | Grade | Verdict |
| --- | --- | --- | --- |
| 1 | [Prompt engineering](01-prompt-engineering.md) | **B−** | Disciplined single builder, cache-aware ordering, size as a tested contract — but prose-only, no exemplars, no per-model variants |
| 2 | [Agentic engineering](02-agentic-engineering.md) | **A−** | Correct ReAct loop with parallel batching; an in-process read-only search subagent with its own budget and a gate-enforced tool surface; still no planner/executor split and no independent critic |
| 3 | [Harness engineering](03-harness-engineering.md) | **A−** | The standout. Consent, containment, result budgeting, worktree isolation, verification, PR lifecycle, artifact retention, MCP |
| 4 | [Loop engineering](04-loop-engineering.md) | **A−** | Explicit budgets, graceful exhaustion, read-loop and repeat-loop detection, mid-run steering, condensation, self-review with bounded recovery at a halt |
| 5 | [Graph engineering](05-graph-engineering.md) | **D+** | No graph. A linear loop plus an implicit task tree; no state machine, no fan-out/fan-in, no resumable snapshots |
| 6 | [Context & memory engineering](06-context-and-memory-engineering.md) | **B+ / A−** | Hard token budgets and fingerprint-invalidated digests; memory compaction enforced at write time. No retrieval, no RAG |
| 7 | [Tool-use & model routing](07-tool-use-and-model-routing.md) | **A− / C+** | Tool surface is product-grade; routing is provider support, not routing (no cost/latency choice, no failover) |
| 8 | [Eval & observability](08-eval-and-observability.md) | **C** | 2,483 unit tests for the code, zero tests for model behaviour. No golden sets, no trace replay — a completion-rate counter was added, but nothing yet measures whether the work was right |
| 9 | [Boundaries: sandboxing & spec-driven](09-boundaries-sandboxing-spec-driven.md) | **B / B** | Worktree isolation and path confinement; the three formerly unguarded `AGENTS.md` invariants are now tests that were proven to fail, while the docs budget stays social |

**Overall: a top-decile harness wearing a mid-tier prompt, with essentially no
graph and no eval loop.**

That shape is not an accident — it reflects what the project optimises for. ADO
Code is built as a *product with an agent inside it* (work items, approvals,
remote console, PRs), not as an agent framework. Infrastructure and safety are
therefore ahead of model-craft and measurement, which is the more common and
more survivable imbalance of the two.

## Reading order

- **If you have one minute:** this page, then
  [01](01-prompt-engineering.md) and [03](03-harness-engineering.md) — the
  widest gap between weakest and strongest.
- **If you are contributing:** [03](03-harness-engineering.md) and
  [04](04-loop-engineering.md) — the invariants your change must not break.
- **If you are deciding what to build next:** [10](10-moving-the-needle.md).

## Article list

| Article | Covers |
| --- | --- |
| [01-prompt-engineering.md](01-prompt-engineering.md) | The single system-prompt builder, prefix-cache ordering, size budget, missing exemplars and per-model variants |
| [02-agentic-engineering.md](02-agentic-engineering.md) | The ReAct loop, parallel tool batches, mode gating, delegation to external CLIs, absent multi-agent patterns |
| [03-harness-engineering.md](03-harness-engineering.md) | Consent, containment, result budgeting, worktrees, verification commands, PR lifecycle, artifact retention, observability |
| [04-loop-engineering.md](04-loop-engineering.md) | Iteration budgets, graceful exhaustion, loop detection, steering, condensation, checkpointing |
| [05-graph-engineering.md](05-graph-engineering.md) | Why there is no orchestration graph, what hierarchy exists instead, what a graph would require here |
| [06-context-and-memory-engineering.md](06-context-and-memory-engineering.md) | Token budgets, progressive disclosure of understanding, condensation; user and workspace memory with write-time compaction |
| [07-tool-use-and-model-routing.md](07-tool-use-and-model-routing.md) | Tool schema design, batching, consent classes, error contract, MCP bridging; provider support vs routing |
| [08-eval-and-observability.md](08-eval-and-observability.md) | Test tiers and what they prove, the prompt-size test as a contract, the absence of LLM evals, human-facing observability |
| [09-boundaries-sandboxing-spec-driven.md](09-boundaries-sandboxing-spec-driven.md) | Path confinement, shell-operator refusal, worktree isolation, and where the sandbox ends; how much of `AGENTS.md` is mechanically enforced |
| [10-moving-the-needle.md](10-moving-the-needle.md) | Ranked roadmap: what to build, what it buys, roughly what it costs, and what not to build |

## A note on grading philosophy

Grades here are deliberately harsh in the places where "we have it" and "we do
it well" differ most, and deliberately generous where a small codebase achieves
something large ones miss. The `A−` on the harness is not politeness: most
open-source agent frameworks would fail the verification, worktree and PR parts
of that article outright. The `D+` on graph engineering is not hostility: the
discipline genuinely does not apply to a single-agent loop, and pretending a
`while` statement is a DAG would make the whole scorecard useless.

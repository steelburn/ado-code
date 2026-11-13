# 05 — Graph Engineering

**Grade: D+**

There is no graph. No node/edge executor, no agent state machine, no
fan-out/fan-in, no resumable snapshots, no conditional routing between named
steps. The control flow is a bounded `while` loop with two guards and a
wrap-up path.

## What is actually there

To be fair to the design, three *hierarchical* structures exist that are
sometimes mistaken for graphs:

1. **An explicit task tree.** `set_goal` + `update_todo_list` give the model a
   decomposition mechanism with parent/child ordering and per-item status. That
   is a tree the model reasons over — but a tree the model *writes down*, not one
   the runtime walks.
2. **Mode-scoped tool subgraphs.** `src/llm/modes.ts` restricts which tool groups
   are reachable in Chat / Plan / Act / YOLO. That is a set of allowed transitions
   in spirit, expressed as a static allow-list.
3. **Delegation as a tree of processes.** A run may spawn external agent runs,
   each with its own worktree and verification
   ([02](02-agentic-engineering.md), [03](03-harness-engineering.md)). The parent
   does not combine sibling results or branch on them — it just waits.

Note the irony: the codebase can *render* graphs (Mermaid support in the webview,
`src/webview-ui/src/utils/mermaid.ts`, with a probe), and the documentation
tooling can draw process diagrams. The project can display a graph; it does not
execute one.

## What the discipline actually asks for

Graph engineering (the LangGraph/AutoGen/CrewAI lineage) means the control flow
itself is data:

| Capability | Status here |
| --- | --- |
| Named nodes with declared inputs/outputs | absent |
| Conditional edges / routers ("if tests fail, go to fix, else to PR") | absent — the model decides implicitly each round-trip |
| Fan-out with deterministic fan-in (combine N results) | absent |
| Durable per-node state; resume from node K | absent ([04](04-loop-engineering.md): checkpoints restore *files*, not run state) |
| Cycles with bounded retries per edge | only the global iteration budget |
| Human-in-the-loop as a real graph node | approvals exist as gates, not as nodes with state |
| Visualisable/auditable execution trace | transcript only |

## Why it is D+ and not F

Because two of the prerequisites are present and unusually solid: **isolation
per branch of work** (git worktrees) and **a bounded loop with graceful
exhaustion**. Those are precisely the parts people get wrong when they *do* build
graphs — a graph executor with shared mutable state and no budget is worse than a
plain loop. The infrastructure a graph would need is largely there; the topology
is not.

The grade is also constrained by policy: `AGENTS.md` mandates zero runtime
dependencies, so the framework route is closed and a graph executor would have to
be hand-rolled.

## Why it may not matter

Worth saying plainly, since grades invite over-correction: **a single agent with
good tools and a solid loop usually beats a hand-drawn graph of mediocre nodes.**
Graphs earn their complexity when you need *repeatable, auditable* multi-stage
processes — CI-driven review pipelines, deterministic fan-out over N repos,
compliance-grade traces. ADO Code's use case (interactive coding assistance with
a human in the chair) mostly does not demand that.

The honest current framing on a CV is: **"implicit task tree, no orchestration
graph."** That is an accurate description of a deliberate design, not a hole
someone forgot to fill.

## What a graph would take here (if ever wanted)

Not a framework. A minimal explicit executor:

- `Node = { id, prompt/tool-scope, entryCondition, exitCondition }`
- edges as predicates over a small typed run state
- the existing loop becomes the body of a node, unchanged
- run state serialised next to the checkpoint store to get resume for free
- roughly 400–600 lines in this codebase's style, zero new dependencies

That buys: deterministic multi-stage workflows (implement → verify → review →
PR), resumable runs, and a trace you can diff between runs. It does *not* buy
better single-task coding, which is why it sits mid-pack in
[10](10-moving-the-needle.md) rather than at the top.

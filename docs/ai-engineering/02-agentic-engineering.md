# 02 — Agentic Engineering

**Grade: A−**

A textbook-correct ReAct loop with several refinements most implementations miss,
and a deliberate refusal to grow the multi-agent machinery the word "agentic"
usually implies. What exists is well built; what is absent is absent by design
as much as by omission.

## The loop

`src/llm/agentic.ts` implements model → tool calls → results → model until the
model stops calling tools. Two details make it better than canonical ReAct:

- **One iteration is one model round-trip, not one tool call.** A single
  iteration may execute a batch of parallel tool calls, so the budget counts
  thinking steps rather than tool volume (documented at the top of
  `src/shared/agenticLimits.ts`). This is the right unit: cost is dominated by
  round-trips.
- **Mixed batches stay parallel.** Consent-free calls do not queue behind a call
  that is waiting on an approval card, and results are re-ordered back into call
  order afterwards. A naive `Promise.all` over a batch containing one approval
  turns every read into a stall; splitting approval-gated calls out of the
  parallel group is a small, high-value refinement.

**Bookkeeping is exempt from the budget.** A round-trip that calls only ADO
Code's own `set_goal` / `update_todo_list` tools is internal to the harness and
does not consume `DEFAULT_MAX_ITERATIONS` (`CHANGELOG.md:791`). Toggling a to-do
item is not progress, and it should not bill against progress.

## Mode gating

`src/llm/modes.ts` scopes the tool surface per mode (Chat / Plan / Act / YOLO):
the tool *groups* available change, so the loop's behaviour shifts without a
second code path or a prompt fork. Plan mode is therefore **tool gating, not a
planning artifact** — the model is denied write tools; it is not asked to emit a
plan object and have an executor consume it. That distinction matters for the
grade below.

## Delegation

`delegate_to_agent` hands a task to an external CLI agent (claude, codex,
opencode, gemini, …) through `src/agents/AgentRunner.ts` and an adapter registry
(see `docs/playbooks/add-agent-adapter.md`). Each delegated run gets its own git
worktree, its own branch, a verification command, and a commit → push → PR
lifecycle.

This is **orchestration at the process boundary**: the unit of composition is a
child process with a filesystem-isolated working copy and a git-level merge
point. That is a defensible and unusually robust composition model — arguably
*safer* than in-process subagents, since runs cannot share mutable state at all.
But it is not multi-agent reasoning: the parent cannot ask a child a follow-up
question, fan out N siblings and combine their answers, or inspect intermediate
reasoning.

## The absent patterns

| Pattern | Status |
| --- | --- |
| In-process subagents | **present, narrow** — `explore_codebase` (roadmap #8) runs a nested read-only loop with its own budget and returns a capped report; one level deep, no fan-out |
| Planner / executor split | absent — Plan mode gates tools, it does not compile a plan |
| Critic / verifier agent | **partial** — two review round-trips (a reflection at a heuristic halt, a diff review before a clean finish); both ask the same model in the same context, so neither is an independent critic |
| Self-consistency (sample N, vote) | absent |
| Reflection / self-review before finishing | **present, bounded** — a reflection at a heuristic halt (roadmap #2) and a review of the turn's own diff before a clean finish (roadmap #3); at most one of each per turn |
| Hot-swap mid-run to a different model | absent |

Why A− and not higher

The single-agent core is well above average: budget semantics are correct,
parallel batching is careful, mode gating is clean and delegation is
product-grade. The review gate (roadmap #3) closes the failure this article used
to end on — a turn that finishes CLEANLY while the change is wrong — by spending
one round-trip on the diff instead of another heuristic on the trace. An in-process
read-only search subagent (`explore_codebase`, roadmap #8) now carries the
exploration a turn used to burn its own budget on.

What keeps it off an A is independence. Both reviews ask the same model, in the
same context, straight after the same conversation: a second opinion that shares
its author's blind spots is a cheaper critic, not an independent one. The search
subagent closes the old "no in-process subagent" gap, but note what it is not: a
*worker*, not a critic — the same model, the same blind spots. Adding a second
agent did not add a second opinion. There is also still no planner/executor split.

## What would move it

1. **An independent reviewer.** The review gate (roadmap #3) closed the
   wrong-but-confident hole: a clean finish now spends one round-trip on the
   turn's own diff. What remains is that the reviewer is the author — same
   model, same context, same conversation — so it sees what the author already
   believed. Routing that turn to another provider, or to a fresh context holding
   only the task and the diff, turns a self-review into a real second opinion
   without adding an agent.
2. **A plan artifact for Plan mode** — have the model emit a structured plan the
   executor then walks, so Plan mode becomes a real pattern instead of a
   restricted tool set.
3. ~~**Opt-in in-process subagent**~~ — **shipped** as `explore_codebase` (roadmap #8): a nested loop with
   a narrow tool surface and a returned report — the one multi-agent pattern
   that pays for itself without a graph.

---

## Update — the in-process subagent shipped (roadmap #8)

The gap this article named ("no in-process subagents; delegation is process
boundary only") is closed from the other side. `explore_codebase` runs a nested
agentic loop for search-heavy questions, and three details are what make it
safe rather than merely present:

1. **The narrow surface is enforced, not advertised.** The child gets its own
   executor built with `allowedTools` (six read tools), and the allowlist is
   checked in `gateTool` — the first rule, ahead of mode gating — so a model
   that calls `edit_file` inside the child gets an error, never an edit. A
   read-only child that can be talked into writing is worse than no child.
2. **The budget is its own.** 12 iterations, separate from the parent's 100, so
   a runaway search cannot consume the turn that needs the result.
3. **The hand-off cannot be empty.** Budget exhaustion, a provider error or an
   empty answer all degrade into an explicit statement, because a blank tool
   result reads to the parent as "nothing found" — a much stronger and usually
   wrong claim than "the subagent did not finish".

What it deliberately is **not**: orchestration. There is no fan-out, no
parent/child graph, no shared memory between siblings, and no second level of
nesting. One question in, one report out. That is the multi-agent pattern that
pays for itself without a graph — which is why [05](05-graph-engineering.md)
does not move: a nest is not a topology.

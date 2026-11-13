# 08 — Eval & Observability

**Grade: C**

The weakest discipline in the project, and the one that caps several others.
There is excellent testing *of the code* and essentially no evaluation *of the
model behaviour* — and the model behaviour is what the product is.

## What exists, and it is not nothing

### A real test suite

- **141 test files / 2,483 `test()` calls** in `src/` at the time of writing.
- Four tiers: `npm test` (full), `npm run test:changed` (changed files only),
  `npm run test:host` (Electron host tests), `npm run test:unit` (mocha with
  `scripts/vscode-stub.js`, so unit tests run without VS Code).
- The stub-based unit tier is the important structural win: it means the services
  — context manager, condenser, prompt builder, understanding, changelog, ADO
  client — are testable in milliseconds without booting an editor. A project that
  can only test through the editor ends up testing nothing.

### One test that is genuinely LLM-shaped

`src/test/suite/llm/prompts.test.ts` asserts the system prompt's size budget
(`STATIC_BUDGET = 7200`) with a failure message that tells you to trim the prompt
rather than raise the budget, and asserts the prompt carries the documentation
budget policy. Those are assertions about *what the model will be told*, not
about a function's return value — the closest thing here to an LLM contract test,
and the reason [01](01-prompt-engineering.md) can be graded on enforcement rather
than intention.

### CI discipline where it exists

The only workflow is `version-check.yml`, and it is written by someone who
understands gates: no `paths:` filter (a path-filtered required check never
reports, so PRs wait forever), zero-dependency script so it fails in seconds, and
— crucially — **a self-test that deliberately drifts the constant and asserts the
gate exits exactly `1`**, because *"a gate that always exits 0 is worse than no
gate — it looks like coverage."*

That sentence is the right philosophy. It is also, precisely, what the rest of
the evaluation story lacks: a way to tell a passing grade from an unmeasured one.

## What is missing

- **CI runs no tests.** The single gate is `check:version`. The test suite is run
  locally (and via the pre-commit path) but a PR can be merged with the suite
  red; nothing server-side notices.
- **No golden sets.** No prompt → expected tool sequence fixtures. The suite
  proves `capToolResult` slices at 4,000 tokens; it does not prove that a given
  request produces a sensible sequence of tool calls.
- **No trace capture as data.** Transcripts are stored as session files (good)
  but are not turned into regression cases. Every real failure that a user
  reports is currently diagnosed once and then lost.
- **Completion is now counted — quality still is not.** `src/services/metrics/`
  aggregates the signals the loop already emits (iteration limit, loop halt, tool
  errors, truncation markers, read-synthesis nudges, mid-run steering) into
  `.ado-code/metrics/turn-outcomes.json`, rendered by **ADO Code: Show Turn
  Outcome Counters**. That answers "did the turn finish, and what had to be
  corrected along the way?" — a real feedback loop, added after this assessment
  was first written. It still says nothing about whether the work was *right*,
  which is why the grade below does not move.
- **No model-change regression check.** Swapping the model, or trimming the
  system prompt by 600 chars, has no observable quality consequence until users
  complain.
- **No ablations.** Nothing answers "does the memory block earn its tokens?" or
  "does the to-do list improve outcomes?" with evidence.

## Observability: good for humans, absent for metrics

What exists is **human-facing**, and it is good: a status panel, transient status
rows, run cards in chat, a remote console ([03](03-harness-engineering.md)), a
context-cost report for generated artifacts, and a documented post-run impact
check that produces a report when an agent's changes are merged.

What did not exist was **machine-facing** observability. The first piece landed
with the outcome counters: every finished turn folds `{outcome, mode, signals}`
into `.ado-code/metrics/turn-outcomes.json`, reported as a completion rate, a
per-100-turns signal rate and a last-50-turns window. Still missing: per-turn
token accounting over time, a tool-failure histogram by tool, duration per phase,
and a durable link from a counted turn back to the transcript that produced it.

The distinction matters because the difference between "we log it" and "we
measure it" is one aggregation step, and that one step is what would make prompt
changes falsifiable.

## Why C and not lower

Because the engineering culture clearly *values* verification — the prompt budget
test, the self-testing gate, four test tiers, the stub tier, the explicit
"commit only when compile and test are green" rule in `AGENTS.md`. This is a
project that would very likely build an eval harness well. It just has not, and
the gap is structural rather than cultural: there is no feedback loop on model
behaviour at all.

## Why C and not higher

Because the one thing that most needs measuring is not measured. Tests cover the
harness around the model comprehensively; the model's actual behaviour — the
product — has zero automated quality signal.

## What would move it

This is the highest-leverage work in the repository
([10](10-moving-the-needle.md)), and it is unusually cheap here because of the
single-builder prompt ([01](01-prompt-engineering.md)):

1. **Record** `{task prompt, tool sequence, terminal status, iteration count}` for
   real runs — the data already exists in session files.
2. **Assert** a small golden set of tool-sequence expectations (shape, not exact
   text: "reads before editing", "runs tests after editing", "does not re-read the
   same file 4×").
3. **Replay** in CI on prompt changes only, so the cost is bounded.
4. **Aggregate** the signals already emitted into a completion rate — **done**:
   `src/services/metrics/turnOutcome.ts` (counting rules), `TurnOutcomeStore.ts`
   (persistence) and the `adoCode.showRunOutcomes` command. This is the cheap half;
   steps 1–3 (record, assert, replay) are what turn "did it finish?" into "was it
   right?"

Step 4 is done, and it has already earned its keep: the loop heuristics it
counts (iteration limit, repeat-loop halt, read-synthesis nudge, blocked repeat)
are now measured mechanisms rather than untested guesses — and the counters were
cheap because the loop already knew every one of them. Roadmap #2 added one
entry in the same spirit: `reflectionTurns` counts self-reviews, so the
question "does reflection recover more turns than it costs?" is answerable from
the same report rather than by opinion.

## What the counters now see (roadmaps #1–#3)

Every signal in `src/shared/turnSignals.ts` lands in
`.ado-code/metrics/turn-outcomes.json` and in the report behind
`adoCode.showRunOutcomes`:

- eight loop-health counters — `iterations`, `toolCalls`, `toolResults`,
  `toolErrors`, `truncatedResults`, `loopBlocks`, `readSynthesisNudges`,
  `steeringMessages`;
- `reflectionTurns` — self-reviews spent at a halt (roadmap #2);
- `reviewTurns` / `reviewRevisions` — diff reviews run, and gates that demanded a
  fix (roadmap #3).

`reviewRevisions` is the closest thing here to a caught-defect rate: it counts
turns that would have been reported as finished while the change was wrong. It is
a proxy, not a golden set — a right review of a right change still reads zero —
but it moves when the loop's judgement improves, which is the property this
article says the repo lacks.

None of this changes the grade: the counters judge COMPLETION, and a revision is
still the reviewer's opinion rather than a fixture's assertion.
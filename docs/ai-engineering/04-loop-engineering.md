# 04 — Loop Engineering

**Grade: A−**

The agentic loop is *engineered* rather than merely written: it has explicit
budgets, defined exhaustion behaviour, named failure heuristics, mid-run
intervention and context condensation. Almost every failure mode of a naive
`while` loop has a corresponding mechanism here.

## Budgets with correct semantics

| Constant | Value | Meaning |
| --- | --- | --- |
| `DEFAULT_MAX_ITERATIONS` | 100 | Agentic iterations (model round-trips) per chat turn |
| `MAX_INTERNAL_ITERATIONS` | 50 | Internal round-trips that may not consume the user-facing budget |

Both live in `src/shared/agenticLimits.ts` as the **single source of truth**, and
the `adoCode.act.toolBudget` setting default is derived from the constant rather
than duplicating the number (`src/config/settings.ts:99`). One number, one place
— so a change to the budget cannot leave the documented default lying.

The unit is the round-trip, not the tool call, and calls that only touch ADO
Code's own bookkeeping tools (`set_goal`, `update_todo_list`) are exempt
(`CHANGELOG.md:791`). Both choices make the budget mean "steps of thinking"
instead of "arbitrary counter that a batching change will silently multiply".

## Exhaustion is graceful, not an error

Hitting the budget does not throw and does not drop the work. The loop ends with
a normal concluding assistant reply tagged `reachedIterationLimit`
(`src/llm/agentic.ts`), so the user gets a summary of what was accomplished and
what remains. A turn that runs out of steps is a *partial result*, not a crash.

This is the single most-copied-able idea in the project. Most agents either loop
forever or die with a stack trace at the limit; both leave the user with nothing.

## Named failure heuristics

The loop detects two distinct pathologies and treats them differently:

1. **Read-loop** — `consecutiveReadIterations >= readSynthesisThreshold`
   (`src/llm/agentic.ts:390`): the model keeps reading and never acts. The
   remedy is instruction, not termination: a `wrapUpInstruction` telling it to
   synthesise what it already has and stop reading.
2. **Repetitive tool loop** — the same call pattern repeating. This one halts
   execution and says so plainly: *"A repetitive tool loop was detected, so I
   stopped execution to prevent wasting steps. Reply to continue with different
   instructions."* (`src/webview/ChatViewProvider.ts:6133`).

Grading these apart matters: reading too much is a *strategy* problem that a
nudge can fix; repeating an identical call is a *stuck* problem that only a
human can unstick. Terminating with an actionable message beats a silent retry.

## Reflection at the halt (roadmap #2)

The repeat-loop halt used to be terminal, which is why the message handed the
problem back to the human. Both heuristics observe the *shape* of a failure —
identical calls, too many round-trips — and neither knows its *cause*. So the
loop now spends one round-trip finding out, in `src/llm/reflection.ts`:

- A **digest**, not a transcript. `formatDigest()` renders the facts the loop
  already holds — iterations against the budget, per-tool call counts with
  failures, files touched, blocked repeats, the read-only streak, queued
  steering — as a handful of lines. Restating history would cost the tokens the
  decision needs.
- A **decision**, not prose. The model must end with `VERDICT:` / `GAP:` /
  `NEXT:`. `parseReflectionVerdict()` is deliberately tolerant (fenced, bolded,
  bulleted, or inferred from prose) because a malformed answer degrades to
  `unknown`, which is exactly the old behaviour — the reflection can never make
  the loop worse.
- An **asymmetry**: `continue` is honoured only with a `NEXT:` step that names a
  different action (`isActionableContinue`). A plan-less `continue` would resume
  with the same strategy and re-trip the same heuristic, so it is treated as a
  wrap-up.

## Review gate before a clean finish (roadmap #3)

Roadmap #2 handles a turn the loop gives up on. Roadmap #3 handles a turn the
MODEL decides to end — the failure the loop could never see, because the trace
looks perfect and only the artefact is wrong: a half-applied edit, a stub left
behind, a caller that was never updated, a claim the diff does not contain.

- **Where it fires.** On the exit handler for a tool-call-free reply, and only
  when that turn actually mutated files (`edit_file`, `write_to_file`,
  `apply_diff`, `delete_file` record the touched paths). `reviewUsed` makes it
  once-per-turn; a read-only turn pays nothing.
- **What it reviews.** The diff, not the transcript. `reviewDiff` is injected by
  the host (`ChatViewProvider` → `src/services/review/turnDiff.ts`), so the loop
  stays free of git and vscode while the review still sees real file state. The
  diff is scoped to the turn's own paths — foreign uncommitted work is never
  blamed on the model — and cut at 12,000 chars, 60/40 head and tail, with a
  visible marker.
- **What it costs.** Exactly one round-trip, with NO tools
  (`chatWithTools(..., [])`): the review decides, the resumed turn acts. That
  required the providers to omit `tools` rather than send `tools: []`, which
  both APIs reject.
- **What it can change.** Only an actionable `revise`: a defect AND a `NEXT:`
  step. The loop then resumes with `REVIEW_BONUS_ITERATIONS` (6) added to the
  budget, and the rejected reply is re-emitted with `final: false` so the user
  never sees it as the answer. `ship`, `unknown`, an empty diff, an abort, a
  provider error and a throwing `reviewDiff` all fall through to the ordinary
  finish.
- **Why the bonus is additive.** `reviewBonus` and `reflectionBonus` are separate
  budgets, so each gate can extend a turn by its own bounded amount and neither
  can push a turn past a limit the user set — both only fire on a turn that has
  NOT exhausted it.
- **The limitation worth stating.** The reviewer is the author. It catches a
  change that is incomplete, not a design that is wrong and plausible.
  Independence is roadmap item 1 in [02](02-agentic-engineering.md).

An honoured `continue` grants **four** extra iterations —
`REFLECTION_BONUS_ITERATIONS`, added to the loop condition rather than mutating
`maxIterations`, so the user's number stays intact. Crucially the bonus exists
**only** on the heuristic path: when the iteration budget itself is exhausted,
no reflection runs at all. The heuristic halt is a guess that may be wrong; the
budget is a decision the user made.

The cost is one round-trip, at most once per turn, on turns that were about to
die anyway — and it is counted, as `reflectionTurns`, in the outcome counters
from [08](08-eval-and-observability.md), so whether reflection recovers more
turns than it costs is a question the report can answer.

## Steering and interruption

The loop accepts **queued/steering messages** — you can inject guidance while
tools are executing instead of waiting for the turn to finish — and an abort
signal is threaded through the run so cancellation is responsive rather than
deferred to the next round-trip. Steering is handled by the busy-state model
described in the workspace's `chat-loading-channel` note: one derived `isBusy`
flag gates the send/stop button, the working row and queue routing, so a
`loading:false` from an unrelated background refresh cannot pretend the loop is
idle.

That is loop engineering in a subtle form: the *UI's* idea of whether the loop is
running has to be as carefully derived as the loop's own state, or the user loses
the ability to steer at the moment they most need it.

## Context condensation inside the loop

The loop does not simply accumulate until the window fills:

- `src/llm/context/contextManager.ts` (`ContextManager`) manages the message
  window with a priority order — system prompt, recent turns, tool results, old
  turns — so eviction removes the cheapest content first.
- `src/llm/context/condenser.ts` condenses older history into a summary rather
  than dropping it wholesale.
- `src/llm/context/tokenCounter.ts` provides the token accounting that makes any
  of this possible, and `capToolResult` caps individual results at 4,000 tokens
  ([03](03-harness-engineering.md)).

Condensation plus per-result capping plus window management is the difference
between a loop that survives a 40-step refactor and one that dies at step 12.

## Checkpointing — a real but narrower capability

`CheckpointService` and the `restore_checkpoint` tool restore **workspace files**
to a saved checkpoint (keyed by task and checkpoint id). That is file-level undo
for agent edits, and it is a genuinely useful safety net.

It is **not** run checkpointing: there is no serialised agent-run state, so a
half-finished loop cannot be resumed — after a crash or a closed window, the turn
is gone and the work must be redone from the transcript. The two things are
often conflated; the distinction is the main gap in this article.

## Other gaps

- **No per-run cost or wall-clock ceiling.** Iterations are counted; tokens and
  money are not. A 100-iteration turn on an expensive model can spend far more
  than the user expects, with no brake between "fine" and "done".
- **No adaptive budget.** A one-line fix and a repo-wide refactor get the same
  100 iterations. The reflection bonus is the only place a run can argue for
  more steps, and it fires on a halt rather than at the start — so the budget is
  still blind to what the task will cost until the run is already in trouble.
- **No multi-turn run memory.** Each chat turn starts the loop fresh; nothing
  carries a partial plan forward except the transcript itself.

## Why A−

Because every mechanism that exists is correct, documented where it lives, and
derived from a single source of truth — and because graceful exhaustion plus
distinct loop heuristics are things most production agents still lack. It stops
short of an A on the missing resume, cost ceiling and adaptive budget: the loop
is well-controlled but not yet *governed* in the economic sense.

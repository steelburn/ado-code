# 01 — Prompt Engineering

**Grade: B−**

Strong discipline about *where* the prompt is built and *how big* it is; weak
craft inside it. The project treats the prompt as infrastructure and as a
contract, but not yet as something to tune against measured model behaviour.

## What is genuinely engineered

### One builder, no exceptions

`generateSystemPrompt()` in `src/llm/prompts/system.ts` is the only place the
system prompt is assembled. `AGENTS.md` states this as a hard constraint ("Never
add a second injection point"), and it is the single most valuable prompt
decision in the repository.

Why it matters more than it sounds: the most common way prompt quality rots is
not a bad sentence — it is a *second* place that also injects instructions,
which then drifts out of sync and starts contradicting the first. One builder
makes the prompt diffable, testable, cacheable and A/B-able. Everything else
below is only possible because of this.

### Ordered for prefix caching

The builder is layered so the cacheable part comes first and the volatile part
last:

1. static sections (role, tool discipline, conventions) — identical every turn
2. per-turn sections (to-do list, skills, user/workspace memory, repository
   understanding, custom instructions)

Provider prefix caching is a greedy match from the first token. Putting the
to-do list in the middle, or the current time near the top, silently destroys
the cache hit rate for the entire conversation. The ordering here is correct,
and the 0.8.4 commit — "chore(release): fold Unreleased into 0.8.4; smaller
cacheable system prompt" — shows the layering is actively maintained rather
than accidentally correct.

### Prompt size as a tested contract

`src/test/suite/llm/prompts.test.ts:346` sets `STATIC_BUDGET = 7200` and fails
the build when the static prompt exceeds it, with a failure message that says
to trim the prompt rather than raise the budget. That is the important part:
the budget has a *direction of pressure*. Prompts grow monotonically by default;
a failing test with "trim it, do not raise the budget" is the only reliable
brake.

The per-turn blocks are budgeted too, per part: repository 4,500 / work item
2,500 / knowledge 1,500 chars, 8,000 total (`AGENTS.md`), enforced in
`src/services/understanding.ts` with a visible truncation marker
(`tests:192`: "…(truncated to keep the prompt within budget").

### One structured-output contract, with a parser

`src/llm/parseChoicePrompt.ts` parses the fenced `choice` block back out of
model output, so the "offer the user options" convention is a real
request/response contract with code on both sides rather than a hopeful
instruction. Tool arguments are likewise schema-declared per tool
(`src/llm/tools/types.ts`).

### Honest about capability

`src/llm/prompts/system.ts:341` returns `''` when a capability is disabled, so
the prompt never advertises a tool that does not exist that turn. Capabilities
that vanish produce fewer hallucinated calls than capabilities that are merely
discouraged.

## What is missing

- **Prose-only steering.** All behavioural control is English text in one
  template. There are no per-model prompt variants: Claude, GPT and Gemini get
  byte-identical instructions even though they respond differently to the same
  imperative wording. `src/llm/modelCapabilities.ts` knows per-model *context
  windows* but carries no per-model *prompt*.
- **No few-shot exemplars** for the tools where format errors are expensive —
  `apply_diff`, batched `edit_file`, and the choice block are all
  format-sensitive and all taught by prose alone. One compact worked example per
  hard tool would likely pay for its tokens several times over in saved
  iterations.
- **Prose contracts are not validated on the way back.** The choice block has a
  parser (good), but it is best-effort: there is no schema validation, no retry
  on malformed output, and no test asserting the model round-trips the contract.
- **Review is late and conditional.** There is no self-review before a
  *successful* finish. The only critic pass in the system is the reflection turn
  roadmap #2 put at a loop halt ([04](04-loop-engineering.md)), so bad work that
  never trips a heuristic still reaches the user unreviewed — and the reflection
  that does run reviews a digest of counts, not the diff.
- **No measured prompt hygiene.** Nothing enforces "no negative instructions",
  "no duplicated rules", "no instructions the tools already encode" — the size
  budget is a proxy for these, not a substitute.

## Why B− and not higher

The engineering *around* the prompt (single builder, cache ordering, tested
budget) is A-grade practice and is the reason the grade is not lower. But the
discipline of prompt engineering proper — exemplars, model-specific wording,
validated output contracts, iterative tuning against eval results — is
essentially absent, and the last of those is blocked by there being no eval
harness at all ([08](08-eval-and-observability.md)).

The grade is also capped by a structural point: a prompt can only be improved
against a measurement, and there is none. Prompt engineering here is currently
maintained by care, not by feedback.

## What would move it

1. **An eval harness first** ([08](08-eval-and-observability.md)) — without it,
   prompt changes are unfalsifiable.
2. **Per-provider prompt overlays** — a small delta layer applied after the
   static sections, so the cacheable prefix stays identical while the wording
   that matters for each provider varies.
3. **Worked exemplars** for `apply_diff`, `edit_file` batching, and the choice
   block.
4. **Validate-then-repair** for the parsed contracts: on malformed output, one
   repair round-trip with the parse error quoted back.

See [10 — moving the needle](10-moving-the-needle.md) for how these rank
against the other gaps.

# 06 — Context & Memory Engineering

**Grades: context B+ / memory A−**

Two related but separate disciplines. Context engineering decides what goes into
the window each turn; memory engineering decides what survives across turns and
sessions. ADO Code is strong on budgets and invalidation in both, and has no
retrieval in either.

## Context: budgets everywhere, retrieval nowhere

### Hard numbers, enforced

- **Static system prompt:** 7,200 chars, tested (`STATIC_BUDGET` in
  `src/test/suite/llm/prompts.test.ts:346`).
- **Repository understanding:** 4,500 chars; **work item:** 2,500;
  **knowledge:** 1,500; **8,000 total**, with a visible truncation marker
  (`src/services/understanding.ts`; `AGENTS.md`).
- **Tool results:** 4,000 tokens, 60/40 head-tail
  (`TOOL_RESULT_TOKEN_BUDGET`, `src/llm/tools.ts:29`).
- **Grep matches:** per-line truncation at 500 chars, capped match count.
- **Memory entries:** per-entry char budget enforced at write time (see below).

Budgets alone are unremarkable. What is notable is that each is *tested* or
*enforced in code* rather than documented as an aspiration, and that the
truncation is **visible to the model** — a truncation marker tells it that
information was cut, so it can go get the rest instead of reasoning from a
silently incomplete block.

### Progressive disclosure instead of retrieval

The Repository Understanding cache is a **digest plus full text**: a short
scannable digest (sections list, size, an LLM summary) with an instruction to
read a line range rather than the whole file. The cached digest in the prompt
ends with *"read a line range rather than the whole file"* — i.e. the context
block is an *index*, and the agent fetches detail on demand via `read_file`
ranges and `search_files`.

This is the correct architecture for the constraint. Full RAG (embeddings, a
vector store, a chunker) is off the table under zero-runtime-dependencies and
would usually be worse for a single repository the user already has on disk:
grep plus range reads is a stronger retriever than a chunk index for code.

So the honest statement is: **no RAG, but genuine progressive disclosure** — a
two-tier context model where the cheap tier is always present and the expensive
tier is pull-based. That earns B+, not C.

### Invalidation by fingerprint, not TTL

The understanding cache is invalidated by a **repository fingerprint** (branch,
HEAD, and content signals) rather than by a timer. Time-based caches are either
stale (long TTL) or wasteful (short TTL); content-based invalidation is correct
here because the only thing that matters is whether the repo changed.

### Condensation

`ContextManager` + `condenser.ts` + `tokenCounter.ts`
([04](04-loop-engineering.md)) manage the evolving window: evict in priority
order (system → recent turns → tool results → old turns), condense rather than
drop, cap individual results.

### The gap

Prioritisation is **static and positional**. There is no relevance scoring, no
"this file was edited 3 turns ago so keep it", no per-file context pinning by the
user, and no ability for the model to request retention of a specific block. A
long refactor across 6 files will evict the earliest file's content even though
it is the one still being edited.

## Memory: compaction enforced at write time

Two scopes — **user memory** (persists across sessions and workspaces) and
**workspace memory** (per repository, under `.ado-code/memory/`) — each with
categorised entries (preference / instruction / correction / context) and a
key-valued read/write/list API.

The design detail that makes it A-grade rather than merely present:

- **Oversized entries are rejected, not truncated.** An entry over the char
  budget (`adoCode.memory.maxCharsPerEntry`, default 400) fails on write with an
  instruction to shorten it or split it. This is *compaction pressure applied at
  the moment of authorship*, and it is why the memory store does not rot into a
  pile of 3,000-character essays that consume the entire per-turn memory budget.
- **Memory is injected per-turn, after the static prompt**, so it never
  invalidates the cacheable prefix ([01](01-prompt-engineering.md)).
- **The store is inspectable and portable** — plain files under `.ado-code/`,
  readable and editable by the user, with an export path.
- **Deduplication is enforced at the tool boundary:** a comment or memory entry
  identical to what is already there is silently dropped, which prevents the
  "remind the model of the same fact every turn" failure mode.

The visible consequence in practice is a store that stays short, sharp and
actually used by the model — several entries in this workspace's memory are
operational gotchas (CRLF editing, hook collisions) that demonstrably change
behaviour turn to turn.

### Withdrawal and recency

An append-only store rots in two ways: a fact the user has since contradicted
cannot be withdrawn, and the budget evicts by insertion order rather than by
anything meaningful. Both are closed.

- **`delete_memory(key, scope?)`** removes an entry from either scope. The only
  repair path used to be overwriting a key, so a stale instruction survived
  until its key happened to be reused.
- **The digests are recency-ordered.** User memory sorts by `timestamp`
  descending (an update moves the entry to the front); workspace memory sorts by
  file mtime descending, with a key tiebreak for same-millisecond writes.
  `renderMemoryBlock` keeps the head of the list, so the budget now drops the
  *oldest* entries instead of the newest.
- **The `memory` group is advertised.** Every mode lists it in `modes.ts`, so the
  memory tools appear in the prompt's tool section, and a `memory` guidelines
  block states when a fact deserves an entry, that the key is the entry's
  identity, and that user vs workspace is a real distinction.

### The gap

- **Relevance is by recency, not by task.** All entries in scope go into the
  prompt until the budget is hit; recency decides what survives, but nothing
  scores an entry against the current task, so a large store degrades into
  noise.
- **No decay or reinforcement.** A memory that has never mattered is exactly as
  prominent as one that matters daily.
- **No conflict detection.** Two memories can contradict each other — including
  one per scope — and both get injected; user scope wins only by being rendered
  first.
- **No automatic extraction.** Persisting a fact is a model decision each time;
  there is no post-turn pass that proposes "this looked worth remembering".

## Why the two grades differ

Context engineering is excellent at the *mechanical* half (budgets, truncation
markers, condensation, invalidation) and absent at the *semantic* half
(relevance, pinning, per-task selection) — B+.

Memory engineering is genuinely inventive: write-time rejection with a split
instruction is a stronger control than most memory systems apply anywhere, and it
solves the maintenance problem that usually kills these stores. Withdrawal and
recency ordering are now in place, so it loses the A only on task-relevance
selection, cross-scope conflict handling and decay — which matter more as a
store grows — A−.

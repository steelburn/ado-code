# 03 — Harness Engineering

**Grade: A−** — the strongest layer in the project

The harness is everything that surrounds the model: what it may do, how much it
may bring back, where its side effects land, how its work is verified and how a
human watches it. ADO Code's harness is product-grade, and in several respects
better than the open-source agent frameworks it competes with conceptually.

## Consent and human-in-the-loop

`src/llm/consent.ts`, `confirmation.ts` and `tool-approval-ui.ts` implement a
consent model per tool class rather than a blanket "allow everything?" prompt.
Calls that need approval surface as cards; calls that do not, run. The
distinction is used by the loop itself, which is why consent-free calls in a
mixed batch run in parallel instead of stalling behind the approval card
([02](02-agentic-engineering.md)).

Approvals are also answerable **remotely** — the remote console in
`docs/remote.md` mirrors a run to a phone-sized UI over a tokenised URL, so a
long delegated run does not need someone sitting at the machine. That is a rare
capability and it is a harness feature, not a UI feature: it removes the human
from the critical path without removing the gate.

## Containment

- **Path confinement.** All file tools are confined to the workspace; paths are
  workspace-relative and escape is refused. Documented as a convention in
  `AGENTS.md` and enforced in the path resolution layer.
- **No shell-string interpolation.** `run_terminal_command` accepts a command
  plus an optional `commands` array, and each entry is checked for shell
  operators (the tool schema states this explicitly). `&&`, `|`, `>` chaining is
  refused rather than parsed, which removes the entire class of injection that
  afflicts agents that hand strings to `sh -c`.
- **Worktree isolation.** `AgentRunner` creates a git worktree per delegated run
  and points the run's working directory at it, so parallel runs cannot stomp
  each other's edits and the main checkout is never touched by an agent.

That last one is the most important: **concurrency safety is achieved by giving
each run its own copy of the repository**, not by locking. Locks serialise;
worktrees parallelise.

## Context and result budgeting

- `capToolResult()` in `src/llm/tools.ts` trims tool payloads to
  `TOOL_RESULT_TOKEN_BUDGET = 4000` tokens with a `0.6` head ratio — head and
  tail retained, middle elided, so both the beginning (what the file is) and the
  end (the error, the summary) survive.
- Oversized results keep head (500 chars) and tail (150 chars)
  (`src/llm/agentic.ts:199`), and `search_files` truncates every matched line at
  500 chars with a capped match count.

Result budgeting is the single highest-leverage harness feature for long runs:
one careless `read_file` of a minified bundle can otherwise consume an entire
context window and abort the turn.

## Verification and the PR lifecycle

Delegated runs are not trusted on their own say-so:

- A **verification command** is configured per project and run with a timeout
  (`AgentRunner`), with a sensible default discovered from the project's
  package scripts.
- `commit_worktree` refuses to commit a run whose verification **FAILED** unless
  `allowFailed` is passed deliberately (`src/webview/ChatViewProvider.ts:1074`;
  `CHANGELOG.md:1117`). The escape hatch exists but is opt-in and explicit —
  the right shape for a safety default.
- The full lifecycle is a tool sequence: `commit_worktree` → `push_worktree` →
  `create_pull_request`, with `resolve_pr_conflicts` listing conflicted files
  (base/ours/theirs) read-only so the model resolves them via normal edits in
  the worktree and re-pushes.

The consequence is that an agent run terminates in a reviewable artifact — a
branch and a PR — rather than in a mutated working directory. `push_worktree`
never force-pushes and never pushes `main`/`master`; `create_pull_request`
refuses protected branches. Those are hard refusals at the tool boundary, which
is where they belong.

## Housekeeping

- **Artifact retention.** `.ado-code/` accumulates sessions, checkpoints and
  scratch data; a collector sweeps it on a schedule with
  `adoCode.artifacts.enabled` / `retentionDays` settings, and reports the
  **context cost** of what the agent has generated (`CHANGELOG.md:680-685`).
  Telling the user what their artifacts are *costing* is an idea most tools skip
  entirely.
- **MCP bridging.** `src/services/mcp/McpClient.ts` performs the real
  `initialize` → `tools/list` handshake, so external MCP servers join the tool
  surface; there is a mock server for tests and a playbook
  (`docs/playbooks/add-mcp-server.md`).
- **Observability.** A status panel, transient status rows, run cards in chat,
  and the remote console. A run is inspectable while it is happening, not only
  in the transcript afterwards.

## What keeps it off an A

- **No OS-level sandbox.** No container, no syscall filtering, no resource caps
  (CPU, memory, disk, wall-clock per tool). A runaway `npm install` or a
  recursive delete inside the workspace is contained by *policy*, not by the
  operating system.
- **No network policy.** Terminal commands and MCP servers can reach anything
  the host can.
- **No per-run cost ceiling.** Token spend is budgeted per tool *result*, not
  per *run*; a long run can be expensive without ever tripping a limit.
- **The consent model is coarse.** Approve-once-per-tool is the granularity;
  there is no per-argument inspection (e.g. "this `rm` targets a path outside
  `src/`").

For a client-side VS Code extension, most of these are reasonable boundaries —
you cannot meaningfully sandbox a process that must run the user's own build. The
grade reflects that judgement, and the missing items are stated so the boundary
is a decision rather than an oversight.

## Why A−

Because the parts that *can* be built in-process are built well and built
together: budgeted results, isolated worktrees, a verification gate that fails
closed, a PR-shaped exit, and a human gate that works from a phone. Each of these
is independently easy to skip, and most agents skip all five.

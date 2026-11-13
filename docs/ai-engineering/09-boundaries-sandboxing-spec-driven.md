# 09 — Boundaries: Sandboxing & Spec-Driven Development

**Grades: sandboxing B / spec-driven B**

Two disciplines that decide whether an agent's competence is *safe* and
*reproducible*. Both are taken seriously here; neither is complete, and in both
cases the missing part is the mechanical half rather than the cultural one.

## Sandboxing — B

### What is actually contained

| Boundary | Mechanism |
| --- | --- |
| Filesystem | Path confinement to the workspace root; escapes refused |
| Shell | `run_terminal_command` refuses shell operators (`&&`, `\|`, `>`, `;`) instead of handing a string to a shell — no interpolation to inject into |
| Concurrency | One git worktree per delegated run; the main checkout is never mutated by an agent |
| Destructive git | `push_worktree` never force-pushes and never pushes `main`/`master`; `create_pull_request` refuses protected branches |
| Unverified work | `commit_worktree` refuses a verification-FAILED run unless `allowFailed` is passed deliberately |
| Search scope | `src/llm/tools.ts:1198` excludes `.git`, `node_modules`, `dist` and common secret directories from search |
| Credentials | Provider API keys live in VS Code **SecretStorage** (`context.secrets`), not in files the file tools can read |
| Human gate | Per-class consent, answerable locally or remotely |

That last-but-one row is worth pausing on: keeping credentials out of the
workspace means the most valuable secret available to this kind of tool is not
on the filesystem the agent can browse. It is a cheap architectural decision with
a large effect on the blast radius.

### Where the sandbox ends

- **Not an OS sandbox.** No container, no seccomp/AppContainer, no process
  isolation. `run_terminal_command` runs with the extension host's full
  privileges. Containment is by *argument* (no shell operators) and by *policy*
  (consent), not by *capability*.
- **No resource limits.** No CPU, memory, disk or wall-clock cap per command; a
  long build is a long build.
- **No network policy.** Terminal commands, MCP servers and provider calls can
  reach anything the host can.
- **No recursive-delete guard.** A `rm -rf` on an in-workspace path is a valid
  argument; the worktree protects the main checkout for delegated runs, but an
  interactive Act/YOLO session operates on the real working tree. Checkpoints
  ([04](04-loop-engineering.md)) are the recovery path, and they restore files
  rather than the whole tree.
- **Denylist only covers search.** A direct `read_file` of an in-workspace secret
  file (a `.env`, a local credentials file) is not blocked by policy.

### Why B

For a client-side editor extension these are mostly the *right* boundaries: you
cannot sandbox a process whose entire job is to run the user's own build, and
adding a container would make the product unusable for most users. What is
missing is the cheap middle ground — a wall-clock timeout per command, a
confirmation for destructive verbs, a path denylist on reads. Given that consent
and worktree isolation are already in place, B is a fair reflection of a boundary
that was drawn deliberately and documented honestly, rather than an oversight.

## Spec-driven development — B

### What exists

- **`AGENTS.md` as a real contract.** It is not a README: it states invariants
  (single prompt builder, no second injection point, zero runtime dependencies,
  workspace-relative paths, `{ error }` not throws, GA API versions only, docs
  budget, prompt budgets) and it is read by the agent at the start of work.
- **Budgets as specifications.** 7,200 chars of static prompt, 4,500/2,500/1,500
  of understanding, 400 chars per memory entry — each is a documented number with
  a test or a write-time rejection behind it.
- **Acceptance criteria flow into work items.** Work items carry description and
  acceptance criteria which are injected into the run context; the harness's
  `create_work_item` takes AC as a first-class field rather than burying it in
  prose.
- **Documentation budget.** "Extend an existing document; never a `.md` per step
  or per turn" — a written rule against the failure mode of agents that leave a
  trail of speculative markdown. This folder exists because documentation was
  explicitly requested, which is the rule working as intended.
- **Release discipline.** The version number lives in two places and drifted
  once, so it is now guarded by a self-testing CI check
  ([08](08-eval-and-observability.md)) — a spec violation converted into a gate.

### Where it is social rather than mechanical

Most of `AGENTS.md` is enforced by **the agent choosing to comply**, which means
the reliability of the spec equals the reliability of the model on the day:

| Rule | Enforced by |
| --- | --- |
| Static prompt ≤ 7,200 chars | test ✅ |
| Understanding caps | code ✅ |
| Memory entry budget | write-time rejection ✅ |
| Version consistency | CI ✅ |
| Zero runtime dependencies | now a test — `specInvariants.test.ts` |
| Single prompt builder | now a test — exactly one non-test call site |
| Workspace-relative paths | code ✅ |
| "Extend docs, don't add files" | nothing — compliance only |
| GA API versions only | now a test — allowlist of `7.1` + the comments preview |

Those three "easy wins" were written and shipped (roadmap #5):
`src/test/suite/shared/specInvariants.test.ts` pins the dependency count, the
single `generateSystemPrompt()` call site and the `api-version` allowlist, and
each rule was **verified to fail against an injected violation** before it was
kept — the same discipline as the `check:version` self-test that asserts the
gate exits exactly 1. The pattern still holds for what remains, so the old
paragraph is kept for the rest:

The pattern is clear and fixable: **the rules with a test hold; the rules without
one drift.** The two easiest wins are a dependency-count assertion and a test
that `generateSystemPrompt` has exactly one caller — both are a few lines and
both currently rely on good intentions.

### Why B

Because writing `AGENTS.md` at all — and making it specific enough to be
falsifiable — is ahead of most projects, and enforceability has improved exactly
where it was weakest: the three invariants this article used to call "good
intentions" now have tests that were proven to fail before they were kept.

What keeps it at B rather than B+ is the docs budget. "Extend an existing
document; never a `.md` per step or per turn" is a judgement about intent, not an
assertion a test can make, and it is the rule most likely to be violated under
pressure — by an agent that still has moves left. That is the honest boundary of
mechanical enforcement here: you can pin a count, a call site and a version
string, but not whether a new file was the right answer.

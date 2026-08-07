# Merge-Flow Guardrails (Round 2) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Harden the agent-worktree merge flow with four additional guardrails: a verification gate on commits, protected PR targets, post-merge cleanup, and conflict surfacing back to the LLM.

**Architecture:** All four build on the merge-flow plumbing already shipped in v0.5.6 (`commit_worktree` / `push_worktree` / `create_pull_request` tools, `GitService` merge methods, AgentRunner guards). Each guardrail is a small, testable addition — no new services.

**Tech Stack:** TypeScript, VS Code extension APIs, Azure DevOps Git REST (api-version 7.1), Mocha.

---

## Current Context / Assumptions

- Merge flow exists: `AgentRunner.delegate()` (worktrees), `GitService.commitWorktreeChanges/pushWorktreeBranch/isBranchUpToDate/deleteBranchIfMerged`, `AdoClient.createPullRequest`, tools wired via `ChatViewProvider.setAgentRunner()` hooks, `MERGE_FLOW_INSTRUCTIONS` in `src/llm/prompts.ts`.
- `AgentRun` carries `id`, `workItemId`, `title`, `branch`, `status` (`running|succeeded|failed|cancelled|interrupted`).
- Duplicate-run guard + stale-base warning already land in `delegate()`.
- Remove already guards dirty worktrees (Commit & Push, then Remove / Remove Anyway / Cancel) and deletes the branch only when merged.
- Tests: `src/test/suite/git/gitService.test.ts`, `src/test/suite/agents/agentRunner.test.ts`, `src/test/suite/llm/tools.test.ts`, `src/test/suite/ado/client.test.ts`. Full suite baseline: 192 passing / 1 known pre-existing flake (`agentRunner "delegate runs through the adapter"` spawn race).

---

## Task 1: Verify-gate on commit ✅ IMPLEMENTED (2026-08-07)

**Objective:** `commit_worktree` refuses to commit work from a run that FAILED verification unless the user explicitly overrides.

**Status:** Done — `onCommitWorktree(runId, message, allowFailed)` in ChatViewProvider.ts blocks `status === 'failed'` (reason: `run 'X' failed — commit only after reviewing (or pass allowFailed)`); `allowFailed?: boolean` added to the tool schema (src/llm/tools.ts) + hook signature + execute case. Tests in chatViewProvider.test.ts (failed→refuse, allowFailed→commit, running→still refused). 196 passing / 1 known flake.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` (`onCommitWorktree` hook)
- Modify: `src/test/suite/webview/chatViewProvider.test.ts`

**Step 1:** In `onCommitWorktree` (currently only blocks `status === 'running'`), also block `status === 'failed'` with `{ committed: false, reason: "run 'X' failed — commit only after reviewing (or pass allowFailed)" }`. Add an optional `allowFailed?: boolean` to the tool args (`src/llm/tools.ts` `commit_worktree` schema + hook signature) so the LLM/user can explicitly override.

**Step 2:** Write failing tests: failed run → hook returns `committed:false` with the failed reason; `allowFailed:true` → commits. (chatViewProvider.test.ts: construct provider, inject `(provider as any).agentRunner = { listRuns: () => [{ id, status: 'failed', ... }] }`, stub `services.git.commitWorktreeChanges`.)

**Step 3:** Run `npm run compile && npm test` — new tests pass, suite otherwise green (ignore the known flake).

**Step 4:** Commit: `git commit -m "feat: block committing failed agent runs unless overridden"`

## Task 2: Protected PR targets ✅ IMPLEMENTED (2026-08-07)

**Objective:** `create_pull_request` refuses targets on a configurable protected-branch list.

**Status:** Done — new setting `adoCode.git.protectedBranches` (string[], default `["main","master"]`) in package.json + settings.ts + `_allSettings()` + ConfigurationPage Git section (array editor); `onCreatePullRequest` throws `refusing to create a PR targeting protected branch '<base>'` when base is in the list (the push guard in GitService.pushWorktreeBranch already refused pushing main/master — this closes the PR side). Tests in chatViewProvider.test.ts (protected base throws via JSON error; normal base passes through to createPullRequest).

**Files:**
- Modify: `src/config/settings.ts` + `package.json` (new setting `adoCode.git.protectedBranches: string[]`, default `["main", "master"]`)
- Modify: `src/webview/ChatViewProvider.ts` (`onCreatePullRequest` hook), `src/webview-ui/src/components/ConfigurationPage.tsx` (add to Git section, type `array`)
- Modify: `src/test/suite/ado/client.test.ts`, `src/test/suite/webview/chatViewProvider.test.ts`

**Step 1:** Read `git.protectedBranches` in the hook; if `base` is in the list → throw `refusing to create a PR targeting protected branch '<base>'`. (The push guard in `GitService.pushWorktreeBranch` already refuses pushing main/master — this closes the PR side.)

**Step 2:** Tests: hook throws for protected base; passes for a normal base. Add the setting to `_allSettings()` keys in `ChatViewProvider.ts` so the Configuration page round-trips it.

**Step 3:** `npm run compile && npm test`, commit: `feat: refuse PRs targeting protected branches`

## Task 3: Post-merge cleanup (PR merged → remove worktree + delete branch) ✅ IMPLEMENTED (2026-08-07)

**Objective:** After a PR merges, offer to clean up: remove the worktree and delete the now-merged local branch.

**Status:** Done —
- `AdoClient.getPullRequestsBySourceBranch(project, repo, branch)` (Git REST `searchCriteria.sourceRefName=refs/heads/<branch>`, encoded) + `getPullRequest(project, repo, id)` (mergeStatus/mergeFailureMessage for Task 4).
- New vscode-free `src/git/mergeCleanup.ts`: `hasMergedPullRequest(run, project, deps)` (any PR `status==='completed' && mergeStatus==='succeeded'`) + `cleanupMergedRun(runId, project, deps)` → removeWorktree + deleteBranchIfMerged; no-op with reason for unknown run / no branch / unmerged PR; repo = basename(workspaceRoot).
- `adoCode.cleanupWorktree` command (extension.ts) — context menu "Clean Up After Merge" (group `3_worktree@2`, `viewItem == statusWorktree || viewItem == worktreeNode`); info/warning messages + tree refresh in finally.
- Auto-offer: `WorktreesTreeProvider.onReloaded(entries)` hook → extension.ts checks finished runs with branches (throttled 10 min/run) and offers "Clean Up After Merge" / "Later" when the PR merged.
- Tests: mergeCleanup.test.ts (7 unit + 2 real-repo integration: merged branch deleted, unmerged branch kept) + 3 AdoClient fetch-stub tests. 208 passing / 1 known flake.

**Files:**
- Modify: `src/ado/client.ts` (`getPullRequest` + `getPullRequestsBySourceBranch` — Git REST `GET /{project}/_apis/git/repositories/{repo}/pullrequests?searchCriteria.sourceRefName=refs/heads/{branch}`)
- Modify: `src/agents/AgentRunner.ts` or `src/webview/ChatViewProvider.ts` — a `cleanupMergedRun(runId)` helper: if the branch's PRs contain one with `status === 'completed'` and `mergeStatus === 'succeeded'` → `git.removeWorktree(runId)` + `git.deleteBranchIfMerged(branch)`
- Modify: `src/extension.ts` — expose `adoCode.cleanupWorktree` command; call it from the Worktrees view context menu ("Clean Up After Merge") and automatically offer it when the Worktrees view refreshes a run whose branch has a completed PR
- Modify: `src/test/suite/ado/client.test.ts`, `src/test/suite/git/gitService.test.ts`

**Steps:** TDD per helper: fetch PRs (fetch-stub), completed+merged → cleanup runs; PR still active → no-op. Wire command + menu (`package.json` `view/item/context`, group `3_worktree@2`). Verify with a real bare remote + fake ADO fetch. Commit: `feat: post-merge cleanup for agent worktrees`

## Task 4: Conflict surfacing ✅ IMPLEMENTED (2026-08-07)

**Objective:** When a PR is created with conflicts (or becomes conflicted), surface the conflicted diff to the chat so the LLM can resolve it.

**Status:** Done —
- `src/git/mergeConflicts.ts` (new, vscode-free): `getMergeConflicts(workspaceRoot, baseBranch, featureBranch)` runs `git merge-tree <merge-base^{tree}> <base> <feature>` (OLD form — this machine is git 2.34.1, the `--write-tree` form needs 2.38+; verified live) and parses `changed in both` / `added in both` sections into `{path, baseSha, ourSha, theirSha}`; fetches each blob via `git show <sha>` capped at 300 lines. PITFALL (found via TDD): the first merge-tree arg must be the MERGE-BASE tree — passing the base branch's own tree makes the merge degenerate (branch1 === base → nothing reported as conflicting).
- `AdoClient.createPullRequest` now returns `mergeStatus` from the creation response.
- New READ-ONLY tool `resolve_pr_conflicts {runId}` (tools.ts — added to READ_ONLY_TOOLS so plan mode allows it) routed through `onResolvePrConflicts` hook; ChatViewProvider maps conflicts to `{path, worktreePath: .ado-code/worktrees/<runId>/<path>, base, ours, theirs, truncated}` so the LLM edits the WORKTREE file via edit_file/apply_diff, then re-commits + re-pushes.
- `MERGE_FLOW_INSTRUCTIONS` extended: create_pull_request → if mergeStatus 'conflicts', resolve_pr_conflicts → edit worktreePath → commit + push again, repeat until clean.
- Tests: mergeConflicts.test.ts (3 parse tests incl. real captured output + 2 real-repo integration: conflict detected with correct base/ours/theirs contents, disjoint-file branches → []), client mergeStatus assert, tools routing (plan mode allowed), prompts (merge flow incl. conflict step). 215 passing / 1 known flake.

**Files:**
- Modify: `src/ado/client.ts` — `getPullRequest` returns `mergeStatus` (`succeeded` / `conflicts` / `rejected`) and the PR's `isDraft`/`status`; add `getPullRequestConflicts(project, repo, prId)` if needed (Git REST exposes `mergeFailureMessage` on the PR)
- Modify: `src/llm/tools.ts` — `create_pull_request` result includes `mergeStatus`; new optional tool `resolve_pr_conflicts` (read-only fetch of the conflicted files list → return to LLM; actual file edits go through existing `read_file`/`edit_file`)
- Modify: `src/llm/prompts.ts` — extend `MERGE_FLOW_INSTRUCTIONS`: "if the PR reports conflicts, fetch the conflicted files and propose/apply resolutions via edit_file, then re-push"
- Modify: tests in `src/test/suite/ado/client.test.ts`, `src/test/suite/llm/prompts.test.ts`

**Steps:** TDD the ADO fetch stubs; wire the tool + prompt; verify suite. Commit: `feat: surface PR conflicts to the agent for resolution`

---

## Suggested Task Order & Batching

Tasks 1–2 are small and independent → do first. ~~Task 3 depends on new ADO GET methods (task-4-adjacent) → do third. Task 4 last.~~ ALL FOUR TASKS DONE (2026-08-07): verify-gate, protected PR targets, post-merge cleanup, conflict surfacing. Suite 215 passing / 1 known pre-existing flake.

## Tests / Validation

- `npm run compile` — clean
- `npm test` — all new tests pass; only the documented pre-existing `agentRunner` spawn-race flake may fail
- `npx eslint <changed files> --ext ts` — no new errors (pre-existing `tools.ts` requires at ~445/510/528 and `ChatViewProvider.ts` requires/escapes remain untouched)
- Manual: run a delegate → verify commit tool refuses on failed run → run one to success → commit/push/PR → check PR target guard → after merge, cleanup command removes worktree + branch

## Risks / Tradeoffs / Open Questions

- **Verify-gate false positives**: a run can be `failed` because the ADAPTER failed (e.g. CLI missing) with no code changes — `allowFailed` override covers this; consider wording in the tool description.
- **PR polling cost**: Task 3 needs a `GET pullrequests` call per refresh — guard with the run's `branch` existence and only when the view is visible.
- **Repo name resolution**: `create_pull_request` uses `path.basename(workspaceRoot)` as the ADO repo name — misnamed repos will 404; open question: should we match against `GET /_apis/git/repositories` by name instead (case-insensitive)?
- **Protected branches**: default list `["main","master"]` is opinionated; per-repo overrides may be needed later.

# Live Agent Progress in the Editor Area

**Date:** 2026-08-22
**Branch:** feature/v0.6.1-work-item-tree-hierarchy (feature work proceeds on top)

## Goal

Improve agent progress display when an agent works on a delegated work item, and
add the option to move the progress into the EDITOR area as a live, real-time,
nicely formatted panel.

## Current State

- AgentRunner streams `onStatus(run, delta)` chunks + `onComplete(run, summary)`
  to extension.ts callbacks.
- Chat webview shows one raw-`<pre>` AgentOutputPanel per run (auto-scroll,
  status label, spinner dot). No elapsed time, no "open live in editor" affordance
  while running.
- AgentSummaryPanel (static HTML, no scripts) opens in the editor area ONLY on
  completion (`openSummaryInEditor`) or via the ↗ button on FINISHED runs.
- Work Items tree shows `🤖 <agent>` + spinner icon on the work item node while
  running; status bar shows a working indicator.

## Design

### 1. `src/webview/AgentProgressPanel.ts` — LIVE editor panel (script-enabled)

Static class, one panel per run (deduped by `adoCode.agentProgress.<runId>`,
mirrors AgentSummaryPanel):

- `show(context, run, initialOutput)` — create/reveal panel in
  `ViewColumn.Beside`, `retainContextWhenHidden: true`, `enableScripts: true`.
  Posts an `init` message (run state + initial output) to the panel webview.
  For finished runs (or runs with a `summary`), renders the summary section
  directly; reads `run.outputFile` (bounded) when no accumulated log exists
  (interrupted runs after reload).
- `update(run, delta)` — no-op unless a panel exists; posts `{type:'append',
  delta}`. The panel JS splits chunks into timestamped lines, styles known
  event markers (`worktree created`, `delegating to`, `pre-agent hook`,
  `cancelled by user`, `verifying`), caps the DOM at ~2000 lines.
- `complete(run, summary)` — posts `{type:'complete', run, summaryHtml}`;
  summaryHtml produced extension-side by the shared `renderMarkdown` (escapes
  HTML first → safe for innerHTML). Panel stops the elapsed timer, swaps the
  indeterminate progress bar for a final status bar, shows the summary section.
  Panel title updated with ✓/✗/⊘ icon.
- HTML/CSS: header (agent, ADO id, branch badge, status badge, live elapsed
  clock), animated indeterminate progress bar while running, toolbar (follow
  toggle, clear log, copy log), log view (monospace, timestamped, event-styled),
  summary section. All agent/user text injected via `textContent` (never
  innerHTML) except the sanitized `summaryHtml`.
- JS: `window.addEventListener('message')`; `setInterval` 1s elapsed ticker;
  auto-scroll follows unless the user scrolls up (then a "↓ jump to bottom"
  pill appears).

### 2. `src/webview/markdown.ts` — shared helpers

Extract `escapeHtml` + `renderMarkdown` from AgentSummaryPanel (identical
behavior) so the progress panel's completion view reuses the same renderer.

### 3. AgentRunner — accumulate per-run output

- Add `private runLogs = new Map<string, string>()`.
- Add `private emitStatus(run, delta)`: append delta to runLogs (bounded ~256KB,
  keep tail) then `callbacks.onStatus(run, delta)`. Replace ALL
  `this.callbacks.onStatus(...)` call sites (delegate, followUp, runPreHook,
  cancel) with `emitStatus`.
- Add `getRunOutput(runId): string` public accessor (used by the open command /
  message handler to backfill the panel with everything streamed so far).

### 4. Message protocol

- `src/shared/messages.ts` + `src/webview-ui/src/types.ts`: add webview→extension
  `{ type: 'openAgentProgress'; runId: string }`. Keep `reopenAgentOutput`
  handled for backward compatibility (finished-run re-open still works).

### 5. ChatViewProvider

- Handle `openAgentProgress` in `handleAgentMessage`: find the run via
  `agentRunner.listRuns()`, call `AgentProgressPanel.show(this._context, run,
  agentRunner.getRunOutput(run.id))` (works for running AND finished runs).

### 6. extension.ts wiring

- In `onStatus`: after the existing work, call
  `AgentProgressPanel.update(run, delta)` (no-op if no panel open). On the
  FIRST status chunk of a run when `adoCode.agents.progressView === 'editor'`,
  auto-open the live panel (`AgentProgressPanel.show(context, run, '')` — the
  run's own log accumulates from here on).
- In `onComplete`: if a progress panel exists for the run OR
  `progressView === 'editor'` → `AgentProgressPanel.complete(run, summary)`
  (summary lives inside the live panel); otherwise keep the existing
  `openSummaryInEditor` → AgentSummaryPanel behavior (chat mode).
- Register command `adoCode.openAgentProgress`: QuickPick of runs (running
  first, then recent), opens the live panel for the picked run with its
  accumulated output. Add to package.json activation events + commands.
- Guard all AgentProgressPanel calls in try/catch so panel failures never break
  the run stream (same spirit as H8 output-file safety).

### 7. Webview UI — AgentOutputPanel.tsx + App.tsx

- Add `onOpenInEditor?: (runId) => void` prop. Replace the finished-only ↗
  button with a single "Open in editor ↗" button for ALL runs (running →
  live panel; finished → summary view in the same panel). App.tsx posts
  `{ type: 'openAgentProgress', runId }`.
- Add a live elapsed-time readout in the header while `run.status === 'running'`
  (local `setInterval`, computed from `run.startedAt`), formatted mm:ss — the
  "improved display" part on the chat side.
- Update the webview-side `AgentRun` interface if the shared copy needs it
  (startedAt already present).

### 8. package.json

- Setting `adoCode.agents.progressView`: enum `chat` (default) | `editor`.
  chat = current behavior (stream in chat, static summary panel on completion);
  editor = auto-open the live panel in the editor area when a run starts; the
  same panel morphs into the summary at completion.
- Command `adoCode.openAgentProgress` (title "Open Agent Progress…", category
  "ADO Code") + `onCommand:adoCode.openAgentProgress` activation event.

### 9. Tests

- `agentRunner.test.ts`: `getRunOutput` accumulates chunks; bounded tail.
- `chatViewProvider.test.ts`: `openAgentProgress` message handler calls
  AgentProgressPanel.show for an existing run (spy on the static).

### 10. Docs + packaging

- README (agent delegation section) + CHANGELOG in the same session.
- `npm run compile && npm run lint && npm test && npm run build:webview`,
  then `npx vsce package --allow-missing-repository` (no version bump unless
  the user installs the VSIX to test).

## Files touched

- src/agents/AgentRunner.ts (log accumulation)
- src/agents/types.ts (no change expected)
- src/webview/markdown.ts (new — shared renderers)
- src/webview/AgentSummaryPanel.ts (use shared renderers)
- src/webview/AgentProgressPanel.ts (new — live panel)
- src/shared/messages.ts (protocol)
- src/webview/ChatViewProvider.ts (handler)
- src/extension.ts (wiring, command)
- src/webview-ui/src/types.ts (protocol)
- src/webview-ui/src/components/AgentOutputPanel.tsx (button + timer)
- src/webview-ui/src/App.tsx (wiring)
- package.json (setting + command + activation)
- src/test/suite/agents/agentRunner.test.ts
- src/test/suite/webview/chatViewProvider.test.ts
- README.md, CHANGELOG.md

## Pitfalls to respect

- Webview pitfalls list (retainContextWhenHidden, postMessage drop when
  `_view` null, loading cleared at source).
- Never innerHTML with agent output — textContent only; summaryHtml is
  escaped-first via renderMarkdown.
- Do NOT add runtime dependencies (zero-runtime-dep rule) — panel uses vanilla
  CSS/JS, no markdown lib.
- Keep `onStatus` callback cheap: AgentProgressPanel.update must no-op fast
  when no panel is open (per-chunk calls).

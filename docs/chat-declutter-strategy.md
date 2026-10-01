# Chat Area Declutter Strategy

Goal: keep the chat thread readable as turns get long and tool-heavy — the user
should see *answers and decisions* first, with execution detail available but
never in the way. This is a UI/UX plan; each item is independently shippable.

## Problem statement

A single agentic turn can currently push into the thread:

- the user message + attached-file blocks (re-serialized into the bubble),
- a **boxed** reasoning block when `chat.showThinking` is on (border, accent rule,
  💭 icon, "Thinking" caption, and a collapse toggle),
- one **live card per tool call** (running → completed), with arguments and
  results, when `chat.showToolCalls` is on — a read/search-heavy turn easily
  emits 10–30 cards,
- a "Working…" disclosure that lists everything currently running,
- a final assistant answer, plus optional `planReady`, proposed-task,
  delegation, consent, and confirmation cards.

Result: the *answer* is buried under a wall of transient execution chrome, and
scrolling back to a past decision means scrolling past every intermediate tool
call. Turn *count* rarely grows fast; turn *height* grows fast.

## Principles

1. **Answer-first.** The assistant's final text is the primary object; everything
   else is supporting detail that collapses by default once the turn completes.
2. **Progressive disclosure.** Show *what happened* (a one-line summary), reveal
   *how* (arguments/results) on demand. Nothing is deleted — only folded.
3. **Live while streaming, quiet when done.** Chrome that helps during a turn
   (spinners, running cards) should collapse or fade the moment the turn ends.
4. **One row per intent.** Related tool calls (a batch, a read-then-edit) belong
   to one group, not N top-level rows.
5. **Keyboard- and bulk-friendly.** Collapse/expand all, jump to last answer,
   and copy/export should all be one action — not per-row clicks.
6. **Configurable, not opinionated-only.** `chat.showThinking` / `chat.showToolCalls`
   already exist; new density controls should be opt-in and default to *less* noise.
7. **State by style, not chrome.** Convey auxiliary/transient states with color,
   weight, and spacing — not with icons, captions, borders, or boxes. A 💭 glyph,
   a "Thinking" label, and a blue-bordered card all communicate *less* than dimmed
   text does, while costing far more height and attention.

## Inventory (current elements, by noise/height cost)

| Element | Source | Default | Cost |
| --- | --- | --- | --- |
| Live tool cards | `chat.showToolCalls` | on | High (N rows/turn) |
| Reasoning text | `chat.showThinking` | on | Low — plain dimmed text, no box/icon/label |
| "Working…" disclosure | turn trace | always | Medium while running |
| Attached-file echo | `handleSend` file blocks | always | Medium (re-dumps file bodies) |
| Consent / confirmation cards | inline/act modes | as needed | High but necessary |
| planReady / proposed tasks | plan + `/generate-tasks` | as needed | Necessary |

## Roadmap (ordered, each independently shippable)

### 1. Group a turn's tool calls into one collapsible "activity" row
- **What:** Wrap consecutive `toolCall`/`toolResult`/`toolCallDone` events of a
  turn into a single collapsed row: `Ran 7 tools ▸` that expands to the existing
  cards.
- **Where:** webview `components/MessageList.tsx` (trace assembly) + the live
  trace reducer in `App.tsx` (`commitLiveTrace`).
- **Default:** collapsed **after** the turn completes; expanded while streaming
  only if `chat.showToolCalls` is on.
- **Why first:** biggest single height win, no data loss, reuses existing cards.

### 2. Reasoning as quiet, unbordered text (strip the Thinking chrome)
- **What:** Render reasoning as flat, de-emphasized text — the way it already
  flows in the live bubble — and remove the component chrome entirely:
  - **no box** — drop the 1px border, the 3px left accent rule, the rounded
    widget background, and the inner scroll (`max-height`/`overflow`);
  - **no 💭 bubble icon**;
  - **no "Thinking" label/caption**;
  - **no collapse affordance** — no chevron, no preview line, no `defaultOpen`/
    open state, no live-vs-restored variants.
  The existing `chat.showThinking` setting is the *only* gate: on → the reasoning
  is shown inline, off → it is hidden. Nothing per-block to click.
- **How it reads:** muted `--vscode-descriptionForeground` text at a slightly
  smaller size, indented and generously spaced so it *recedes*, with the answer
  following at full contrast. The stream → answer transition is communicated by
  color/weight alone; long reasoning simply flows with the thread and never
  competes with the answer for attention.
- **Where:** `components/MessageList.tsx` — replace `ThinkingBlock` with a plain
  `ReasoningText` element; delete the `useState` open toggle, the chevron,
  `<span className="thinking-icon">💭`, and the `.thinking-label`/preview spans.
  `styles/app.css` — delete `.thinking-block`, `.thinking-block-live`,
  `.thinking-block-restored`, `.thinking-header`, `.thinking-chevron`,
  `.thinking-icon`, `.thinking-label`, `.thinking-preview`, `.thinking-toggle`;
  keep a single `.reasoning-text` rule.
- **Config:** `chat.showThinking` is unchanged and remains the sole on/off control;
  update its `ConfigurationPage` description to drop the "blue thinking block"
  wording.
- **Why:** removes four pieces of chrome (border, icon, caption, toggle) plus the
  box's border/padding/`max-height` from *every* reasoning block — a pure height
  and attention win, and the concrete application of principle 7.

### 3. Attachment echo → chip, not inline dump
- **What:** A message with attachments shows `📎 3 files` chips (hover = filename
  list) instead of re-serializing file bodies into the bubble. The full content
  still goes to the model; only the *display* is compressed.
- **Where:** `App.tsx` `handleSend` display-content construction (already splits
  `fullContent` vs `displayContent`) + a chip component.
- **Note:** aligns with the existing image-marker display path.

### 4. Turn summary line for completed turns
- **What:** Above each completed turn's answer, a one-line meta row:
  `8 tools · 1 edit · 42s · 3.1k tokens`. Collapsed activity (item 1) lives here.
- **Where:** webview turn rendering; data already flows via the turn trace.
- **Why:** gives a scannable history without expanding anything.

### 5. "Answers only" / density mode
- **What:** A per-session toggle (and a config default) that hides all tool
  chrome, thinking, and meta rows, showing only user messages and final answers,
  with an inline `▸ details` to reveal per turn.
- **Where:** new `adoCode.chat.density` setting (`comfortable` | `compact` |
  `answers-only`) threaded through the existing config message; webview applies
  it as a container class.
- **Why:** serves the "just show me the result" workflow without deleting tools.

### 6. Sticky "jump to latest answer" + collapse-all
- **What:** When scrolled up, a floating affordance jumps to the latest answer;
  a kebab action collapses/expands every turn.
- **Where:** `MessageList.tsx` scroll container + `KebabMenu`.
- **Why:** complements collapse; makes long threads navigable.

### 7. De-emphasize, don't hide, transient status
- **What:** The "Working…" line and per-tool running spinners become a single
  low-contrast status line pinned above the input, rather than inline rows.
- **Where:** `App.tsx` live-trace + `InputBar` area.

## Non-goals

- Removing information (everything stays reachable).
- Changing what the model receives — this is purely a rendering/UX concern.
- Per-row manual curation by the user.

## Relationship to shipped work

- **Queue/steer (0.7.0):** sends issued while the AI is busy no longer force a
  scroll-jumping interrupt. **Queue** collects them in a compact `N queued` strip
  above the input; **steer** injects the text into the running turn's next
  iteration (a single `⚡` marker in the thread, no new bubble churn). Both
  reduce the number of half-finished turns and the associated chrome, and make
  interrupted/duplicated content far less common.
- **Delegation suggestions (0.7.0):** surfaced as a single compact card near the
  input rather than inline prose, so a suggestion never adds a wall of text to
  the thread.

## Suggested sequencing

1 → 2 → 3 (pure density wins, no new config) → 4 → 6 (navigation) → 5 (explicit
density modes) → 7 (polish). Items 1–3 deliver the majority of the height
reduction for the least risk: items 1 and 3 only *fold* already-rendered
elements, and item 2 only *removes* chrome — no new state, no new data, no new
config.

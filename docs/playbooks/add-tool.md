# Playbook: Adding a New Tool

How to add a new native tool to ADO Code's tool system.

## Overview

All tool execution lives in ONE place: the `createToolExecutor()` factory in
`src/llm/tools.ts`. Every tool is an OpenAI-compatible `LlmTool` (name +
description + JSON Schema) entry in the `allTools` array, a classification in
`READ_ONLY_TOOLS` / `MUTATING_TOOLS`, and a `case` in the executor's `switch`.
There is no separate definition/implementation split — the legacy
`BaseTool`/`ToolRegistry`/`definitions/` layer was removed in 0.6.0.

The agentic loop (`src/llm/agentic.ts`) executes tools through the executor's
`execute(name, args)` — which also serves `canAutoExecute(name, args)` so the
loop can batch independent calls in parallel (see "Execution model" below).

## Steps

### 1. Add the tool to `allTools` in `src/llm/tools.ts`

Add an `LlmTool` entry describing the tool, what it does, and every parameter:

```typescript
{
  name: 'my_tool',
  description: 'Short description of what the tool does — include when to use it',
  parameters: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'What param1 does' },
      param2: { type: 'number', description: 'What param2 does (optional)' },
    },
    required: ['param1'],
  },
},
```

### 2. Classify it (mode gating)

In `src/llm/tools.ts` add the tool name to exactly one set:

- **`READ_ONLY_TOOLS`** — non-mutating tools (reads, searches, pure loaders).
  Allowed in every mode including plan.
- **`MUTATING_TOOLS`** — tools that change state. Auto-approved in act/yolo,
  consents in inline, BLOCKED in plan.

If it's a file-mutating tool (`edit_file`/`write_to_file`/`apply_diff` pattern),
wrap the write inside `withFileMutationQueue(uri.fsPath, fn)` (defined in
`src/llm/tools.ts`) — parallel batches may target the same file and
read-modify-write must not interleave.

### 3. Implement the `case` in the `switch (name)`

Add a case that returns a `string` (JSON or text) fed back to the model:

```typescript
case 'my_tool': {
  // Validate required params up front, return { error } JSON on failure —
  // NEVER throw (a throw kills the agentic loop).
  const param1 = String(args.param1 ?? '');
  if (!param1) {
    return JSON.stringify({ error: 'my_tool: missing required parameter: param1' });
  }
  const result = await doTheWork(param1, Number(args.param2 ?? 0));
  // Cap large outputs: capToolResult(text) trims head+tail to a token budget.
  return capToolResult(JSON.stringify(result));
}
```

Notes:
- **Path handling**: workspace-relative paths must go through
  `resolveWorkspacePath(path)` — it enforces C4 confinement (`../` escapes) and
  throws on escape. Errors become `JSON.stringify({ error })`, not throws.
- **Async**: the case body may `await` VS Code APIs or services
  (`services.ado`, `services.skills`, `services.memory`, `services.mcp`, …).
- **Output size**: prefer `capToolResult(...)` for anything that can be large
  (file contents, lists, threads).

### 4. Add the type, display name, and group in `src/llm/tools/types.ts`

- `ToolName` union — add `'my_tool'`
- `NativeToolArgs` — add `my_tool: { param1: string; param2?: number }`
- `TOOL_DISPLAY_NAMES` — add `my_tool: 'My tool'`
- `TOOL_GROUP_MAP` — add to the logical group (`read`, `write`, `execute`,
  `ado`, `memory`). This drives the system-prompt tool listing (via
  `modes.ts`/`getToolsForMode`) and the consent category. Keep it in sync with
  the `READ_ONLY_TOOLS`/`MUTATING_TOOLS` classification.

### 5. Write tests

`src/test/suite/llm/tools.test.ts` is the executor test home — the suite runs
in VS Code electron WITHOUT a workspace folder, so file/workspace APIs can't be
exercised end-to-end. Test what's pure:

```typescript
suite('my_tool', () => {
  test('is read-only / exposed to the model', () => {
    const ex = makeExecutor('plan');
    assert.strictEqual(ex.canAutoExecute('my_tool', { param1: 'x' }), true);
    assert.ok(ex.tools.map(t => t.name).includes('my_tool'));
  });

  test('fails loudly on missing required params', async () => {
    const ex = makeExecutor('act');
    const res = await ex.execute('my_tool', {});
    assert.ok(String(res).includes('missing required parameter'));
  });
});
```

Extract any non-trivial logic into a pure exported function (like
`grepLines`, `applyOrderedEdits`, `truncateMatchLine`) so it's unit-testable
without the VS Code host, and test that directly.

## Execution model (why `canAutoExecute` matters)

The agentic loop runs all tool calls in a batch **in parallel** when none of
them needs user interaction, and **sequentially** when any would prompt (so
consent cards appear one at a time). `canAutoExecute(name, args)` must be a
pure prediction of `execute()` — the shared `gateTool()` implements both, so
they can never disagree. If your tool is read-only, mutating-when-allowlisted,
or otherwise prompt-free, the batch parallelizes automatically.

## Pitfalls

- **Never throw** — the loop treats a rejected promise as a fatal error. Return
  `JSON.stringify({ error })`.
- **Consent correctness**: mutating tools in inline mode REQUIRE the approval
  hook (`hooks.onApprove`); if none is wired the executor denies rather than
  silently executing. `gateTool()` handles this — don't bypass it.
- **Path confinement**: always `resolveWorkspacePath()` for workspace paths —
  never trust a model-supplied path directly.
- **Same-file races**: file mutators must use `withFileMutationQueue`.
- **Output budgets**: unbounded results re-send with EVERY loop iteration —
  default bounded windows (like `read_file`'s 200-line default) and cap big
  outputs.
- **Truncated responses**: if the model response reports
  `stopReason: 'length'/'max_tokens'`, the loop fails the whole batch — your
  tool must tolerate error results arriving for calls it never ran.

## File Checklist

| File | Action |
|------|--------|
| `src/llm/tools.ts` | Edit — `allTools` entry, `READ_ONLY_TOOLS`/`MUTATING_TOOLS`, `switch` case (+ `withFileMutationQueue` for file mutators) |
| `src/llm/tools/types.ts` | Edit — `ToolName`, `NativeToolArgs`, `TOOL_DISPLAY_NAMES`, `TOOL_GROUP_MAP` |
| `src/test/suite/llm/tools.test.ts` | Edit — classification + error-path + pure-logic tests |
| `src/llm/prompts/system.ts` | Optional — add usage guidance so the model knows when to call it |
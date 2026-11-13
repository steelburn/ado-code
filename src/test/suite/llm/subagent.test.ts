/**
 * Search subagent (roadmap #8).
 *
 * Two kinds of test here, and the split matters:
 *   - `runSubagent` against the real loop with a canned provider, which is what
 *     proves the child's budget is its own and that a bad child never throws;
 *   - the REAL `createToolExecutor` narrowed by `allowedTools`, which is what
 *     proves the surface is enforced rather than merely advertised. A subagent
 *     that can be talked into `edit_file` is worse than no subagent.
 */

import * as assert from 'assert';
import { LlmClient } from '../../../llm/client';
import { LlmConfig } from '../../../llm/types';
import { createToolExecutor } from '../../../llm/tools';
import {
  SUBAGENT_MAX_ITERATIONS,
  SUBAGENT_TOOL_ALLOWLIST,
  buildSubagentSystemPrompt,
  isSubagentTool,
  normalizeSubagentReport,
  runSubagent,
} from '../../../llm/subagent';

function jsonResponse(body: any) {
  return { ok: true, json: async () => body };
}

const config: LlmConfig = {
  provider: 'openai',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

/** Answers every round-trip with the same message. */
function stubFetch(message: any) {
  (globalThis as any).fetch = async () => jsonResponse({ choices: [{ message }] });
}

function textMessage(content: string) {
  return { role: 'assistant', content };
}

function toolCallMessage(name: string, args: Record<string, any>, id = 'call_1') {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** A child executor that records what the loop asked for. */
function recordingExecutor(calls: string[]) {
  return {
    tools: [],
    mode: 'act' as 'inline' | 'plan' | 'act' | 'yolo',
    setMode(_m: 'inline' | 'plan' | 'act' | 'yolo') {},
    beginTurn() {},
    canAutoExecute(_name: string, _args: Record<string, any>): boolean {
      return true;
    },
    async execute(name: string, args: Record<string, any>): Promise<string> {
      calls.push(name);
      return `result of ${name}(${JSON.stringify(args)})`;
    },
  };
}

suite('Search subagent — the child is read-only', () => {
  test('the allowlist contains no tool that can change anything', () => {
    const forbidden = [
      'edit_file',
      'apply_diff',
      'write_to_file',
      'run_terminal_command',
      'create_work_item',
      'update_work_item_state',
      'add_comment',
      'delegate_to_agent',
      // Third-party instruction text has no business inside a nested context.
      'execute_skill',
    ];
    for (const name of forbidden) {
      assert.strictEqual(isSubagentTool(name), false, `${name} must never be reachable from the subagent`);
    }
  });

  test('the allowlist is small and every entry supports search', () => {
    // A growing allowlist is how a read-only child stops being read-only.
    assert.ok(SUBAGENT_TOOL_ALLOWLIST.length <= 8, 'keep the child surface narrow');
    for (const name of ['list_workspace', 'search_files', 'read_file']) {
      assert.ok(isSubagentTool(name), `${name} is the minimum viable search surface`);
    }
  });

  test('the child prompt forbids writing and demands citations', () => {
    const prompt = buildSubagentSystemPrompt();
    assert.match(prompt, /cannot edit, create, delete/i);
    assert.match(prompt, /path:line/, 'every claim needs a citation or the parent cannot verify it');
    assert.match(prompt, /FINDINGS:/);
    assert.match(prompt, /GAPS:/);
    assert.match(prompt, /not found/i, 'saying "not found" must be explicitly allowed, or the model guesses');
  });

  test('a narrowed executor advertises only the allowlisted surface', () => {
    const ex = createToolExecutor({} as any, {} as any, { allowedTools: SUBAGENT_TOOL_ALLOWLIST });
    assert.ok(ex.tools.length > 0, 'the child must be able to do something');
    for (const tool of ex.tools) {
      assert.ok(isSubagentTool(tool.name), `${tool.name} was advertised to the child but is not in the allowlist`);
    }
  });

  test('a narrowed executor refuses a non-allowlisted tool at the gate', async () => {
    const ex = createToolExecutor({} as any, {} as any, { allowedTools: SUBAGENT_TOOL_ALLOWLIST });
    // Not merely absent from the advertised list: calling it anyway must fail, because
    // models do call tools they were not offered.
    const result = await ex.execute('edit_file', { path: 'a.ts', edits: [] });
    assert.match(result, /not available in this scope/);
  });

  test('explore_codebase itself is read-only, so plan mode may use it', () => {
    const ex = createToolExecutor({} as any, {} as any, {});
    ex.setMode('plan');
    assert.ok(
      ex.tools.some((t) => t.name === 'explore_codebase'),
      'plan mode allows read-only tools; a subagent that only reads belongs there'
    );
  });

  test('an unrestricted executor still advertises the subagent tool', () => {
    const ex = createToolExecutor({} as any, {} as any, {});
    assert.ok(ex.tools.some((t) => t.name === 'explore_codebase'));
  });
});

suite('runSubagent — the nested loop', () => {
  test('returns the child report verbatim', async () => {
    stubFetch(textMessage('FINDINGS:\n- the gate lives in tools.ts — src/llm/tools.ts:275'));
    const client = new LlmClient(config);
    const calls: string[] = [];
    const result = await runSubagent(client, recordingExecutor(calls), 'where is the consent gate?');

    assert.match(result.report, /src\/llm\/tools\.ts:275/);
    assert.strictEqual(result.timedOut, false);
    assert.ok(result.iterations >= 1, 'the child ran at least one round-trip');
  });

  test('runs tools through the injected executor', async () => {
    stubFetch(toolCallMessage('search_files', { regex: 'gateTool' }));
    const client = new LlmClient(config);
    const calls: string[] = [];
    await runSubagent(client, recordingExecutor(calls), 'find gateTool', { maxIterations: 2 });
    assert.deepStrictEqual(calls, ['search_files', 'search_files'], 'both budgeted round-trips executed the call');
  });

  test("the child's budget is its own and exhausting it reports a partial answer", async () => {
    stubFetch(toolCallMessage('search_files', { regex: 'loop' }));
    const client = new LlmClient(config);
    const calls: string[] = [];
    const result = await runSubagent(client, recordingExecutor(calls), 'never finishes', { maxIterations: 3 });

    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.iterations, 3);
    assert.match(result.report, /budget/, 'the parent must be told the report is partial');
    assert.match(result.report, /do not read silence as absence/i);
  });

  test('an empty child answer degrades to an explicit non-answer', async () => {
    stubFetch(textMessage('   '));
    const client = new LlmClient(config);
    const result = await runSubagent(client, recordingExecutor([]), 'anything');

    assert.ok(result.report.length > 0, 'a blank tool result reads as "nothing found", which is worse');
    assert.match(result.report, /without writing a report/);
    assert.match(result.report, /search directly/);
  });

  test('a provider failure becomes a report, not an exception', async () => {
    (globalThis as any).fetch = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
    const client = new LlmClient(config);
    const result = await runSubagent(client, recordingExecutor([]), 'anything');

    assert.match(result.report, /search subagent failed/i);
    assert.match(result.report, /search directly/i);
  });

  test('an empty task costs nothing', async () => {
    let fetched = 0;
    (globalThis as any).fetch = async () => {
      fetched++;
      return jsonResponse({ choices: [{ message: textMessage('x') }] });
    };
    const client = new LlmClient(config);
    const result = await runSubagent(client, recordingExecutor([]), '   ');

    assert.strictEqual(fetched, 0, 'no round-trip for a task that asks nothing');
    assert.match(result.report, /non-empty task/);
  });

  test('the default budget stays small', () => {
    assert.ok(SUBAGENT_MAX_ITERATIONS > 0 && SUBAGENT_MAX_ITERATIONS <= 20);
  });
});

suite('normalizeSubagentReport', () => {
  test('caps an oversized report so the child cannot crowd out the parent', () => {
    const huge = 'FINDINGS:\n' + Array.from({ length: 4000 }, (_, i) => `- fact ${i} — src/a.ts:${i}`).join('\n');
    const report = normalizeSubagentReport(huge);
    assert.ok(report.length < huge.length, 'the report must be truncated');
    assert.match(report, /omitted|truncat/i, 'truncation must be visible to the model');
  });

  test('keeps a normal report untouched', () => {
    const text = 'FINDINGS:\n- one thing — src/a.ts:1';
    assert.strictEqual(normalizeSubagentReport(text), text);
  });

  test('only adds the partial note when the child ran out of budget', () => {
    const text = 'FINDINGS:\n- one thing — src/a.ts:1';
    assert.doesNotMatch(normalizeSubagentReport(text, { iterations: 4 }), /budget/);
    assert.match(normalizeSubagentReport(text, { timedOut: true, iterations: 12 }), /12-iteration budget/);
  });
});

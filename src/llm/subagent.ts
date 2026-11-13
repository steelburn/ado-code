/**
 * In-process search subagent — a nested, read-only agentic loop.
 *
 * Why a second loop instead of a better prompt: a search-heavy question ("where
 * is this decided?", "which callers break if that changes?") spends the parent's
 * iteration budget on exploration whose *transcript* the parent never needs —
 * only the conclusion does. Running that exploration in a nested loop with its
 * own budget keeps the parent's iterations for the work, and returns a report
 * instead of fifty tool results competing for the context window.
 *
 * Three properties make it safe:
 *
 *   1. The child's tool surface is enforced by its OWN executor, not merely by
 *      what is advertised to the model. A model that calls `edit_file` anyway
 *      gets an error from the consent gate, never an edit — see `allowedTools`
 *      in `gateTool` (`src/llm/tools.ts`).
 *   2. Its iteration budget is its own. A runaway search costs at most
 *      SUBAGENT_MAX_ITERATIONS and can never consume the parent's budget.
 *   3. The report is always non-empty and always capped. Budget exhaustion, an
 *      abort or an empty answer degrades into an explicit statement of what was
 *      searched, so the parent can never receive a blank tool result it has to
 *      re-search for.
 *
 * No `vscode`, no `fs`: the client and executor are injected, which is what makes
 * the whole thing testable with a stub client.
 */

import { LlmClient } from './client';
import { ToolExecutor, capToolResult } from './tools';
import { LlmMessage } from './types';
import { runAgenticChat } from './agentic';
import { TurnSignals, emptyTurnSignals } from '../shared/turnSignals';

/**
 * The child's entire world. Read-only by construction: every entry is in
 * READ_ONLY_TOOLS, and there is a test that keeps it that way.
 *
 * Deliberately absent: `execute_skill` (injects third-party instruction text into
 * a nested context), `run_terminal_command` (not read-only), and every work-item
 * tool (the parent already holds that context).
 */
export const SUBAGENT_TOOL_ALLOWLIST: readonly string[] = [
  'list_workspace',
  'search_files',
  'read_file',
  'get_selection',
  'list_workspace_memory',
  'read_workspace_memory',
];

/** Small on purpose: a search that needs more than this should be split up. */
export const SUBAGENT_MAX_ITERATIONS = 12;

/** The report is a hand-off, not a transcript — it must not crowd out the parent's work. */
export const SUBAGENT_REPORT_TOKEN_BUDGET = 2500;

/** True when `name` may be called inside the subagent. Also the test's seam. */
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_ALLOWLIST.includes(name);
}

export function buildSubagentSystemPrompt(): string {
  return [
    'You are a search subagent. A larger agent is mid-turn and delegated one',
    'exploration question to you. You investigate, then report back and stop.',
    '',
    'Rules:',
    '- You can only read and search. You cannot edit, create, delete, run',
    '  commands, post comments or change work items. Do not claim you did.',
    '- Locate before you read: list_workspace or search_files first, read_file to',
    '  confirm. Reading files one by one without searching wastes your budget.',
    '- Cite evidence as `path:line` for every claim. A claim you cannot cite is a',
    '  guess — write "not found" instead. The calling agent acts on what you say,',
    '  so a confident wrong answer is worse than an admitted gap.',
    '- Answer the question that was asked. Do not propose an implementation plan',
    '  unless the task asks for one; the calling agent decides what to do.',
    '',
    'Report format, plain text, no preamble:',
    'FINDINGS:',
    '- <fact> — <path:line>',
    'GAPS:',
    '- <what you could not determine, and where you would look next>',
    '',
    `Keep it under roughly ${SUBAGENT_REPORT_TOKEN_BUDGET} tokens. The calling agent`,
    'does not re-read anything you omit.',
  ].join('\n');
}

export interface SubagentReportMeta {
  /** The child hit its iteration budget rather than concluding. */
  timedOut?: boolean;
  iterations?: number;
  toolCallCount?: number;
}

/**
 * Make a usable report out of whatever the child produced.
 *
 * Never returns an empty string: an empty tool result reads to the parent model
 * as "nothing was found here", which is a different and much worse claim than
 * "the subagent did not finish".
 */
export function normalizeSubagentReport(raw: string, meta: SubagentReportMeta = {}): string {
  const text = (raw ?? '').trim();
  if (!text) {
    const ran = meta.iterations ?? 0;
    const calls = meta.toolCallCount ?? 0;
    return [
      '[subagent] The search subagent finished without writing a report.',
      `It ran ${ran} iteration(s) and made ${calls} tool call(s).`,
      'Treat this question as unanswered: search directly rather than assuming the',
      'absence of a report means the absence of code.',
    ].join('\n');
  }

  const capped = capToolResult(text, SUBAGENT_REPORT_TOKEN_BUDGET);
  if (!meta.timedOut) {
    return capped;
  }
  return [
    capped,
    '',
    `[subagent] Stopped at its ${meta.iterations ?? 0}-iteration budget before`,
    'concluding. The report above is partial — do not read silence as absence.',
  ].join('\n');
}

export interface SubagentOptions {
  signal?: AbortSignal;
  /** Override the child's budget. Tests use a tiny one; production never does. */
  maxIterations?: number;
  onProgress?: (update: string) => void;
}

export interface SubagentResult {
  report: string;
  iterations: number;
  timedOut: boolean;
  /** The child's own loop signals — counted separately, never folded into the parent's. */
  signals: TurnSignals;
}

/**
 * Run one nested search loop and return its report.
 *
 * The executor is passed in rather than built here: the caller owns the narrowed
 * instance, so this module stays free of both `vscode` and the tool registry.
 */
export async function runSubagent(
  client: LlmClient,
  executor: ToolExecutor,
  task: string,
  options: SubagentOptions = {}
): Promise<SubagentResult> {
  const question = (task ?? '').trim();
  if (!question) {
    return {
      report: JSON.stringify({ error: 'explore_codebase requires a non-empty task' }),
      iterations: 0,
      timedOut: false,
      signals: emptyTurnSignals(),
    };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: buildSubagentSystemPrompt() },
    { role: 'user', content: question },
  ];

  try {
    // No reviewDiff / reflection options: a read-only child produces no diff to
    // review, and its own loop guard is enough to end it.
    const outcome = await runAgenticChat(
      client,
      executor,
      messages,
      options.signal,
      options.maxIterations ?? SUBAGENT_MAX_ITERATIONS
    );

    const signals = outcome.signals ?? emptyTurnSignals();
    const timedOut = Boolean(outcome.reachedIterationLimit);
    return {
      report: normalizeSubagentReport(outcome.text ?? '', {
        timedOut,
        iterations: signals.iterations,
        toolCallCount: signals.toolCalls,
      }),
      iterations: signals.iterations,
      timedOut,
      signals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      report: `[subagent] The search subagent failed: ${message}. Search directly.`,
      iterations: 0,
      timedOut: false,
      signals: emptyTurnSignals(),
    };
  }
}

import { LlmClient } from './client';
import { LlmMessage, LlmTool, ToolCall, LlmAgenticResult } from './types';
import { ToolExecutor } from './tools';
import { logger } from '../services/logger';
import { DEFAULT_MAX_ITERATIONS } from '../shared/agenticLimits';

/**
 * User-turn appended as the final message when the model exhausts its
 * iteration budget mid-work or is halted due to a repetitive loop. It must STOP calling tools and write its final
 * reply: acknowledging the limit/loop, summarizing progress, and stating what
 * remains — the model knows the full conversation, so its wrap-up is far
 * richer than a synthesized error.
 */
function wrapUpInstruction(maxIterations: number, reason?: 'limit' | 'loop'): string {
  if (reason === 'loop') {
    return [
      '[repetitive loop detected] Repeated identical or redundant tool calls were detected and stopped.',
      'You may not call any more tools.',
      'Write your final reply to the user now: synthesize the information you have already gathered in this turn,',
      'answer the user request based on what has been retrieved so far, and state your conclusions.',
    ].join(' ');
  }
  return [
    `[iteration limit reached] You have used all ${maxIterations} iterations (model round-trips) allowed for this turn.`, // eslint-disable-line max-len
    'You may not call any more tools.',
    'Write your final reply to the user now: say that you have reached the maximum number of iterations for this turn,',
    'briefly summarize what you have accomplished so far, and state what is still left to do (or what you would do next if given more steps).',
  ].join(' ');
}

/** Deterministic conclusion used when the forced wrap-up round-trip fails or
 *  returns nothing usable — the turn still ends with a real chat message, and
 *  the count it reports is ITERATIONS (model round-trips), not tool calls. */
function fallbackLimitConclusion(maxIterations: number, executedCalls: ToolCall[], reason?: 'limit' | 'loop'): string {
  const calls = executedCalls.length;
  if (reason === 'loop') {
    return [
      `A repetitive tool loop was detected, so I stopped further tool execution to avoid wasting steps.`,
      calls > 0 ? `${calls} tool call${calls === 1 ? '' : 's'} ${calls === 1 ? 'was' : 'were'} executed.` : '',
      'Please see the findings retrieved above or specify a more targeted query.',
    ].filter(Boolean).join(' ');
  }
  return [
    `I've reached the maximum of ${maxIterations} iterations for this turn before the work was complete, so I'm stopping here.`,
    calls > 0 ? `${calls} tool call${calls === 1 ? '' : 's'} ${calls === 1 ? 'was' : 'were'} executed across those iterations.` : '',
    'Tell me to continue and I will pick up where I left off — or raise the Iteration budget',
    '(`adoCode.act.toolBudget` in Settings → ADO Code → Act) and ask again.',
  ].filter(Boolean).join(' ');
}

/**
 * Graceful end-of-turn when the model exhausts its iteration budget while
 * still requesting tools or when a repetitive loop is stopped. NOT an error: the user sees a concluding chat
 * message. One extra, NON-budgeted round-trip lets the model itself summarize
 * progress and what remains; if that wrap-up call fails, is aborted, or
 * returns nothing usable (empty, truncated, or tool calls only), fall back to
 * a deterministic conclusion. Tool calls in the wrap-up response are NEVER
 * executed — the budget is exhausted, so running more tools would defeat it.
 */
async function concludeAtIterationLimit(
  client: LlmClient,
  messages: LlmMessage[],
  tools: LlmTool[],
  signal: AbortSignal | undefined,
  maxIterations: number,
  executedCalls: ToolCall[],
  reason?: 'limit' | 'loop',
): Promise<LlmAgenticResult> {
  // The caller reconciles user-stopped turns itself — never spend a wrap-up
  // round-trip (or a deterministic message) after the user asked to stop.
  if (signal?.aborted) {
    throw new Error('agentic loop stopped before the concluding reply');
  }
  const withWrapUp: LlmMessage[] = [
    ...messages,
    { role: 'user', content: wrapUpInstruction(maxIterations, reason) },
  ];
  try {
    const { text, toolCalls, stopReason } = await client.chatWithTools(withWrapUp, tools, signal);
    const usable =
      text && text.trim().length > 0
      && (!toolCalls || toolCalls.length === 0)
      && stopReason !== 'length' && stopReason !== 'max_tokens';
    if (usable) {
      return {
        text: text.trim(),
        toolCalls: executedCalls,
        iterations: maxIterations,
        reachedIterationLimit: true,
        loopDetected: reason === 'loop',
      };
    }
    logger.warn('agentic: wrap-up response unusable (tool calls / empty / truncated) — using deterministic conclusion');
  } catch (err) {
    // User stop → let the host reconcile the stopped turn. Any other wrap-up
    // failure must not turn the whole turn into an error banner: the budget
    // was already consumed and the deterministic conclusion is accurate.
    if (signal?.aborted) throw err;
    logger.warn('agentic: wrap-up conclusion call failed — using deterministic conclusion', err);
  }
  return {
    text: fallbackLimitConclusion(maxIterations, executedCalls, reason),
    toolCalls: executedCalls,
    iterations: maxIterations,
    reachedIterationLimit: true,
    loopDetected: reason === 'loop',
  };
}

/** Maximum characters preserved in full when compacting older tool results. */
export const COMPACT_RETAIN_THRESHOLD = 800;

/**
 * Compact OLD tool results to save re-send cost on later loop iterations.
 *
 * A tool result pushed in iteration k is first CONSUMED by the model in
 * request k+1, so it must stay full until then. `protectFrom` is the index
 * into `messages` where the MOST RECENT iteration's messages begin — everything
 * at/after it (including its tool results) is kept full; tool results strictly
 * before it were consumed by an earlier request and can be stubbed.
 *
 * Tuning: To prevent amnesia that drives models into repetitive read loops,
 * short results (<= 800 chars, e.g. small file reads, status queries) are
 * retained in full, while larger results retain head (500 chars) and tail (150 chars).
 * Both formats preserve the `[tool result truncated ...` marker for downstream
 * compatibility while maintaining essential context.
 */
export function compactOldToolResults(messages: LlmMessage[], protectFrom: number): number {
  let count = 0;
  for (let i = 0; i < protectFrom && i < messages.length; i++) {
    const m = messages[i]!;
    if (
      m.role === 'tool'
      && typeof m.content === 'string'
      && !m.content.startsWith('[tool result truncated')
    ) {
      const original = m.content;
      if (original.length <= COMPACT_RETAIN_THRESHOLD) {
        m.content = `[tool result truncated — older output compacted to save context (retained below)]\n${original}`;
      } else {
        const head = original.slice(0, 500);
        const tail = original.slice(-150);
        const omitted = original.length - (head.length + tail.length);
        m.content = `[tool result truncated — older output compacted to save context (${omitted} chars omitted)]\n${head}\n\n… [${omitted} characters omitted to save tokens; head and tail preserved] …\n\n${tail}`;
      }
      count++;
    }
  }
  return count;
}

/**
 * Live progress updates emitted by the agentic loop while the model thinks
 * and executes tools. The host relays these to the chat webview so the user
 * sees something happening instead of a silent "Thinking…" until the end.
 */
export interface AgenticProgressUpdate {
  /** Assistant text for this iteration.
   *  When `final` is true this IS the terminal answer (no further tools) —
   *  the host renders it as the reply, not as thinking. */
  text?: string;
  final?: boolean;
  /** A user steering message injected into this iteration. The user typed it
   *  while the run was in flight and chose "steer", so it is appended as a
   *  `user` turn for the NEXT round-trip instead of aborting the run. */
  steering?: string;
  /** A tool is about to execute — hosts show a "running" tool card. */
  tool?: { id: string; name: string; args: Record<string, any> };
  /** A previously-started tool finished — hosts flip its card to completed. */
  toolResult?: { id: string; name: string; content: string };
}

/**
 * Result of checking a tool call for loops / repetitive execution.
 */
export interface LoopCheckResult {
  action: 'allow' | 'warn' | 'block';
  warning?: string;
  message?: string;
}

/** Tool names considered read-only exploration operations. */
export const READ_ONLY_TOOL_NAMES = new Set([
  'get_work_items',
  'get_work_item',
  'read_file',
  'search_files',
  'get_selection',
  'list_workspace',
  'read_workspace_memory',
  'list_workspace_memory',
  'execute_skill',
  'resolve_pr_conflicts',
]);

/**
 * Tracks tool call history during an agentic session to detect and break
 * degenerate loops (identical repeat calls, oscillating reads of identical ranges).
 */
export class ToolLoopDetector {
  /** Map from call signature to total occurrence count in the session. */
  private readonly callCounts = new Map<string, number>();

  /** Map from normalized file path to array of ranges read. */
  private readonly readHistory = new Map<string, Array<{ startLine?: number; endLine?: number; iteration: number }>>();

  /** Number of consecutive iterations where all tool calls were blocked. */
  private consecutiveBlockedIterations = 0;

  /** Consecutive iterations consisting solely of read-only exploration tools. */
  private consecutiveReadIterations = 0;

  /** Number of identical calls before warning (2) and before blocking (3). */
  public readonly repeatWarningThreshold = 2;
  public readonly repeatBlockThreshold = 3;

  /** Consecutive iterations of all blocked calls before circuit breaker fires. */
  public readonly circuitBreakerThreshold = 2;

  /** Consecutive read-only iterations before synthesis nudge is injected. */
  public readonly readSynthesisThreshold = 5;

  /**
   * Normalize a tool call into a stable signature string.
   */
  public getSignature(name: string, args: Record<string, any>): string {
    const norm: Record<string, any> = {};
    for (const key of Object.keys(args || {}).sort()) {
      let val = args[key];
      if (typeof val === 'string') {
        val = val.trim();
        if (key === 'path' || key === 'file_pattern') {
          val = val.replace(/\\/g, '/').toLowerCase();
        }
      }
      norm[key] = val;
    }
    return `${name}:${JSON.stringify(norm)}`;
  }

  /**
   * Inspect a tool call before execution.
   */
  public checkCall(
    name: string,
    args: Record<string, any>,
    iteration: number
  ): LoopCheckResult {
    const signature = this.getSignature(name, args);
    const count = (this.callCounts.get(signature) ?? 0) + 1;
    this.callCounts.set(signature, count);

    // 1. Exact identical call check:
    // count = 1, 2: allow
    // count = 3: warn
    // count >= 4: block
    if (count > this.repeatBlockThreshold) {
      return {
        action: 'block',
        message: `[loop detected — call blocked] Tool "${name}" has already been executed ${count - 1} times with identical arguments in this turn. The results are already available in your conversation context. Do not repeat this call. Proceed to synthesize your findings and conclude or take a different next step.`,
      };
    }

    if (count === this.repeatBlockThreshold) {
      return {
        action: 'warn',
        warning: `[loop warning] You have called "${name}" with these exact arguments ${count} times in this turn. Avoid repetitive calls; synthesize what you have already retrieved.`,
      };
    }

    // 2. Overlapping read_file detection on the same file
    if (name === 'read_file' && typeof args.path === 'string') {
      const normPath = args.path.replace(/\\/g, '/').toLowerCase();
      const start = typeof args.startLine === 'number' ? args.startLine : 1;
      const end = typeof args.endLine === 'number' ? args.endLine : 200;

      const history = this.readHistory.get(normPath) ?? [];
      let overlappingReads = 0;
      for (const prior of history) {
        const pStart = prior.startLine ?? 1;
        const pEnd = prior.endLine ?? 200;
        const overlapStart = Math.max(start, pStart);
        const overlapEnd = Math.min(end, pEnd);
        if (overlapEnd >= overlapStart) {
          const overlap = overlapEnd - overlapStart + 1;
          const rangeLen = Math.max(1, end - start + 1);
          if (overlap >= 5 || overlap / rangeLen >= 0.4) {
            overlappingReads++;
          }
        }
      }
      history.push({ startLine: args.startLine, endLine: args.endLine, iteration });
      this.readHistory.set(normPath, history);

      if (overlappingReads >= 3) {
        return {
          action: 'block',
          message: `[loop detected — repeated read blocked] You have read this section of "${args.path}" ${overlappingReads + 1} times in this turn. All relevant content has already been retrieved. Synthesize what you have and conclude your response.`,
        };
      }
      if (overlappingReads === 2) {
        return {
          action: 'warn',
          warning: `[loop warning] You have read this section of "${args.path}" 3 times in this turn. Avoid re-reading the same lines.`,
        };
      }
    }

    return { action: 'allow' };
  }

  /**
   * Record whether this iteration had all calls blocked.
   * Returns true if circuit breaker should trip.
   */
  public recordIterationResult(allCallsBlocked: boolean): boolean {
    if (allCallsBlocked) {
      this.consecutiveBlockedIterations++;
    } else {
      this.consecutiveBlockedIterations = 0;
    }
    return this.consecutiveBlockedIterations >= this.circuitBreakerThreshold;
  }

  /**
   * Record whether an iteration was purely exploratory (all executed calls were read-only).
   * Returns a synthesis guidance notice when consecutive read iterations reach threshold (5+).
   */
  public recordReadIteration(isReadIteration: boolean): string | undefined {
    if (isReadIteration) {
      this.consecutiveReadIterations++;
      if (this.consecutiveReadIterations >= this.readSynthesisThreshold) {
        return `[exploration notice] You have performed ${this.consecutiveReadIterations} consecutive read/search steps without taking action. If you have gathered sufficient context to answer the user's request, please synthesize your findings now and conclude or proceed to action.`;
      }
    } else {
      this.consecutiveReadIterations = 0;
    }
    return undefined;
  }
}

/**
 * Agentic tool loop. One ITERATION = one model round-trip (`chatWithTools`);
 * a single round-trip may request a batch of parallel tool calls, and the
 * whole batch still costs ONE iteration (the iteration budget is NOT a
 * tool-call budget). The loop ends when the model replies without tools, or —
 * if it exhausts `maxIterations` while still requesting tools — with a forced
 * concluding reply (`result.reachedIterationLimit === true`) instead of
 * throwing, so the user always gets a real chat conclusion.
 */
export async function runAgenticChat(
  client: LlmClient,
  executor: ToolExecutor,
  initialMessages: LlmMessage[],
  signal?: AbortSignal,
  maxIterations: number = DEFAULT_MAX_ITERATIONS,
  onProgress?: (update: AgenticProgressUpdate) => void,
  // Optional: drains user messages typed while the run is in flight, to be
  // injected as `user` turns on the next iteration (see the steer behavior).
  options?: { drainSteering?: () => string[] }
): Promise<LlmAgenticResult> {
  const messages = [...initialMessages];
  const allToolCalls: ToolCall[] = [];
  const loopDetector = new ToolLoopDetector();
  // Index into `messages` where the most recent iteration's messages begin.
  // Tool results strictly before it were consumed by an earlier request and
  // can be stubbed to save re-send cost (see compactOldToolResults).
  let protectFrom = initialMessages.length;

  for (let i = 0; i < maxIterations; i++) {
    // Steering: user messages typed while this run was in flight are drained
    // at the top of every iteration and appended as a `user` turn, so the
    // model sees them on its NEXT round-trip. This deliberately does NOT abort
    // the in-flight request — "steer" nudges the running turn rather than
    // cancelling it.
    for (const steerText of options?.drainSteering?.() ?? []) {
      messages.push({ role: 'user', content: steerText });
      onProgress?.({ steering: steerText });
    }
    // Token optimization: stub tool results older than the last iteration
    // (they've already been consumed by the model) before sending this request.
    const stubbed = compactOldToolResults(messages, protectFrom);
    if (stubbed > 0) logger.debug(`agentic: compacted ${stubbed} older tool result(s) to save context`);

    const { text, toolCalls, stopReason } = await client.chatWithTools(messages, executor.tools, signal);
    // Surface the iteration's reasoning/thinking text (if any) — the loop
    // otherwise stays silent until the final result. `final` marks the
    // terminal answer (no further tools), which the host renders as the
    // reply rather than as thinking text.
    if (text) onProgress?.({ text, final: !toolCalls || toolCalls.length === 0 });

    if (!toolCalls || toolCalls.length === 0) {
      return { text, toolCalls: allToolCalls, iterations: i + 1 };
    }

    allToolCalls.push(...toolCalls);

    // C1 fix: the assistant message MUST carry the tool_calls so the provider
    // can emit its native tool_calls / tool_use block in the next request.
    // (OpenAI 400s if a role:'tool' message has no preceding tool_calls;
    // Anthropic 400s if tool_result's tool_use_id has no matching block.)
    messages.push({
      role: 'assistant',
      content: text || '',
      toolCalls: toolCalls.map((c: ToolCall) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) })),
    });

    // Truncated-response guard (pi parity): 'length'/'max_tokens' means the
    // model hit its output limit, so streamed/salvaged tool-call
    // arguments may be silently incomplete. NONE of them are safe to execute
    // — fail the whole batch; the model re-issues with complete arguments.
    if (stopReason === 'length' || stopReason === 'max_tokens') {
      for (const call of toolCalls) {
        logger.warn(`agentic: response hit output limit (stopReason=${stopReason}); NOT executing tool ${call.name}`);
        const content = JSON.stringify({
          error: `tool call "${call.name}" was NOT executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
        });
        onProgress?.({ toolResult: { id: call.id, name: call.name, content } });
        messages.push({ role: 'tool', content, toolCallId: call.id });
      }
      // Set protectFrom for the NEXT iteration = start of THIS iteration's
      // new messages (assistant tool_calls + failed tool results).
      protectFrom = messages.length - (toolCalls.length + 1);
      continue;
    }

    // C1 fix: ONE tool message per result, each carrying its own toolCallId
    // (OpenAI requires one role:'tool' message per tool_call_id).
    //
    // pi-parity parallel execution: calls that run WITHOUT user interaction
    // (read-only / yolo / auto-approved / allowlisted) execute concurrently,
    // while calls that need a consent card run sequentially — approval
    // prompts appear one at a time, never stacked modals. The two groups run
    // in PARALLEL with each other, so a mixed batch no longer serializes
    // read-only work behind a consent prompt. Results are re-ordered back to
    // the original call order below (keeps tool_call_id references valid and
    // conversation ordering deterministic).
    const autoCalls: ToolCall[] = [];
    const promptCalls: ToolCall[] = [];
    const resultsByCall = new Map<string, string>();
    const warningsByCall = new Map<string, string>();

    let blockedCount = 0;

    for (const call of toolCalls) {
      const check = loopDetector.checkCall(call.name, call.arguments, i + 1);
      if (check.action === 'block') {
        blockedCount++;
        logger.warn(`agentic: loop detected: blocked tool [${call.name}] on iteration ${i + 1}`);
        resultsByCall.set(call.id, check.message ?? 'tool call blocked: repeated call');
      } else {
        if (check.action === 'warn' && check.warning) {
          warningsByCall.set(call.id, check.warning);
        }
        (executor.canAutoExecute(call.name, call.arguments) ? autoCalls : promptCalls).push(call);
      }
    }

    const logResult = (call: ToolCall, content: string) => {
      const resultPreview = content.length > 200 ? content.slice(0, 200) + '…' : content;
      logger.info(`Tool result [${call.name}]: ${resultPreview}`);
    };

    const executeOne = async (call: ToolCall): Promise<string> => {
      const argsSummary = Object.keys(call.arguments).length > 0
        ? JSON.stringify(call.arguments)
        : '(no args)';
      // Iteration budget is counted in model round-trips, so a tool inside a
      // batch reports the ITERATION it belongs to, not a per-tool counter.
      logger.info(`Tool call [iteration ${i + 1}/${maxIterations}]: ${call.name} ${argsSummary}`);
      // Live "running" tool card in the chat (plus status-bar detail).
      onProgress?.({ tool: { id: call.id, name: call.name, args: call.arguments } });
      try {
        let content = await executor.execute(call.name, call.arguments);
        const warning = warningsByCall.get(call.id);
        if (warning) {
          content = `${warning}\n\n${content}`;
        }
        logResult(call, content);
        return content;
      } catch (err) {
        const content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        logger.error(`Tool error [${call.name}]: ${content}`);
        return content;
      }
    };

    // One model round-trip may execute a BATCH of parallel tool calls — that
    // whole batch is a SINGLE iteration, not one per call (pi parity).
    if (toolCalls.length > 1) {
      logger.debug(
        `agentic: iteration ${i + 1}/${maxIterations} executes a batch of ${toolCalls.length} tool call(s) `
        + `(${autoCalls.length} auto + ${promptCalls.length} consent-gated) — counts as ONE iteration`
      );
    }
    await Promise.all([
      // Consent-requiring calls: strictly sequential — one approval card at a
      // time. Each is wrapped in its own try/catch inside executeOne.
      (async () => {
        for (const call of promptCalls) {
          resultsByCall.set(call.id, await executeOne(call));
          if (signal?.aborted) break;
        }
      })(),
      // Auto-executable calls: concurrent. Each execute() is wrapped in its
      // own try/catch so one failure can't kill the batch; results are
      // re-ordered back to call order below.
      (async () => {
        const groupResults = await Promise.all(autoCalls.map(call => executeOne(call)));
        for (let k = 0; k < autoCalls.length; k++) {
          resultsByCall.set(autoCalls[k]!.id, groupResults[k]!);
        }
      })(),
    ]);

    // Exploration synthesis nudge: after 5+ consecutive read-only iterations,
    // nudge the model to synthesize findings rather than endlessly reading files.
    const isReadIteration = toolCalls.length > 0 && toolCalls.every(c => READ_ONLY_TOOL_NAMES.has(c.name));
    const synthesisNudge = loopDetector.recordReadIteration(isReadIteration);
    if (synthesisNudge) {
      logger.info(`agentic: exploration synthesis nudge triggered at iteration ${i + 1}`);
      const lastCall = toolCalls[toolCalls.length - 1];
      if (lastCall) {
        const existing = resultsByCall.get(lastCall.id) ?? '';
        resultsByCall.set(lastCall.id, `${existing}\n\n${synthesisNudge}`);
      }
    }

    // Push tool messages in ORIGINAL call order. Calls skipped by an abort
    // have no result and are not pushed (the aborted turn won't send another
    // request anyway).
    for (const call of toolCalls) {
      const content = resultsByCall.get(call.id);
      if (content === undefined) continue;
      // Flip the card to "completed" with the result.
      onProgress?.({ toolResult: { id: call.id, name: call.name, content } });
      messages.push({ role: 'tool', content, toolCallId: call.id });
    }

    // Set protectFrom for the NEXT iteration = start of THIS iteration's new
    // messages (its assistant tool_calls + the tool results we just pushed).
    protectFrom = messages.length - (resultsByCall.size + 1);

    // Circuit breaker: if consecutive iterations had ALL tool calls blocked by loop detector
    const allBlocked = toolCalls.length > 0 && blockedCount === toolCalls.length;
    const tripCircuitBreaker = loopDetector.recordIterationResult(allBlocked);
    if (tripCircuitBreaker) {
      logger.warn(
        `agentic: breaking out of degenerate loop at iteration ${i + 1}/${maxIterations} after consecutive blocked iterations — forcing concluding reply`
      );
      return concludeAtIterationLimit(client, messages, executor.tools, signal, i + 1, allToolCalls, 'loop');
    }
  }

  // The model spent its whole iteration budget still asking for tools. Do NOT
  // throw here (the caller would surface a bare error banner): the turn ends
  // with a proper concluding chat message instead (see concludeAtIterationLimit).
  logger.warn(
    `agentic: exhausted ${maxIterations} iteration(s) after ${allToolCalls.length} tool call(s) — forcing a concluding reply`
  );
  return concludeAtIterationLimit(client, messages, executor.tools, signal, maxIterations, allToolCalls);
}
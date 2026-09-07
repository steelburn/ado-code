import { LlmClient } from './client';
import { LlmMessage, LlmTool, ToolCall, LlmAgenticResult } from './types';
import { ToolExecutor } from './tools';
import { logger } from '../services/logger';
import { DEFAULT_MAX_ITERATIONS } from '../shared/agenticLimits';

/**
 * User-turn appended as the final message when the model exhausts its
 * iteration budget mid-work. It must STOP calling tools and write its final
 * reply: acknowledging the limit, summarizing progress, and stating what
 * remains — the model knows the full conversation, so its wrap-up is far
 * richer than a synthesized error.
 */
function wrapUpInstruction(maxIterations: number): string {
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
function fallbackLimitConclusion(maxIterations: number, executedCalls: ToolCall[]): string {
  const calls = executedCalls.length;
  return [
    `I've reached the maximum of ${maxIterations} iterations for this turn before the work was complete, so I'm stopping here.`,
    calls > 0 ? `${calls} tool call${calls === 1 ? '' : 's'} ${calls === 1 ? 'was' : 'were'} executed across those iterations.` : '',
    'Tell me to continue and I will pick up where I left off — or raise the Iteration budget',
    '(`adoCode.act.toolBudget` in Settings → ADO Code → Act) and ask again.',
  ].filter(Boolean).join(' ');
}

/**
 * Graceful end-of-turn when the model exhausts its iteration budget while
 * still requesting tools. NOT an error: the user sees a concluding chat
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
): Promise<LlmAgenticResult> {
  // The caller reconciles user-stopped turns itself — never spend a wrap-up
  // round-trip (or a deterministic message) after the user asked to stop.
  if (signal?.aborted) {
    throw new Error('agentic loop stopped before the concluding reply');
  }
  const withWrapUp: LlmMessage[] = [
    ...messages,
    { role: 'user', content: wrapUpInstruction(maxIterations) },
  ];
  try {
    const { text, toolCalls, stopReason } = await client.chatWithTools(withWrapUp, tools, signal);
    const usable =
      text && text.trim().length > 0
      && (!toolCalls || toolCalls.length === 0)
      && stopReason !== 'length' && stopReason !== 'max_tokens';
    if (usable) {
      return { text: text.trim(), toolCalls: executedCalls, iterations: maxIterations, reachedIterationLimit: true };
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
    text: fallbackLimitConclusion(maxIterations, executedCalls),
    toolCalls: executedCalls,
    iterations: maxIterations,
    reachedIterationLimit: true,
  };
}

/**
 * Compact OLD tool results to save re-send cost on later loop iterations.
 *
 * A tool result pushed in iteration k is first CONSUMED by the model in
 * request k+1, so it must stay full until then. `protectFrom` is the index
 * into `messages` where the MOST RECENT iteration's messages begin — everything
 * at/after it (including its tool results) is kept full; tool results strictly
 * before it were consumed by an earlier request and can be stubbed. The stub
 * keeps the message (so tool_call_id / tool_use_id referencing stays valid for
 * OpenAI and Anthropic — C1) but drops the payload.
 */
function compactOldToolResults(messages: LlmMessage[], protectFrom: number): number {
  let count = 0;
  for (let i = 0; i < protectFrom && i < messages.length; i++) {
    const m = messages[i]!;
    if (
      m.role === 'tool'
      && typeof m.content === 'string'
      && !m.content.startsWith('[tool result truncated')
    ) {
      m.content = '[tool result truncated — full output dropped after model has seen it (token optimization)]';
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
  /** A tool is about to execute — hosts show a "running" tool card. */
  tool?: { id: string; name: string; args: Record<string, any> };
  /** A previously-started tool finished — hosts flip its card to completed. */
  toolResult?: { id: string; name: string; content: string };
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
  onProgress?: (update: AgenticProgressUpdate) => void
): Promise<LlmAgenticResult> {
  const messages = [...initialMessages];
  const allToolCalls: ToolCall[] = [];
  // Index into `messages` where the most recent iteration's messages begin.
  // Tool results strictly before it were consumed by an earlier request and
  // can be stubbed to save re-send cost (see compactOldToolResults).
  let protectFrom = initialMessages.length;

  for (let i = 0; i < maxIterations; i++) {
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
    // model hit its output token limit, so streamed/salvaged tool-call
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
    for (const call of toolCalls) {
      (executor.canAutoExecute(call.name, call.arguments) ? autoCalls : promptCalls).push(call);
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
        const content = await executor.execute(call.name, call.arguments);
        logResult(call, content);
        return content;
      } catch (err) {
        const content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        logger.error(`Tool error [${call.name}]: ${content}`);
        return content;
      }
    };

    const resultsByCall = new Map<string, string>();
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
  }

  // The model spent its whole iteration budget still asking for tools. Do NOT
  // throw here (the caller would surface a bare error banner): the turn ends
  // with a proper concluding chat message instead (see concludeAtIterationLimit).
  logger.warn(
    `agentic: exhausted ${maxIterations} iteration(s) after ${allToolCalls.length} tool call(s) — forcing a concluding reply`
  );
  return concludeAtIterationLimit(client, messages, executor.tools, signal, maxIterations, allToolCalls);
}
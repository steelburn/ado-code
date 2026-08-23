import { LlmClient } from './client';
import { LlmMessage, ToolCall, LlmAgenticResult } from './types';
import { ToolExecutor } from './tools';
import { logger } from '../services/logger';
import { DEFAULT_MAX_ITERATIONS } from '../shared/agenticLimits';

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
    // pi-parity parallel execution: if every call in the batch runs WITHOUT
    // user interaction (read-only / yolo / auto-approved / allowlisted), run
    // them concurrently and re-order results back to call order. If any call
    // needs a consent card, the whole batch runs sequentially so approval
    // prompts appear one at a time — never stacked modals.
    const batchIsSequential = toolCalls.some(call => !executor.canAutoExecute(call.name, call.arguments));
    const logResult = (call: ToolCall, content: string) => {
      const resultPreview = content.length > 200 ? content.slice(0, 200) + '…' : content;
      logger.info(`Tool result [${call.name}]: ${resultPreview}`);
    };

    const executeOne = async (call: ToolCall): Promise<string> => {
      const argsSummary = Object.keys(call.arguments).length > 0
        ? JSON.stringify(call.arguments)
        : '(no args)';
      logger.info(`Tool call [${i + 1}/${maxIterations}]: ${call.name} ${argsSummary}`);
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

    let results: string[];
    if (batchIsSequential) {
      results = [];
      for (const call of toolCalls) {
        results.push(await executeOne(call));
        if (signal?.aborted) break;
      }
    } else {
      // Concurrent: all calls start together; results re-ordered below to
      // match the original call order (keeps tool_call_id references valid
      // and conversation ordering deterministic). Each execute() is wrapped
      // in its own try/catch so one failure can't kill the batch.
      results = await Promise.all(toolCalls.map(call => executeOne(call)));
    }

    for (let k = 0; k < toolCalls.length && k < results.length; k++) {
      const call = toolCalls[k];
      // Flip the card to "completed" with the result.
      onProgress?.({ toolResult: { id: call.id, name: call.name, content: results[k] } });
      messages.push({ role: 'tool', content: results[k], toolCallId: call.id });
    }

    // Set protectFrom for the NEXT iteration = start of THIS iteration's new
    // messages (its assistant tool_calls + the tool results we just pushed).
    protectFrom = messages.length - (toolCalls.length + 1);
  }

  throw new Error(`agentic loop exceeded ${maxIterations} iterations`);
}
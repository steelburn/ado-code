import { LlmClient } from './client';
import { LlmMessage, LlmTool, ToolCall, LlmAgenticResult } from './types';
import { ToolExecutor } from './tools';
import { logger } from '../services/logger';

const DEFAULT_MAX_ITERATIONS = 8;

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

    const { text, toolCalls } = await client.chatWithTools(messages, executor.tools, signal);
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

    // C1 fix: ONE tool message per result, each carrying its own toolCallId
    // (OpenAI requires one role:'tool' message per tool_call_id).
    for (const call of toolCalls) {
      // Log every tool call with name, args, and iteration number.
      const argsSummary = Object.keys(call.arguments).length > 0
        ? JSON.stringify(call.arguments)
        : '(no args)';
      logger.info(`Tool call [${i + 1}/${maxIterations}]: ${call.name} ${argsSummary}`);

      // Live "running" tool card in the chat (plus status-bar detail).
      onProgress?.({ tool: { id: call.id, name: call.name, args: call.arguments } });
      let content: string;
      try {
        content = await executor.execute(call.name, call.arguments);
        // Log the result (truncated to keep output readable).
        const resultPreview = content.length > 200 ? content.slice(0, 200) + '…' : content;
        logger.info(`Tool result [${call.name}]: ${resultPreview}`);
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        logger.error(`Tool error [${call.name}]: ${content}`);
      }
      // Flip the card to "completed" with the result.
      onProgress?.({ toolResult: { id: call.id, name: call.name, content } });
      messages.push({ role: 'tool', content, toolCallId: call.id });
    }

    // Set protectFrom for the NEXT iteration = start of THIS iteration's new
    // messages (its assistant tool_calls + the tool results we just pushed).
    protectFrom = messages.length - (toolCalls.length + 1);
  }

  throw new Error(`agentic loop exceeded ${maxIterations} iterations`);
}
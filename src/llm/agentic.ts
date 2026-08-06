import { LlmClient } from './client';
import { LlmMessage, LlmTool, ToolCall, LlmAgenticResult } from './types';
import { ToolExecutor } from './tools';

const DEFAULT_MAX_ITERATIONS = 8;

export async function runAgenticChat(
  client: LlmClient,
  executor: ToolExecutor,
  initialMessages: LlmMessage[],
  signal?: AbortSignal,
  maxIterations: number = DEFAULT_MAX_ITERATIONS,
  onProgress?: (update: { text?: string; tool?: { name: string; args: Record<string, any> } }) => void
): Promise<LlmAgenticResult> {
  const messages = [...initialMessages];
  const allToolCalls: ToolCall[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const { text, toolCalls } = await client.chatWithTools(messages, executor.tools, signal);
    // Surface the iteration's thinking text (if any) — the loop otherwise
    // stays silent until the final result.
    if (text) onProgress?.({ text });

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
      // Let the host surface what the AI is doing (status-bar detail).
      onProgress?.({ tool: { name: call.name, args: call.arguments } });
      let content: string;
      try {
        content = await executor.execute(call.name, call.arguments);
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      messages.push({ role: 'tool', content, toolCallId: call.id });
    }
  }

  throw new Error(`agentic loop exceeded ${maxIterations} iterations`);
}

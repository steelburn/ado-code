import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider, LlmTool, ToolCall } from '../types';

export class OpenAiProvider implements LlmProvider {
  async *streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    const response = await fetch(`${config.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        // Robust SSE: trim CRLF and match `data:` with optional space
        // (Azure OpenAI sends `data:{...}` with no space).
        const line = rawLine.trim();
        const match = line.match(/^data: ?(.*)$/);
        if (match) {
          const data = match[1];
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              yield { content, done: false };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  }

  /** C1: tool-calling round-trip (non-streaming — simplest correct shape). */
  async chatWithTools(messages: LlmMessage[], config: LlmConfig, tools: LlmTool[], signal?: AbortSignal): Promise<{ text: string; toolCalls: ToolCall[] }> {
    // Translate generic messages → OpenAI native shapes:
    // - role:'tool' + toolCallId → { role:'tool', tool_call_id, content }
    // - role:'assistant' + toolCalls → tool_calls array (arguments as JSON string)
    const nativeMessages = messages.map(m => {
      if (m.role === 'tool' && m.toolCallId) {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

    const response = await fetch(`${config.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: config.model,
        messages: nativeMessages,
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }

    const parsed = (await response.json()) as any;
    const message = parsed.choices?.[0]?.message;
    const text = message?.content || '';
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: JSON.parse(tc.function?.arguments ?? '{}'),
    }));
    return { text, toolCalls };
  }
}

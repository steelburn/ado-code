import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider } from '../types';

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
}

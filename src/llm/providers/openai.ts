import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider, LlmTool, ToolCall } from '../types';
import type { ContentBlockParam } from './BaseProvider';
import { toModelInfo, ModelInfo } from '../modelCapabilities';

export class OpenAiProvider implements LlmProvider {
  async *streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    const openaiMessages = messages
      .filter(m => m.role !== 'tool')
      .map(m => ({ role: m.role, content: convertContent(m.content) }));

    const response = await fetch(`${config.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: config.model,
        messages: openaiMessages,
        stream: true,
        // Add reasoning_effort for reasoning models (o1, o3, o4-mini, etc.)
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
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
            // Reasoning/thinking content (o1, o3, and other reasoning models)
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || '';
            if (reasoning) {
              yield { content: '', done: false, thinking: reasoning };
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
          content: convertContent(m.content),
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role, content: convertContent(m.content) };
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
      // Defensive: some gateways emit `arguments: ""` (empty string) at the
      // token limit — JSON.parse('') throws. Fall back to {} for anything
      // unparseable.
      arguments: parseToolArguments(tc.function?.arguments),
    }));
    return { text, toolCalls };
  }

  async listModels(config: LlmConfig): Promise<ModelInfo[]> {
    return listModelsOpenAi(config);
  }
}

/** Robust tool-arguments parse: empty/unparseable → {} instead of throwing. */
function parseToolArguments(raw: unknown): Record<string, any> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Convert ContentBlockParam[] to OpenAI content format (string or array of parts). */
function convertContent(
  content: string | ContentBlockParam[],
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') {
    return content;
  }
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const { source } = block;
      let url: string | undefined;
      if (source.type === 'base64' && source.data) {
        url = `data:${source.media_type};base64,${source.data}`;
      } else if (source.type === 'url' && source.url) {
        url = source.url;
      }
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
  }
  // If only text parts, collapse to string for simpler API calls
  if (parts.every(p => p.type === 'text')) {
    return parts.map(p => p.text).join('\n');
  }
  return parts;
}

/** Model ids (+ capability hints when the gateway exposes them) via the standard OpenAI-compatible GET /models endpoint. */
export async function listModelsOpenAi(config: LlmConfig): Promise<ModelInfo[]> {
  const response = await fetch(`${config.apiUrl.replace(/\/+$/, '')}/models`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
  }
  const parsed = (await response.json()) as { data?: unknown[] };
  return (parsed.data ?? []).map(m => toModelInfo(m)).filter((m): m is ModelInfo => m !== null);
}

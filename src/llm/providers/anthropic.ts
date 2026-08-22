import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider, LlmTool, ToolCall } from '../types';
import type { ContentBlockParam } from './BaseProvider';
import { toModelInfo, ModelInfo } from '../modelCapabilities';

export class AnthropicProvider implements LlmProvider {
  async *streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    // Anthropic uses a separate system prompt, not in messages array
    const systemMessage = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Convert to Anthropic format; the Messages API REQUIRES strictly
    // alternating user/assistant roles, so merge consecutive same-role turns.
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlockParam[] }> = [];
    for (const m of nonSystemMessages) {
      const role = m.role as 'user' | 'assistant';
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === role) {
        if (typeof last.content === 'string' && typeof m.content === 'string') {
          last.content += '\n\n' + m.content;
        } else {
          const lastBlocks = typeof last.content === 'string'
            ? [{ type: 'text' as const, text: last.content }]
            : last.content;
          const newBlocks = typeof m.content === 'string'
            ? [{ type: 'text' as const, text: m.content }]
            : m.content;
          last.content = [...lastBlocks, ...newBlocks];
        }
      } else {
        anthropicMessages.push({ role, content: m.content });
      }
    }

    // Normalize base URL: accept https://api.anthropic.com OR .../v1
    const baseUrl = config.apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

    const body: Record<string, any> = {
      model: config.model,
      max_tokens: 4096,
      messages: anthropicMessages,
      stream: true,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let inThinkingBlock = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
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
            if (parsed.type === 'content_block_start') {
              // Claude extended thinking — thinking block started
              if (parsed.content_block?.type === 'thinking') {
                inThinkingBlock = true;
              }
            } else if (parsed.type === 'content_block_stop') {
              inThinkingBlock = false;
            } else if (parsed.type === 'content_block_delta') {
              if (inThinkingBlock && parsed.delta?.type === 'thinking_delta') {
                // Claude extended thinking content
                const thinking = parsed.delta?.thinking || '';
                if (thinking) {
                  yield { content: '', done: false, thinking };
                }
              } else {
                const content = parsed.delta?.text || '';
                if (content) {
                  yield { content, done: false };
                }
              }
            } else if (parsed.type === 'message_stop') {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  }

  /** C1: tool-calling round-trip (non-streaming). C-7: merge consecutive tool_result messages. */
  async chatWithTools(messages: LlmMessage[], config: LlmConfig, tools: LlmTool[], signal?: AbortSignal): Promise<{ text: string; toolCalls: ToolCall[]; stopReason?: string }> {
    const systemMessage = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Translate generic messages → Anthropic native shapes:
    // - role:'tool' + toolCallId → a `user` message with a tool_result block
    // - role:'assistant' + toolCalls → text + tool_use blocks
    // C-7: merge CONSECUTIVE translated user/tool_result messages into ONE user
    // message whose content array holds all blocks (Anthropic 400s on
    // consecutive same-role messages; never string-concat the blocks).
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: any }> = [];
    for (const m of nonSystemMessages) {
      if (m.role === 'tool' && m.toolCallId) {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        const last = anthropicMessages[anthropicMessages.length - 1];
        if (last && last.role === 'user') {
          last.content = last.content.concat([block]);
        } else {
          anthropicMessages.push({ role: 'user', content: [block] });
        }
        continue;
      }
      const role = m.role as 'user' | 'assistant';
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const content: any[] = [{ type: 'text', text: m.content }];
        for (const tc of m.toolCalls) {
          // Defensive: toolCalls.arguments is a JSON string; empty/unparseable
          // must not throw (some gateways emit "" at the token limit).
          let input: any = {};
          if (typeof tc.arguments === 'string' && tc.arguments.trim() !== '') {
            try { input = JSON.parse(tc.arguments); } catch { input = {}; }
          }
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        anthropicMessages.push({ role, content });
        continue;
      }
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === role) {
        if (typeof last.content === 'string' && typeof m.content === 'string') {
          last.content += '\n\n' + m.content;
        } else {
          const lastBlocks = typeof last.content === 'string'
            ? [{ type: 'text' as const, text: last.content }]
            : (Array.isArray(last.content) ? last.content : [last.content]);
          const newBlocks = typeof m.content === 'string'
            ? [{ type: 'text' as const, text: m.content }]
            : (Array.isArray(m.content) ? m.content : [m.content]);
          last.content = [...lastBlocks, ...newBlocks];
        }
      } else {
        anthropicMessages.push({ role, content: m.content });
      }
    }

    // Anthropic requires the first message to be `user` — drop a leading
    // assistant-only turn if present.
    while (anthropicMessages.length > 0 && anthropicMessages[0].role === 'assistant') {
      anthropicMessages.shift();
    }

    const baseUrl = config.apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const body: Record<string, any> = {
      model: config.model,
      max_tokens: 4096,
      messages: anthropicMessages,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    };
    if (systemMessage) {
      body.system = systemMessage.content;
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }

    const parsed = (await response.json()) as any;
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of parsed.content ?? []) {
      if (block.type === 'text') text += block.text ?? '';
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
    }
    // stop_reason 'max_tokens' = output hit the limit; the agentic loop fails
    // every tool call instead of executing possibly truncated args (pi parity).
    return { text, toolCalls, stopReason: parsed.stop_reason ?? undefined };
  }

  async listModels(config: LlmConfig): Promise<ModelInfo[]> {
    return listModelsAnthropic(config);
  }

  /**
   * Native token count via Anthropic's /v1/messages/count_tokens endpoint
   * (free, first-class). Returns `undefined` on any failure so callers fall
   * back to the local heuristic. Counts the system prompt + messages exactly
   * as the API would bill them.
   */
  async countTokens(messages: LlmMessage[], config: LlmConfig): Promise<number | undefined> {
    try {
      const systemMessage = messages.find(m => m.role === 'system');
      const nonSystem = messages.filter(m => m.role !== 'system');
      // Merge consecutive same-role messages — same shape the API requires
      // (and that streamChat sends).
      const convo: Array<{ role: 'user' | 'assistant'; content: string | ContentBlockParam[] }> = [];
      for (const m of nonSystem) {
        const role = m.role as 'user' | 'assistant';
        const last = convo[convo.length - 1];
        if (last && last.role === role) {
          if (typeof last.content === 'string' && typeof m.content === 'string') {
            last.content += '\n\n' + m.content;
          } else {
            const lastBlocks = typeof last.content === 'string'
              ? [{ type: 'text' as const, text: last.content }] : last.content;
            const newBlocks = typeof m.content === 'string'
              ? [{ type: 'text' as const, text: m.content }] : m.content;
            last.content = [...lastBlocks, ...newBlocks];
          }
        } else {
          convo.push({ role, content: m.content });
        }
      }
      while (convo.length > 0 && convo[0].role === 'assistant') convo.shift();

      const baseUrl = config.apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
      const body: Record<string, any> = { model: config.model, messages: convo };
      if (systemMessage) body.system = systemMessage.content;

      const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) return undefined;
      const parsed = (await response.json()) as { input_tokens?: number };
      return typeof parsed.input_tokens === 'number' ? parsed.input_tokens : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Model ids (+ capability hints when the gateway exposes them) via Anthropic's GET /v1/models endpoint. */
export async function listModelsAnthropic(config: LlmConfig): Promise<ModelInfo[]> {
  const baseUrl = config.apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const response = await fetch(`${baseUrl}/v1/models`, {
    method: 'GET',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }
  const parsed = (await response.json()) as { data?: unknown[] };
  return (parsed.data ?? []).map(m => toModelInfo(m)).filter((m): m is ModelInfo => m !== null);
}

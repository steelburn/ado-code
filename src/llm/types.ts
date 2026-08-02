export type LlmProviderType = 'openai' | 'anthropic';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // C1 fix: tool-calling metadata carried on the generic message so the
  // provider can translate 1:1 to its native shape.
  toolCallId?: string;   // present on role:'tool' messages (OpenAI tool_call_id / Anthropic tool_use_id)
  toolCalls?: Array<{ id: string; name: string; arguments: string }>; // present on assistant messages that invoked tools
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
}

export interface LlmConfig {
  provider: LlmProviderType;
  apiUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmProvider {
  streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk>;
}

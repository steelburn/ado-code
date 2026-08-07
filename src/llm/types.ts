export type LlmProviderType = 'openai' | 'anthropic';

import type { ContentBlockParam } from './providers/BaseProvider';
import type { ModelInfo } from './modelCapabilities';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlockParam[];
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
  /** Chat with tool-calling support (non-streaming agentic turns). */
  chatWithTools?(messages: LlmMessage[], config: LlmConfig, tools: LlmTool[], signal?: AbortSignal): Promise<{
    text: string;
    toolCalls: ToolCall[];
  }>;
  /** Model ids (+ capability hints when the gateway exposes them) — wizard model picker. */
  listModels?(config: LlmConfig): Promise<ModelInfo[]>;
}

export interface LlmToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, LlmToolParameter>;
  required?: string[];
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: LlmToolParameter; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string; // stringified JSON or text back to the model
}

export interface LlmAgenticResult {
  text: string;                 // final assistant text
  toolCalls: ToolCall[];        // all calls made during the loop
  iterations: number;
}

/**
 * Extract plain text from LlmMessage.content.
 * Handles both string content and ContentBlockParam[] (image support).
 */
export function messageText(content: string | ContentBlockParam[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

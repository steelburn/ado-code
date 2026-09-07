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
  /** Model's internal reasoning/thinking text (o1/o3 reasoning_content, Claude extended thinking). */
  thinking?: string;
}

export interface LlmConfig {
  provider: LlmProviderType;
  apiUrl: string;
  apiKey: string;
  model: string;
  /** Reasoning effort for reasoning models (low, medium, high). Only used by models that support it. */
  reasoningEffort?: string;
}

export interface LlmProvider {
  streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk>;
  /** Chat with tool-calling support (non-streaming agentic turns). */
  chatWithTools?(messages: LlmMessage[], config: LlmConfig, tools: LlmTool[], signal?: AbortSignal): Promise<{
    text: string;
    toolCalls: ToolCall[];
    /** Native stop reason ('length'/'max_tokens' means the model hit its output limit — tool-call args may be truncated). */
    stopReason?: string;
  }>;
  /**
   * Best-effort native token count for a full conversation (system + user +
   * assistant + tool messages as passed to the API). Returns `undefined` when
   * the provider/endpoint has no native counting available — callers then fall
   * back to the local heuristic. Not all providers expose a free endpoint
   * (Anthropic does; OpenAI-compatible gateways vary).
   */
  countTokens?(messages: LlmMessage[], config: LlmConfig): Promise<number | undefined>;
  /** Model ids (+ capability hints when the gateway exposes them) — wizard model picker. */
  listModels?(config: LlmConfig): Promise<ModelInfo[]>;
}

export interface LlmToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, LlmToolParameter>;
  required?: string[];
  /** JSON-schema items for array-typed parameters (e.g. edit_file.edits). */
  items?: LlmToolParameter;
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
  iterations: number;           // model round-trips used (NOT tool-call count)
  /** True when the loop exhausted its iteration budget mid-work and ended
   *  with a forced concluding reply instead of the model finishing on its
   *  own. The host uses this to present the turn as stopped-by-limit rather
   *  than as a normal completion. */
  reachedIterationLimit?: boolean;
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

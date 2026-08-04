/**
 * ApiHandler Interface & Factory
 *
 * Adapted from Roo-Code's src/api/index.ts. Provides a unified handler
 * interface that wraps the existing LlmProvider implementations and
 * exposes the Anthropic-style message format (canonical internal format)
 * used by BaseProvider subclasses.
 *
 * This module is the NEW abstraction layer that will eventually replace
 * the old client.ts factory. The old client.ts is untouched and still works.
 */

// ---------------------------------------------------------------------------
// Re-export BaseProvider types so consumers can import from handler.ts
// ---------------------------------------------------------------------------

export {
  ContentBlockText,
  ContentBlockImage,
  ContentBlockParam,
  AnthropicMessage,
  ProviderCreateMessageMetadata,
  ProviderOptions,
  ModelInfo,
  ApiStreamTextChunk,
  ApiStreamToolUseChunk,
  ApiStreamToolResultChunk,
  ApiStreamUsageChunk,
  ApiStreamChunk,
  ApiStream,
} from "./providers/BaseProvider";

export {
  LlmProviderType,
  LlmMessage,
  LlmStreamChunk,
  LlmConfig,
  LlmProvider,
  LlmTool,
  LlmToolParameter,
  ToolCall,
  ToolResult,
  LlmAgenticResult,
} from "./types";

// ---------------------------------------------------------------------------
// ApiHandler interface
// ---------------------------------------------------------------------------

import type {
  AnthropicMessage,
  ContentBlockParam,
  ModelInfo,
  ApiStream,
  ApiStreamChunk,
  ProviderOptions,
} from "./providers/BaseProvider";
import type { LlmConfig } from "./types";

/**
 * Metadata forwarded to createMessage on every call.
 * Kept minimal for our adaptation; extend as provider needs grow.
 */
export interface ApiHandlerCreateMessageMetadata {
  /** Task / conversation id for logging / tracing. */
  id?: string;
  /** Parent message id for conversation threading. */
  parentMessageId?: string;
  /** Model override (if caller wants to force a specific model). */
  model?: string;
}

/**
 * Unified handler interface — the NEW abstraction over providers.
 *
 * Mirrors Roo-Code's ApiHandler shape while keeping our types:
 *   - createMessage uses AnthropicMessage[] (canonical internal format)
 *   - getModel returns the current model id + capability metadata
 *   - countTokens is optional; providers can override with native endpoints
 */
export interface ApiHandler {
  /**
   * Stream a response from the model.
   *
   * @param systemPrompt  System-level instructions.
   * @param messages      Conversation in Anthropic message format.
   * @param options       Optional tuning knobs forwarded to the provider.
   * @returns             An async generator yielding ApiStreamChunk values.
   */
  createMessage(
    systemPrompt: string,
    messages: AnthropicMessage[],
    options?: ProviderOptions,
  ): ApiStream;

  /**
   * Return the current model id and its capability metadata.
   */
  getModel(): { id: string; info: ModelInfo };

  /**
   * Count tokens for content blocks.
   * Providers may override this to use native counting endpoints.
   * Optional — if absent, callers should use a rough heuristic.
   */
  countTokens?(content: ContentBlockParam[]): Promise<number>;
}

// ---------------------------------------------------------------------------
// Concrete handler implementations for our providers
// ---------------------------------------------------------------------------

/**
 * OpenAI handler — adapts the existing OpenAiProvider to ApiHandler.
 *
 * NOTE: The existing OpenAiProvider implements LlmProvider (the old interface)
 * which has a different method signature (streamChat, chatWithTools).
 * For the new handler interface we need BaseProvider subclasses.
 *
 * Since our OpenAiProvider doesn't extend BaseProvider yet, this adapter
 * creates a shim that delegates to the BaseProvider-shaped interface.
 *
 * For now, we provide a minimal BaseProvider-compatible shim that delegates
 * to the raw OpenAI API with the Anthropic message format.
 */
class OpenAiApiHandler implements ApiHandler {
  private modelId: string;

  constructor(private config: LlmConfig) {
    this.modelId = config.model;
  }

  async *createMessage(
    systemPrompt: string,
    messages: AnthropicMessage[],
    options?: ProviderOptions,
  ): ApiStream {
    // Convert Anthropic messages → OpenAI format
    const openaiMessages: Array<{ role: string; content: any }> = [];

    if (systemPrompt) {
      openaiMessages.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        openaiMessages.push({ role: msg.role, content: msg.content });
      } else {
        // ContentBlockParam[] — extract text only for simple compatibility
        const textParts = msg.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text);
        openaiMessages.push({
          role: msg.role,
          content: textParts.join("\n") || "",
        });
      }
    }

    const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      signal: options?.signal,
      body: JSON.stringify({
        model: this.modelId,
        messages: openaiMessages,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI API error: ${response.status} ${await response.text()}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        const match = line.match(/^data: ?(.*)$/);
        if (match) {
          const data = match[1];
          if (data === "[DONE]") {
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              yield { type: "text", text: content };
            }
            // Emit usage if available
            const usage = parsed.usage;
            if (usage) {
              yield {
                type: "usage",
                inputTokens: usage.prompt_tokens ?? 0,
                outputTokens: usage.completion_tokens ?? 0,
              };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  }

  getModel(): { id: string; info: ModelInfo } {
    return {
      id: this.modelId,
      info: {
        supportsImages: this.modelId.includes("gpt-4"),
        maxTokens: 128000,
        contextWindow: 128000,
      },
    };
  }

  async countTokens(content: ContentBlockParam[]): Promise<number> {
    let total = 0;
    for (const block of content) {
      if (block.type === "text") {
        total += Math.ceil(block.text.length / 4);
      }
    }
    return total;
  }
}

/**
 * Anthropic handler — adapts the existing AnthropicProvider to ApiHandler.
 */
class AnthropicApiHandler implements ApiHandler {
  private modelId: string;

  constructor(private config: LlmConfig) {
    this.modelId = config.model;
  }

  async *createMessage(
    systemPrompt: string,
    messages: AnthropicMessage[],
    options?: ProviderOptions,
  ): ApiStream {
    const baseUrl = this.config.apiUrl
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");

    const body: Record<string, any> = {
      model: this.modelId,
      max_tokens: options?.maxTokens ?? 4096,
      messages,
      stream: true,
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.topP !== undefined) {
      body.top_p = options.topP;
    }
    if (options?.topK !== undefined) {
      body.top_k = options.topK;
    }
    if (options?.stopSequences) {
      body.stop_sequences = options.stopSequences;
    }

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: options?.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API error: ${response.status} ${await response.text()}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    // Tool input accumulation state (matching AnthropicV2Provider pattern)
    let currentToolId = "";
    let currentToolName = "";
    let currentToolInput = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        const match = line.match(/^data: ?(.*)$/);
        if (match) {
          const data = match[1];
          if (data === "[DONE]") {
            return;
          }
          try {
            const parsed = JSON.parse(data);

            if (parsed.type === "content_block_start") {
              // Begin accumulating tool input
              if (parsed.content_block?.type === "tool_use") {
                currentToolId = parsed.content_block.id;
                currentToolName = parsed.content_block.name;
                currentToolInput = "";
              }
            } else if (parsed.type === "content_block_delta") {
              // Text delta or tool input delta
              if (parsed.delta?.type === "input_json_delta") {
                // Accumulate tool input JSON
                currentToolInput += parsed.delta.partial_json || "";
              } else {
                const text = parsed.delta?.text || "";
                if (text) {
                  yield { type: "text", text };
                }
              }
            } else if (parsed.type === "content_block_stop") {
              // Emit the complete tool_use chunk with accumulated input
              if (currentToolId) {
                let input: Record<string, unknown> = {};
                if (currentToolInput.trim() !== "") {
                  try {
                    input = JSON.parse(currentToolInput);
                  } catch {
                    input = {};
                  }
                }
                yield {
                  type: "tool_use",
                  id: currentToolId,
                  name: currentToolName,
                  input,
                };
                currentToolId = "";
                currentToolName = "";
                currentToolInput = "";
              }
            } else if (parsed.type === "message_delta") {
              // Usage info
              const usage = parsed.usage;
              if (usage) {
                yield {
                  type: "usage",
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                };
              }
            } else if (parsed.type === "message_stop") {
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  }

  getModel(): { id: string; info: ModelInfo } {
    const isClaude = this.modelId.includes("claude");
    return {
      id: this.modelId,
      info: {
        supportsImages: isClaude,
        supportsPromptCache: isClaude,
        maxTokens: 200000,
        contextWindow: 200000,
      },
    };
  }

  async countTokens(content: ContentBlockParam[]): Promise<number> {
    let total = 0;
    for (const block of content) {
      if (block.type === "text") {
        total += Math.ceil(block.text.length / 4);
      }
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Factory: buildApiHandler
// ---------------------------------------------------------------------------

/**
 * Build an ApiHandler from configuration.
 *
 * Reads `config.provider` (LlmProviderType) and returns the appropriate
 * handler. Defaults to OpenAI if the provider is unknown.
 *
 * This is the NEW factory that will eventually replace client.ts.
 *
 * @param config  LlmConfig with provider, apiUrl, apiKey, model.
 * @returns       An ApiHandler ready to stream messages.
 */
export function buildApiHandler(config: LlmConfig): ApiHandler {
  switch (config.provider) {
    case "openai":
      return new OpenAiApiHandler(config);
    case "anthropic":
      return new AnthropicApiHandler(config);
    default:
      console.warn(
        `Unknown provider "${config.provider}", falling back to OpenAI handler`,
      );
      return new OpenAiApiHandler(config);
  }
}

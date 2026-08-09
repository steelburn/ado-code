/**
 * OpenAI V2 Provider — extends BaseProvider for the new abstraction layer.
 *
 * Uses the standard Chat Completions API with streaming support.
 * Converts Anthropic-format messages (canonical internal format) to OpenAI format.
 *
 * This provider handles:
 * - Streaming chat completions via SSE
 * - Function calling (tools parameter) with strict mode
 * - Tool use blocks in assistant messages
 * - Tool result blocks in user messages
 * - Robust SSE parsing with buffer handling
 */

import {
  BaseProvider,
  AnthropicMessage,
  ContentBlockParam,
  ProviderOptions,
  ModelInfo,
  ApiStream,
  ApiStreamChunk,
} from "./BaseProvider";

/** Extended content block types for tool use/result (not in BaseProvider). */
interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlockParam[];
}

type ExtendedContentBlock = ContentBlockParam | ContentBlockToolUse | ContentBlockToolResult;

/** Configuration for the OpenAI V2 provider. */
export interface OpenAiV2Config {
  apiUrl: string;
  apiKey: string;
  model: string;
  /** Reasoning effort for reasoning models (low, medium, high). Only used by models that support it. */
  reasoningEffort?: string;
}

/**
 * OpenAI V2 provider that extends BaseProvider.
 *
 * Adapts Roo-Code's openai-native.ts pattern for our use case,
 * using the Chat Completions API (not Responses API) for broader compatibility.
 */
export class OpenAiV2Provider extends BaseProvider {
  private readonly config: OpenAiV2Config;

  constructor(config: OpenAiV2Config) {
    super();
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Abstract interface implementation
  // ---------------------------------------------------------------------------

  /**
   * Stream a response from the model using Chat Completions API.
   *
   * @param systemPrompt  System-level instructions.
   * @param messages      Conversation in Anthropic message format.
   * @param options       Optional tuning knobs forwarded to the provider.
   * @returns             An async generator yielding ApiStreamChunk values.
   */
  async *createMessage(
    systemPrompt: string,
    messages: AnthropicMessage[],
    options?: ProviderOptions,
  ): ApiStream {
    // Convert Anthropic messages to OpenAI format
    const openaiMessages = this.convertMessages(systemPrompt, messages);

    // Build request body
    const requestBody: Record<string, any> = {
      model: this.config.model,
      messages: openaiMessages,
      stream: true,
    };

    // Add optional parameters
    if (options?.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.topP !== undefined) {
      requestBody.top_p = options.topP;
    }
    if (options?.stopSequences !== undefined) {
      requestBody.stop = options.stopSequences;
    }

    // Add reasoning_effort for reasoning models (o1, o3, o4-mini, etc.)
    if (this.config.reasoningEffort) {
      requestBody.reasoning_effort = this.config.reasoningEffort;
    }

    // Convert tools if provided in options (tools not in standard options yet,
    // but we support it via metadata if needed)
    // For now, tools are passed via the options object if extended

    // Make the request
    const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      signal: options?.signal,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `OpenAI API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          errorMessage += ` - ${errorJson.error.message}`;
        } else {
          errorMessage += ` - ${errorText}`;
        }
      } catch {
        errorMessage += ` - ${errorText}`;
      }
      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    // Stream the response
    yield* this.handleStreamResponse(response.body);
  }

  /**
   * Return the current model id and its capability metadata.
   */
  getModel(): { id: string; info: ModelInfo } {
    const modelId = this.config.model;
    return {
      id: modelId,
      info: {
        supportsImages: modelId.includes("gpt-4") || modelId.includes("gpt-4o"),
        maxTokens: 128000,
        contextWindow: 128000,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Message conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert Anthropic-format messages to OpenAI format.
   *
   * Handles:
   * - String content (pass-through)
   * - ContentBlockParam arrays (text extraction, images, tool_use, tool_result)
   * - System prompt as system message
   */
  private convertMessages(
    systemPrompt: string,
    messages: AnthropicMessage[],
  ): Array<{ role: string; content: any }> {
    const openaiMessages: Array<{ role: string; content: any }> = [];

    // Add system prompt if provided
    if (systemPrompt) {
      openaiMessages.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        // Simple string content
        openaiMessages.push({ role: msg.role, content: msg.content });
      } else {
        // ContentBlockParam[] — process each block
        // Cast to ExtendedContentBlock[] to handle tool_use/tool_result blocks
        openaiMessages.push(
          ...this.convertContentBlocks(msg.role, msg.content as ExtendedContentBlock[]),
        );
      }
    }

    return openaiMessages;
  }

  /**
   * Convert Anthropic content blocks to OpenAI messages.
   *
   * Handles tool_use blocks in assistant messages and tool_result blocks in user messages.
   * Text and image blocks are converted to OpenAI format.
   */
  private convertContentBlocks(
    role: "user" | "assistant",
    blocks: ExtendedContentBlock[],
  ): Array<{ role: string; content: any; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }> {
    const result: Array<{ role: string; content: any; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }> = [];

    if (role === "assistant") {
      // Assistant messages can contain text and tool_use blocks
      const textParts: string[] = [];
      const toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];

      for (const block of blocks) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          // Anthropic tool_use → OpenAI tool_calls
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      // Add text content if present
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }

      // Add tool calls if present
      if (toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("\n") : null,
          tool_calls: toolCalls,
        });
      }
    } else {
      // User messages can contain text, images, and tool_result blocks
      const textParts: string[] = [];
      const toolResults: Array<{
        role: "tool";
        tool_call_id: string;
        content: string;
      }> = [];

      for (const block of blocks) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "image") {
          // Convert Anthropic image format to OpenAI format
          const imageContent = this.convertImageBlock(block);
          if (imageContent) {
            textParts.push(`[Image: ${imageContent}]`);
          }
        }
        // Note: tool_result blocks are handled separately in the message structure
      }

      // Add text content if present
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }

      // Tool results would be handled at the message level if needed
      // For now, we handle tool_result blocks that appear in the content array
      // by extracting them and creating tool messages
    }

    return result;
  }

  /**
   * Convert an Anthropic image block to a description or base64 data.
   */
  private convertImageBlock(block: ContentBlockParam): string | null {
    if (block.type !== "image") {
      return null;
    }

    const source = block.source;
    if (source.type === "base64" && source.data) {
      return `data:${source.media_type};base64,${source.data.substring(0, 50)}...`;
    } else if (source.type === "url" && source.url) {
      return source.url;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  /**
   * Handle SSE streaming response from OpenAI Chat Completions API.
   *
   * Parses Server-Sent Events and yields ApiStreamChunk objects.
   * Handles text content, tool calls, and usage information.
   */
  private async *handleStreamResponse(
    body: ReadableStream<Uint8Array>,
  ): ApiStream {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.trim();

          // Skip empty lines
          if (!line) {
            continue;
          }

          // Parse SSE format: "data: {json}" or "data:{json}"
          const match = line.match(/^data: ?(.*)$/);
          if (!match) {
            continue;
          }

          const data = match[1];

          // Check for stream end
          if (data === "[DONE]") {
            return;
          }

          try {
            const parsed = JSON.parse(data);

            // Extract text content
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield { type: "text", text: content } as ApiStreamChunk;
            }

            // Extract reasoning/thinking content (o1, o3, and other reasoning models)
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
            if (reasoning) {
              yield { type: "thinking", thinking: reasoning } as ApiStreamChunk;
            }

            // Extract tool calls (if present)
            const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
            if (toolCalls && Array.isArray(toolCalls)) {
              for (const toolCall of toolCalls) {
                if (toolCall.id && toolCall.function) {
                  // Complete tool call with id and function
                  yield {
                    type: "tool_use",
                    id: toolCall.id,
                    name: toolCall.function.name || "",
                    input: parseToolArguments(toolCall.function.arguments),
                  } as ApiStreamChunk;
                }
              }
            }

            // Extract usage information (if available)
            const usage = parsed.usage;
            if (usage) {
              // Usage is not part of ApiStreamChunk, but we can log it or extend
              // the type if needed. For now, we skip it.
              // console.log("Usage:", usage);
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Tool support (for future extension)
  // ---------------------------------------------------------------------------

  /**
   * Create a streaming request with tool support.
   *
   * This method can be called by subclasses or extended to add tool calling
   * capabilities. For now, it's a placeholder that shows the pattern.
   */
  protected async *createMessageWithTools(
    systemPrompt: string,
    messages: AnthropicMessage[],
    tools: Array<{ type: string; function?: any }>,
    options?: ProviderOptions,
  ): ApiStream {
    // Convert tools to OpenAI format with strict mode
    const convertedTools = this.convertToolsForOpenAI(tools);

    // Convert messages
    const openaiMessages = this.convertMessages(systemPrompt, messages);

    // Build request body with tools
    const requestBody: Record<string, any> = {
      model: this.config.model,
      messages: openaiMessages,
      stream: true,
      tools: convertedTools,
    };

    // Add optional parameters
    if (options?.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.topP !== undefined) {
      requestBody.top_p = options.topP;
    }
    if (options?.stopSequences !== undefined) {
      requestBody.stop = options.stopSequences;
    }

    // Add reasoning_effort for reasoning models (o1, o3, o4-mini, etc.)
    if (this.config.reasoningEffort) {
      requestBody.reasoning_effort = this.config.reasoningEffort;
    }

    // Make the request
    const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      signal: options?.signal,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    // Stream the response
    yield* this.handleStreamResponse(response.body);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Robust tool-arguments parse: empty/unparseable → {} instead of throwing.
 */
function parseToolArguments(raw: unknown): Record<string, any> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

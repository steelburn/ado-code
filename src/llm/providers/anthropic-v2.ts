/**
 * AnthropicV2Provider — Anthropic Messages API provider extending BaseProvider.
 *
 * This is the v2 provider that uses the new BaseProvider abstraction layer.
 * It speaks Anthropic's message format natively (which is also our canonical
 * internal format), so no message conversion is needed.
 *
 * Features:
 *   - Streaming SSE parsing of Anthropic Messages API
 *   - Tool use support (tools parameter + streaming tool_call chunks)
 *   - Prompt caching support
 *   - Proper content_block_start / content_block_delta / message_delta handling
 *
 * Adapted from:
 *   - handler.ts AnthropicApiHandler (SSE parsing pattern)
 *   - Roo-Code src/api/providers/anthropic.ts (event handling pattern)
 */

import {
  BaseProvider,
  type AnthropicMessage,
  type ApiStream,
  type ApiStreamChunk,
  type ModelInfo,
  type ProviderOptions,
  type ContentBlockParam,
} from "./BaseProvider";
import type { LlmConfig } from "../types";

// ---------------------------------------------------------------------------
// Tool types (Anthropic-native shape)
// ---------------------------------------------------------------------------

/** Anthropic-native tool definition. */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

/** Options specific to the Anthropic v2 provider. */
export interface AnthropicV2Options extends ProviderOptions {
  /** Tool definitions to pass to the API. */
  tools?: AnthropicTool[];
  /** Control tool selection: "auto", "any", "tool", or a specific tool name. */
  tool_choice?: { type: string; name?: string };
}

// ---------------------------------------------------------------------------
// AnthropicV2Provider
// ---------------------------------------------------------------------------

export class AnthropicV2Provider extends BaseProvider {
  private config: LlmConfig;

  constructor(config: LlmConfig) {
    super();
    this.config = config;
  }

  // ── BaseProvider interface ────────────────────────────────────────────────

  /**
   * Stream a response from the Anthropic Messages API.
   *
   * Yields ApiStreamChunk objects:
   *   - { type: "text", text } for text content
   *   - { type: "tool_use", id, name, input } when a tool call is complete
   *
   * Tool input is accumulated from `input_json_delta` chunks and emitted as
   * a single `tool_use` chunk when the content block stops.
   */
  async *createMessage(
    systemPrompt: string,
    messages: AnthropicMessage[],
    options?: AnthropicV2Options,
  ): ApiStream {
    const baseUrl = this.config.apiUrl
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");

    // Build request body
    const body: Record<string, any> = {
      model: this.config.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages,
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

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

    // Tool support
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }
    if (options?.tool_choice) {
      body.tool_choice = options.tool_choice;
    }

    // Fire the request
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
      const errorBody = await response.text();
      throw new Error(
        `Anthropic API error: ${response.status} ${errorBody}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    // Tool input accumulation state
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
        if (!match) continue;

        const data = match[1];
        if (data === "[DONE]") {
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Skip malformed JSON
          continue;
        }

        switch (parsed.type) {
          // ── Content block started ────────────────────────────────────────
          case "content_block_start": {
            const block = parsed.content_block;
            if (block?.type === "tool_use") {
              // Begin accumulating tool input
              currentToolId = block.id;
              currentToolName = block.name;
              currentToolInput = "";
            }
            break;
          }

          // ── Content block delta ──────────────────────────────────────────
          case "content_block_delta": {
            const delta = parsed.delta;
            if (!delta) break;

            if (delta.type === "text_delta") {
              // Text content
              const text = delta.text || "";
              if (text) {
                yield { type: "text", text };
              }
            } else if (delta.type === "input_json_delta") {
              // Accumulate tool input JSON
              currentToolInput += delta.partial_json || "";
            }
            break;
          }

          // ── Content block stopped ────────────────────────────────────────
          case "content_block_stop": {
            // If we were accumulating a tool call, emit the complete tool_use chunk
            if (currentToolId) {
              let input: Record<string, unknown> = {};
              if (currentToolInput.trim() !== "") {
                try {
                  input = JSON.parse(currentToolInput);
                } catch {
                  // If the accumulated JSON is invalid (truncated at stream end),
                  // yield an empty input object rather than crashing.
                  input = {};
                }
              }
              yield {
                type: "tool_use",
                id: currentToolId,
                name: currentToolName,
                input,
              };
              // Reset accumulation state
              currentToolId = "";
              currentToolName = "";
              currentToolInput = "";
            }
            break;
          }

          // ── Message delta (usage info) ───────────────────────────────────
          case "message_delta": {
            // Usage info is available in parsed.usage but we don't have a
            // "usage" chunk type in ApiStreamChunk. We could extend the type
            // later; for now we skip it.
            break;
          }

          // ── Message stopped ──────────────────────────────────────────────
          case "message_stop": {
            return;
          }

          // ── Message start ────────────────────────────────────────────────
          case "message_start": {
            // Contains initial usage info. Nothing to yield for now.
            break;
          }

          default:
            // Unknown event type — ignore gracefully
            break;
        }
      }
    }
  }

  /**
   * Return model info for the configured Anthropic model.
   */
  getModel(): { id: string; info: ModelInfo } {
    const modelId = this.config.model;
    const isClaude = modelId.includes("claude");

    return {
      id: modelId,
      info: {
        supportsImages: isClaude,
        supportsPromptCache: isClaude,
        maxTokens: 200000,
        contextWindow: 200000,
      },
    };
  }

  /**
   * Count tokens using the same heuristic as the base class.
   * Override if you want to use Anthropic's native token counting endpoint.
   */
  async countTokens(content: ContentBlockParam[]): Promise<number> {
    return super.countTokens(content);
  }
}

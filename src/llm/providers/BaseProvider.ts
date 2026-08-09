/**
 * BaseProvider — abstract base class for all LLM API providers.
 *
 * Adapted from Roo-Code's BaseProvider (src/api/providers/base-provider.ts).
 * Uses Anthropic message format as the canonical internal representation,
 * matching Roo-Code's convention so all providers speak one message schema.
 *
 * Subclasses must implement:
 *   - createMessage(systemPrompt, messages, options) → ApiStream
 *   - getModel() → { id, info }
 *
 * Concrete helpers provided:
 *   - countTokens(content)          — default tiktoken-based counting (overrideable)
 *   - convertToolsForOpenAI(tools)  — strict-mode tool conversion for OpenAI APIs
 *   - convertToolSchemaForOpenAI(s) — recursive schema fixup for OpenAI strict mode
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Anthropic-style content block (text or image). */
export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockImage {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type: string;
    data?: string;
    url?: string;
  };
}

export type ContentBlockParam = ContentBlockText | ContentBlockImage;

/** Anthropic-style message — the canonical internal format. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlockParam[];
}

/** Metadata passed through to provider.createMessage for logging / telemetry. */
export interface ProviderCreateMessageMetadata {
  id?: string;
  parentMessageId?: string;
  model?: string;
  [key: string]: unknown;
}

/** Options forwarded to createMessage on every call. */
export interface ProviderOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
}

/** Model capability metadata. */
export interface ModelInfo {
  supportsImages?: boolean;
  supportsPromptCache?: boolean;
  maxTokens?: number;
  contextWindow?: number;
}

/** A stream chunk emitted by createMessage. */
export interface ApiStreamTextChunk {
  type: "text";
  text: string;
}

export interface ApiStreamToolUseChunk {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ApiStreamToolResultChunk {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface ApiStreamUsageChunk {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
}

export interface ApiStreamThinkingChunk {
  type: "thinking";
  thinking: string;
}

export type ApiStreamChunk =
  | ApiStreamTextChunk
  | ApiStreamToolUseChunk
  | ApiStreamToolResultChunk
  | ApiStreamUsageChunk
  | ApiStreamThinkingChunk;

/** The streaming return type for createMessage. */
export type ApiStream = AsyncGenerator<ApiStreamChunk>;

// ---------------------------------------------------------------------------
// BaseProvider
// ---------------------------------------------------------------------------

export abstract class BaseProvider {
  // ── Abstract interface ──────────────────────────────────────────────────

  /**
   * Send a prompt + conversation to the model and stream back a response.
   *
   * @param systemPrompt  The system prompt (provider-specific wrapper may be needed).
   * @param messages      Conversation in Anthropic message format (canonical).
   * @param options       Optional tuning knobs (maxTokens, temperature, signal, …).
   * @returns             An async generator yielding ApiStreamChunk values.
   */
  abstract createMessage(
    systemPrompt: string,
    messages: AnthropicMessage[],
    options?: ProviderOptions,
  ): ApiStream;

  /**
   * Return the current model id and its capability metadata.
   */
  abstract getModel(): { id: string; info: ModelInfo };

  // ── Concrete helpers ────────────────────────────────────────────────────

  /**
   * Default token-counting implementation.
   * Providers may override this to use a native counting endpoint.
   *
   * @param content  Array of Anthropic content blocks to count.
   * @returns        Estimated token count.
   */
  async countTokens(content: ContentBlockParam[]): Promise<number> {
    if (content.length === 0) {
      return 0;
    }

    // Rough heuristic: split on whitespace/punctuation as a placeholder.
    // Real implementations should use tiktoken or a provider-native endpoint.
    let total = 0;
    for (const block of content) {
      if (block.type === "text") {
        // ~4 chars per token as a conservative estimate
        total += Math.ceil(block.text.length / 4);
      }
    }
    return total;
  }

  /**
   * Convert an array of tools to be compatible with OpenAI's strict mode.
   * Filters for function tools, applies schema conversion to their parameters,
   * and ensures all tools have consistent strict: true values.
   *
   * MCP tools (prefixed with `mcp--`) are left unmodified to preserve
   * optional parameters from the MCP server schema.
   */
  protected convertToolsForOpenAI(
    tools: Array<{ type: string; function?: any }> | undefined,
  ): Array<{ type: string; function?: any }> | undefined {
    if (!tools) {
      return undefined;
    }

    return tools.map((tool) => {
      if (tool.type !== "function") {
        return tool;
      }

      const name = tool.function?.name ?? "";
      const isMcp = name.startsWith("mcp--");

      return {
        ...tool,
        function: {
          ...tool.function,
          strict: !isMcp,
          parameters: isMcp
            ? tool.function.parameters
            : this.convertToolSchemaForOpenAI(tool.function.parameters),
        },
      };
    });
  }

  /**
   * Convert tool schemas to be compatible with OpenAI's strict mode:
   *   - Ensures all properties are in the required array (strict mode requirement)
   *   - Converts nullable types (["type", "null"]) to non-nullable ("type")
   *   - Adds additionalProperties: false to all object schemas
   *   - Recursively processes nested objects and arrays
   *
   * This matches Roo-Code's ensureAllRequired / convertToolSchemaForOpenAI.
   */
  protected convertToolSchemaForOpenAI(schema: any): any {
    if (!schema || typeof schema !== "object" || schema.type !== "object") {
      return schema;
    }

    const result = { ...schema };

    // OpenAI Responses API requires additionalProperties: false on all object schemas.
    if (result.additionalProperties !== false) {
      result.additionalProperties = false;
    }

    if (result.properties) {
      const allKeys = Object.keys(result.properties);
      // OpenAI strict mode requires ALL properties to be in required array.
      result.required = allKeys;

      // Recursively process nested objects and convert nullable types.
      const newProps: Record<string, any> = { ...result.properties };
      for (const key of allKeys) {
        const prop = newProps[key];

        // Handle nullable types by removing null.
        if (prop && Array.isArray(prop.type) && prop.type.includes("null")) {
          const nonNullTypes = prop.type.filter((t: string) => t !== "null");
          prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes;
        }

        // Recursively process nested objects.
        if (prop && prop.type === "object") {
          newProps[key] = this.convertToolSchemaForOpenAI(prop);
        } else if (prop && prop.type === "array" && prop.items?.type === "object") {
          newProps[key] = {
            ...prop,
            items: this.convertToolSchemaForOpenAI(prop.items),
          };
        }
      }
      result.properties = newProps;
    }

    return result;
  }
}

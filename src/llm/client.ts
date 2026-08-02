import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider, LlmProviderType, LlmTool } from './types';
import { OpenAiProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';

const providers: Record<LlmProviderType, LlmProvider> = {
  openai: new OpenAiProvider(),
  anthropic: new AnthropicProvider(),
};

export class LlmClient {
  private provider: LlmProvider;

  constructor(private config: LlmConfig) {
    this.provider = providers[config.provider];
    if (!this.provider) {
      throw new Error(`Unknown LLM provider: ${config.provider}`);
    }
  }

  async *streamChat(messages: LlmMessage[], signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    yield* this.provider.streamChat(messages, this.config, signal);
  }

  /** Tool-calling chat (agentic turns). Delegates to the provider's chatWithTools. */
  async chatWithTools(messages: LlmMessage[], tools: LlmTool[], signal?: AbortSignal) {
    if (!this.provider.chatWithTools) {
      throw new Error(`provider ${this.config.provider} does not support tool calling`);
    }
    return this.provider.chatWithTools(messages, this.config, tools, signal);
  }
}

import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider, LlmProviderType } from './types';
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
}

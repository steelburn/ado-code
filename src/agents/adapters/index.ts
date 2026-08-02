import { AgentAdapter } from './types';
import { ClaudeAdapter } from './ClaudeAdapter';
import { CodexAdapter } from './CodexAdapter';
import { OpenCodeAdapter } from './OpenCodeAdapter';
import { HermesAdapter } from './HermesAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import { GenericAdapter } from './GenericAdapter';
import { AgentName } from '../types';

export function createAdapter(name: AgentName): AgentAdapter {
  switch (name) {
    case 'claude': return new ClaudeAdapter();
    case 'codex': return new CodexAdapter();
    case 'opencode': return new OpenCodeAdapter();
    case 'hermes': return new HermesAdapter();
    case 'gemini': return new GeminiAdapter();
    default: return new GenericAdapter(name); // pi, openclaw, aider, cursor-agent
  }
}

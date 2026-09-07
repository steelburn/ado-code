import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';
import { resolveSpawn } from '../resolveBin';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/** One NDJSON event line from `pi -p --mode json` (loose shape). */
interface PiEvent {
  type: string;
  message?: any;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
}

/** Per-run mutable state for event rendering. */
interface PiStreamState {
  finalText: string;
  thinkingShown: boolean;
  tools: Map<string, string>; // toolCallId → toolName
  onChunk?: (chunk: string) => void;
}

/** Accumulates stdout chunks into complete lines (events are NDJSON). */
class LineBuffer {
  private buf = '';
  push(text: string): string[] {
    this.buf += text;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines;
  }
  flush(): string[] {
    if (!this.buf) return [];
    const rest = this.buf;
    this.buf = '';
    return [rest];
  }
}

/**
 * Pi: `pi -p --mode json "<prompt>"`. In text mode (-p) pi buffers ALL output
 * until the run finishes, so the output panel stays blank for minutes. JSON
 * mode emits a live NDJSON event stream (thinking/text deltas, tool
 * execution) which this adapter renders as readable progress via onChunk and
 * reduces to the clean final answer text as `output`.
 */
export class PiAdapter implements AgentAdapter {
  readonly name = 'pi';

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private handleEvent(line: string, state: PiStreamState): void {
    if (!line.trim()) return;
    let ev: PiEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      // Non-JSON noise (startup warnings etc.) — surface it as-is.
      state.onChunk?.(line + '\n');
      return;
    }
    switch (ev.type) {
      case 'agent_start':
        state.onChunk?.('⟳ pi: starting…\n');
        break;
      case 'turn_start':
        // New LLM turn — allow a fresh thinking indicator for this turn.
        state.thinkingShown = false;
        break;
      case 'message_update': {
        const sub = ev.assistantMessageEvent?.type;
        if (sub === 'thinking_start' && !state.thinkingShown) {
          // Indicator only — raw thinking deltas are too verbose for the panel.
          state.thinkingShown = true;
          state.onChunk?.('⟳ thinking…\n');
        } else if (sub === 'text_delta') {
          // Live answer text, streamed as it is generated.
          state.onChunk?.(ev.assistantMessageEvent?.delta ?? '');
        }
        break;
      }
      case 'tool_execution_start': {
        const id = ev.toolCallId ?? '';
        const name = ev.toolName ?? '?';
        state.tools.set(id, name);
        state.onChunk?.(`⟳ tool ${name}…\n`);
        break;
      }
      case 'tool_execution_end': {
        const id = ev.toolCallId ?? '';
        const name = state.tools.get(id) ?? '';
        state.tools.delete(id);
        state.onChunk?.(`✓ ${name || 'tool'} done\n`);
        break;
      }
      case 'message_end': {
        const m = ev.message;
        if (m && m.role === 'assistant') {
          // Authoritative final answer: the text content blocks.
          const text = (m.content ?? [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          if (text) state.finalText = text;
          if (m.stopReason === 'error' && m.errorMessage) {
            state.onChunk?.(`⚠ ${m.errorMessage}\n`);
            if (!state.finalText) state.finalText = m.errorMessage;
          }
        }
        break;
      }
      default:
        // session / turn_end / message_start / agent_end / agent_settled —
        // no panel value.
        break;
    }
  }

  private spawn(bin: string, args: string[], cwd: string, signal?: AbortSignal, onChunk?: (chunk: string) => void): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      // stdio: stdin closed — pi waits on stdin when spawned via node with an
      // open pipe (hangs indefinitely); one-shot mode never reads it.
      // Spawn the SAME executable detection verified (run.bin) — on Windows a
      // `.cmd` shim is routed through cmd.exe (see resolveSpawn).
      const resolved = resolveSpawn(bin, args);
      const child = this.spawnFn(resolved.bin, resolved.args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'], ...resolved.opts }) as any;
      const buffer = new LineBuffer();
      const state: PiStreamState = { finalText: '', thinkingShown: false, tools: new Map(), onChunk };

      child.stdout.on('data', (d: any) => {
        for (const line of buffer.push(d.toString())) {
          this.handleEvent(line, state);
        }
      });
      child.stderr.on('data', (d: any) => {
        state.onChunk?.(d.toString());
      });
      child.on('error', (err: any) => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', (code: number | null) => {
        for (const line of buffer.flush()) {
          this.handleEvent(line, state);
        }
        resolve({ exitCode: code, output: state.finalText });
      });
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    return this.spawn(run.bin ?? 'pi', ['-p', '--mode', 'json', prompt], run.workdir, signal, onChunk);
  }

  // No resumeTask — one-shot only (H13 synthesized follow-up).
}

import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentName, AgentRun } from '../types';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/**
 * Generic one-shot adapter for openclaw, aider, cursor-agent.
 * These agents' CLI contracts vary; best-effort per the registry spec.
 * (pi has its own adapter — PiAdapter — for JSON-mode live progress.)
 */
export class GenericAdapter implements AgentAdapter {
  readonly name: string;

  constructor(name: AgentName, private spawnFn: SpawnFn = cp.spawn) {
    this.name = name;
  }

  private spawn(bin: string, args: string[], cwd: string, signal?: AbortSignal, onChunk?: (chunk: string) => void): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn(bin, args, { cwd, signal }) as any;
      let output = '';
      child.stdout.on('data', (d: any) => {
        const text = d.toString();
        output += text;
        onChunk?.(text);
      });
      child.stderr.on('data', (d: any) => {
        const text = d.toString();
        output += text;
        onChunk?.(text);
      });
      child.on('error', (err: any) => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', (code: number | null) => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    const args: string[] = [];
    if (this.name === 'aider') {
      // aider manages its own commits by default — defer to our branch flow.
      args.push('--message', prompt, '--no-git');
    } else if (this.name === 'cursor-agent') {
      args.push('exec', prompt);
    } else {
      // pi / openclaw: -p "<prompt>"
      args.push('-p', prompt);
    }
    return this.spawn(this.name, args, run.workdir, signal, onChunk);
  }

  // No resumeTask — one-shot only (H13 synthesized follow-up).
}

import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentName, AgentRun } from '../types';
import { resolveSpawn } from '../resolveBin';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/**
 * Generic one-shot adapter for openclaw, aider, cursor-agent.
 * These agents' CLI contracts vary; best-effort per the registry spec.
 * (pi has its own adapter — PiAdapter — for JSON-mode live progress;
 * dsh has its own adapter — DshAdapter — for the headless profile.)
 */
export class GenericAdapter implements AgentAdapter {
  readonly name: string;

  constructor(name: AgentName, private spawnFn: SpawnFn = cp.spawn) {
    this.name = name;
  }

  private spawn(bin: string, args: string[], cwd: string, signal?: AbortSignal, onChunk?: (chunk: string) => void): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      // Spawn the SAME executable detection verified (run.bin) — on Windows a
      // `.cmd` shim is routed through cmd.exe (see resolveSpawn).
      const resolved = resolveSpawn(bin, args);
      const child = this.spawnFn(resolved.bin, resolved.args, { cwd, signal, ...resolved.opts }) as any;
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
    // Spawn the resolved executable from the run when present (fallback: name).
    return this.spawn(run.bin ?? this.name, args, run.workdir, signal, onChunk);
  }

  // No resumeTask — one-shot only (H13 synthesized follow-up).
}

import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentName, AgentRun } from '../types';

/**
 * Generic one-shot adapter for pi, openclaw, aider, cursor-agent.
 * These agents' CLI contracts vary; best-effort per the registry spec.
 */
export class GenericAdapter implements AgentAdapter {
  readonly name: string;

  constructor(name: AgentName) {
    this.name = name;
  }

  private spawn(bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = cp.spawn(bin, args, { cwd, signal });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('error', err => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', code => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
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
    return this.spawn(this.name, args, run.workdir, signal);
  }

  // No resumeTask — one-shot only (H13 synthesized follow-up).
}

import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/**
 * DeepSeek Harness: `dsh --profile headless -- "<prompt>"` — one-shot task
 * run that prints the final assistant message to stdout and exits.
 *
 * The headless profile has NO interactive follow-up surface (one submitted
 * task only), so this adapter is one-shot: follow-ups are synthesized by the
 * runner with prior context (H13). Exit code 0 = the turn completed; 1 = the
 * run errored (error code + message written to stderr; successful runs keep
 * stderr empty). The `--` guard keeps prompts that start with `-` from being
 * parsed as launcher/app flags.
 */
export class DshAdapter implements AgentAdapter {
  readonly name = 'dsh';

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private spawn(args: string[], cwd: string, signal?: AbortSignal, onChunk?: (chunk: string) => void): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      try {
        const child = this.spawnFn('dsh', args, { cwd, signal }) as any;
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
      } catch (err: any) {
        // Synchronous spawn failure (e.g. ELOOP, ENOENT on some platforms)
        resolve({ exitCode: 1, output: `failed to spawn: ${err.message ?? err}` });
      }
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    return this.spawn(['--profile', 'headless', '--', prompt], run.workdir, signal, onChunk);
  }

  // No resumeTask — headless is one-shot only (H13: synthesized follow-up).
}

import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';
import { resolveSpawn } from '../resolveBin';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/** OpenCode: `opencode run "<prompt>" --format json`; resume with `opencode run "<followUp>" -s <id>`. */
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private spawn(bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      // Spawn the SAME executable detection verified (run.bin) — on Windows a
      // `.cmd` shim is routed through cmd.exe (see resolveSpawn).
      const resolved = resolveSpawn(bin, args);
      const child = this.spawnFn(resolved.bin, resolved.args, { cwd, signal, ...resolved.opts }) as any;
      let output = '';
      child.stdout.on('data', (d: any) => { output += d.toString(); });
      child.stderr.on('data', (d: any) => { output += d.toString(); });
      child.on('error', (err: any) => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', (code: number | null) => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
    return this.spawn(run.bin ?? 'opencode', ['run', '--format', 'json', prompt], run.workdir, signal);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal) {
    if (!run.sessionId) throw new Error('no session id to resume');
    return this.spawn(run.bin ?? 'opencode', ['run', '-s', run.sessionId, followUp], run.workdir, signal);
  }

  extractSessionId(output: string): string | undefined {
    try {
      const parsed = JSON.parse(output);
      return typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
    } catch {
      return undefined;
    }
  }
}

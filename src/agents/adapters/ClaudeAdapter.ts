import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';
import { resolveSpawn } from '../resolveBin';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';

  // Inject spawn for tests (Node 23 exposes cp.spawn as non-configurable getter).
  constructor(private spawnFn: SpawnFn = cp.spawn) {}

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
      // H7 fix: keep `code` as-is (null on abort) — the runner maps null → cancelled.
      child.on('close', (code: number | null) => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    // claude -p "<prompt>" --output-format json --max-turns 20 --allowedTools ...
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '20', '--allowedTools', 'Read,Edit,Write,Bash'];
    return this.spawn(run.bin ?? 'claude', args, run.workdir, signal, onChunk);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    // Requires session id captured at run time: claude -p "<followUp>" --resume <id>
    if (!run.sessionId) throw new Error('no session id to resume');
    return this.spawn(run.bin ?? 'claude', ['-p', followUp, '--resume', run.sessionId, '--output-format', 'json', '--max-turns', '10'], run.workdir, signal, onChunk);
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

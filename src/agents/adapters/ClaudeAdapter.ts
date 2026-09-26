import * as cp from 'child_process';
import * as fs from 'fs';
import * as nodePath from 'path';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';
import { resolveSpawn, agentBinCandidates } from '../resolveBin';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/**
 * Resolve the best available binary name for an agent CLI.
 * On Windows this prefers `<name>.cmd` (npm shim) over `.exe` over bare name.
 * Falls back to the bare name when no candidate is found on PATH.
 */
export function resolveBin(name: string): string {
  for (const candidate of agentBinCandidates(name)) {
    try {
      // Check each directory on PATH for the candidate file.
      const dirs = (process.env.PATH ?? process.env.Path ?? '').split(
        process.platform === 'win32' ? ';' : ':'
      );
      for (const dir of dirs) {
        if (dir && fs.existsSync(nodePath.join(dir, candidate))) {
          return candidate;
        }
      }
    } catch {
      // ignore stat errors
    }
  }
  // Default: return bare name and let the OS resolve it.
  return name;
}


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
    return this.spawn(run.bin ?? resolveBin('claude'), args, run.workdir, signal, onChunk);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    // Requires session id captured at run time: claude -p "<followUp>" --resume <id>
    if (!run.sessionId) throw new Error('no session id to resume');
    return this.spawn(run.bin ?? resolveBin('claude'), ['-p', followUp, '--resume', run.sessionId, '--output-format', 'json', '--max-turns', '10'], run.workdir, signal, onChunk);
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

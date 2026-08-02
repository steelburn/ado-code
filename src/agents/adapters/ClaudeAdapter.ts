import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = cp.spawn('claude', args, { cwd, signal });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('error', err => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      // H7 fix: keep `code` as-is (null on abort) — the runner maps null → cancelled.
      child.on('close', code => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
    // claude -p "<prompt>" --output-format json --max-turns 20 --allowedTools ...
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '20', '--allowedTools', 'Read,Edit,Write,Bash'];
    return this.spawn(args, run.workdir, signal);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal) {
    // Requires session id captured at run time: claude -p "<followUp>" --resume <id>
    if (!run.sessionId) throw new Error('no session id to resume');
    return this.spawn(['-p', followUp, '--resume', run.sessionId, '--output-format', 'json', '--max-turns', '10'], run.workdir, signal);
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

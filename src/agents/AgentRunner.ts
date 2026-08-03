import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import { AgentRun, AgentName, AgentCapability } from './types';
import { AgentRegistry } from './registry';
import { createAdapter } from './adapters';
import { GitService } from '../git/GitService';

// M7 fix: the verify command is USER-configured (trusted input), so shell exec
// is intentional — it respects quotes/globs (e.g. `npm test -- --grep "foo bar"`).
async function execAsync(cmdline: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const exec = promisify(cp.exec);
  try {
    const { stdout, stderr } = await exec(cmdline, { cwd, timeout: 120000 });
    return { stdout, stderr };
  } catch (err: any) {
    return { stdout: err?.stdout ?? '', stderr: err?.stderr ?? err?.message ?? String(err) };
  }
}

export interface AgentRunnerCallbacks {
  onStatus(run: AgentRun, delta: string): void;          // stream output chunk
  onComplete(run: AgentRun, summary: string): void;      // final result
}

export class AgentRunner {
  private runs = new Map<string, AgentRun>();
  private aborts = new Map<string, AbortController>();

  constructor(
    private registry: AgentRegistry,
    private git: GitService,
    private callbacks: AgentRunnerCallbacks,
    private store?: { save(runs: AgentRun[]): void; load(): AgentRun[] } // Q7: workspaceState-backed
  ) {
    // Q7: restore persisted runs on construction (extension reload).
    const persisted = this.store?.load() ?? [];
    for (const run of persisted) {
      if (run.status === 'running') {
        run.status = 'interrupted'; // process died with the old extension host
      }
      this.runs.set(run.id, run);
    }
  }

  private persist(): void {
    this.store?.save([...this.runs.values()]);
  }

  async delegate(workItemId: number, prompt: string, agent?: AgentName): Promise<AgentRun> {
    const installed = await this.registry.getInstalled();
    // M2 fix: honor adoCode.agents.autoSelect when no agent is specified.
    let chosen: AgentCapability | undefined;
    if (agent) {
      chosen = installed.find(c => c.name === agent);
    } else {
      const auto = vscode.workspace.getConfiguration('adoCode').get<string>('agents.autoSelect', '');
      chosen = installed.find(c => c.name === auto) ?? installed[0];
    }
    if (!chosen) throw new Error('no agent installed or enabled — configure adoCode.agents.enabled');
    if (!chosen.installed) {
      throw new Error(`agent '${agent ?? 'any'}' is not installed`);
    }
    const workdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const run: AgentRun = {
      id: `run-${Date.now()}-${workItemId}`,
      workItemId,
      agent: chosen.name,
      workdir,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    this.persist();
    this.callbacks.onStatus(run, `delegating to ${chosen.displayName}...`);

    const abort = new AbortController();
    this.aborts.set(run.id, abort);
    const adapter = createAdapter(chosen.name);

    // Fire and forget; result delivered via callback
    void (async () => {
      try {
        const { exitCode, output } = await adapter.runTask(run, prompt, abort.signal, (chunk) => {
          this.callbacks.onStatus(run, chunk);
        });
        // H7 fix: if cancelled mid-run, do NOT overwrite the status or run verifyWork.
        if (run.status === 'cancelled') return;
        run.sessionId = adapter.extractSessionId?.(output);
        run.finishedAt = new Date().toISOString();
        // H7 fix: a null exit code on abort means the process was killed — mark cancelled, not succeeded.
        run.status = exitCode === null ? 'cancelled' : (exitCode === 0 ? 'succeeded' : 'failed');
        if (run.status === 'cancelled') { this.persist(); return; }
        // H8 fix: persist the output tail so interrupted runs have something to show.
        run.outputFile = await this.writeOutput(run.id, output);
        const summary = await this.verifyWork(run, output);
        run.summary = summary;
        this.persist();
        this.callbacks.onComplete(run, summary);
      } catch (err) {
        if (run.status === 'cancelled' || abort.signal.aborted) { this.persist(); return; }
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        this.persist();
        this.callbacks.onComplete(run, err instanceof Error ? err.message : String(err));
      } finally {
        this.aborts.delete(run.id);
      }
    })();

    return run;
  }

  /** H8: write agent output to a per-run file under the workspace state dir. */
  private async writeOutput(runId: string, output: string): Promise<string | undefined> {
    try {
      const dir = vscode.Uri.joinPath(vscode.Uri.file(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir()), '.ado-code', 'runs');
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, `${runId}.out.txt`);
      // H-8 fix: await the write so the file exists before we return its path.
      await vscode.workspace.fs.writeFile(file, Buffer.from(output.slice(-50000), 'utf8'));
      return file.fsPath;
    } catch {
      return undefined;
    }
  }

  async followUp(runId: string, followUpPrompt: string): Promise<AgentRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run with id ${runId}`);
    const adapter = createAdapter(run.agent);
    const abort = new AbortController();
    this.aborts.set(runId, abort);
    run.status = 'running';
    this.persist();
    void (async () => {
      try {
        let result: { exitCode: number | null; output: string };
        if (adapter.resumeTask && run.sessionId) {
          result = await adapter.resumeTask(run, followUpPrompt, abort.signal, (chunk) => {
            this.callbacks.onStatus(run, chunk);
          });
        } else {
          // H13 fix: synthesized follow-up for agents without session resume
          // (codex, aider, pi, openclaw, cursor-agent): re-run one-shot with
          // the previous summary + the follow-up prompt as context.
          const context = `[Previous run summary]\n${run.summary ?? '(no summary)'}\n\n[Follow-up request]\n${followUpPrompt}`;
          result = await adapter.runTask(run, context, abort.signal, (chunk) => {
            this.callbacks.onStatus(run, chunk);
          });
        }
        if (run.status === 'cancelled') return;
        run.finishedAt = new Date().toISOString();
        run.status = result.exitCode === null ? 'cancelled' : (result.exitCode === 0 ? 'succeeded' : 'failed');
        if (run.status === 'cancelled') { this.persist(); return; }
        const summary = await this.verifyWork(run, result.output);
        run.summary = summary;
        this.persist();
        this.callbacks.onComplete(run, summary);
      } catch (err) {
        if (run.status === 'cancelled' || abort.signal.aborted) { this.persist(); return; }
        run.status = 'failed';
        this.persist();
        this.callbacks.onComplete(run, err instanceof Error ? err.message : String(err));
      } finally {
        this.aborts.delete(runId);
      }
    })();
    return run;
  }

  cancel(runId: string): void {
    this.aborts.get(runId)?.abort();
    const run = this.runs.get(runId);
    if (run && run.status === 'running') {
      run.status = 'cancelled';
      this.persist();
    }
  }

  /** Q7: re-attach to an interrupted run that has a session id (post-reload). */
  resumeInterrupted(runId: string, followUp?: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'interrupted' || !run.sessionId) return;
    void this.followUp(runId, followUp ?? 'Continue where you left off and report status.');
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  /** Check-back: after the agent finishes, verify the work it claims to have done. */
  private async verifyWork(run: AgentRun, output: string): Promise<string> {
    const lines: string[] = [];
    lines.push(`**Agent finished (${run.agent})** exit=${run.status}`);
    if (run.sessionId) lines.push(`session: \`${run.sessionId}\``);
    lines.push('');

    // 1) What changed in git?
    try {
      const status = await this.git.getStatusPorcelain();
      lines.push('**Changed files:**');
      lines.push(status.trim() || '_no changes detected_');
    } catch (err) {
      lines.push(`_git status unavailable: ${err instanceof Error ? err.message : err}_`);
    }

    // 2) Diff stat (bounded)
    try {
      const diffStat = await this.git.getDiffStat();
      if (diffStat.trim()) {
        lines.push('**Diff stat:**');
        lines.push('```');
        lines.push(diffStat.slice(0, 2000));
        lines.push('```');
      }
    } catch { /* ignore */ }

    // 3) Run the verification command (configurable, default: none)
    const verifyCmd = vscode.workspace.getConfiguration('adoCode').get<string>('agents.verifyCommand', '');
    if (verifyCmd) {
      lines.push(`**Verification (\`${verifyCmd}\`):**`);
      // M7 fix: the verify command is USER-configured (trusted input), so shell
      // execution is defensible — but it must run via `exec` (shell) to respect
      // quotes/globs, and the plan must say so.
      const { stdout, stderr } = await execAsync(verifyCmd, run.workdir);
      lines.push('```');
      lines.push((stdout || stderr).slice(0, 2000));
      lines.push('```');
    }

    // 4) Agent's own final output (bounded)
    lines.push('**Agent output (tail):**');
    lines.push('```');
    lines.push(output.slice(-3000));
    lines.push('```');

    return lines.join('\n');
  }
}

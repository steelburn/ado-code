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

/** Q7: workspaceState-backed persistence for runs + dismissals. */
export interface AgentRunnerStore {
  save(runs: AgentRun[]): void;
  load(): AgentRun[];
  saveDismissed?(ids: string[]): void;
  loadDismissed?(): string[];
}

export class AgentRunner {
  private runs = new Map<string, AgentRun>();
  private aborts = new Map<string, AbortController>();
  // Runs the user dismissed from the chat panel — persisted so re-hydration
  // (panel remount, extension reload) does not bring them back.
  private dismissed = new Set<string>();

  constructor(
    private registry: AgentRegistry,
    private git: GitService,
    private callbacks: AgentRunnerCallbacks,
    private store?: AgentRunnerStore, // Q7: workspaceState-backed
    // Memory-driven pre/post hooks: workspace memory keys `agent.before` /
    // `agent.after` run as shell commands around each agent invocation.
    private workspaceMemory?: { read(key: string): string | null }
  ) {
    // Q7: restore persisted runs on construction (extension reload).
    const persisted = this.store?.load() ?? [];
    for (const run of persisted) {
      if (run.status === 'running') {
        run.status = 'interrupted'; // process died with the old extension host
      }
      this.runs.set(run.id, run);
    }
    // Restore dismissed run ids so they stay hidden after a reload.
    this.dismissed = new Set(this.store?.loadDismissed?.() ?? []);
  }

  private persist(): void {
    this.store?.save([...this.runs.values()]);
  }

  async delegate(workItemId: number, prompt: string, agent?: AgentName, title?: string): Promise<AgentRun> {
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

    // Create isolated worktree for this agent run. The branch is slugged from
    // the WORK ITEM TITLE (the ADO subject) when available — the prompt's
    // first line is only a fallback (it is usually "Read and follow
    // AGENTS.md…", which made ugly branch names).
    try {
      const slugSource = (title ?? prompt.split('\n')[0] ?? '').slice(0, 80) || `task-${workItemId}`;
      const branchName = this.git.getBranchName(workItemId, slugSource);
      run.branch = branchName;
      const worktreePath = await this.git.createWorktree(run.id, branchName);
      run.worktreePath = worktreePath;
      run.workdir = worktreePath; // Agent runs in its own worktree
      this.callbacks.onStatus(run, `worktree created: ${branchName}`);
    } catch (err) {
      // Fall back to main repo if worktree creation fails
      this.callbacks.onStatus(run, `worktree failed, using main repo: ${err instanceof Error ? err.message : err}`);
    }

    this.runs.set(run.id, run);
    this.persist();
    this.callbacks.onStatus(run, `delegating to ${chosen.displayName}...`);

    // Memory-driven PRE-agent hook: workspace memory key `agent.before` runs
    // in the agent's working directory before the adapter starts. Output
    // streams into the run panel; a failing hook does not block the run.
    await this.runPreHook(run);

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
    // Memory-driven PRE-agent hook also guards follow-up invocations.
    await this.runPreHook(run);
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

  /** Permanently hide a finished run from the chat panel (persisted). */
  dismiss(runId: string): void {
    if (!this.runs.has(runId)) return;
    this.dismissed.add(runId);
    this.store?.saveDismissed?.([...this.dismissed]);
  }

  /** True when the user dismissed this run from the chat panel. */
  isDismissed(runId: string): boolean {
    return this.dismissed.has(runId);
  }

  /**
   * Execute the memory-driven pre-agent hook (workspace memory key
   * `agent.before`) in the run's working directory. Output streams to the
   * run panel; failures are surfaced but never block the run.
   */
  private async runPreHook(run: AgentRun): Promise<void> {
    const hook = this.workspaceMemory?.read('agent.before')?.trim();
    if (!hook) return;
    const cwd = run.worktreePath ?? run.workdir;
    const { stdout, stderr } = await execAsync(hook, cwd);
    const hookOut = (stdout || stderr).trim();
    this.callbacks.onStatus(run, hookOut
      ? `pre-agent hook (\`${hook}\`):\n${hookOut}`
      : `pre-agent hook ran: ${hook}`);
  }

  /** Check-back: after the agent finishes, verify the work it claims to have done. */
  private async verifyWork(run: AgentRun, output: string): Promise<string> {
    const lines: string[] = [];
    lines.push(`**Agent finished (${run.agent})** exit=${run.status}`);
    if (run.sessionId) lines.push(`session: \`${run.sessionId}\``);
    if (run.branch) lines.push(`branch: \`${run.branch}\``);
    if (run.worktreePath) lines.push(`worktree: \`${run.worktreePath}\``);
    lines.push('');

    // Use worktree path for git commands if available (isolated per-agent tracking)
    const cwd = run.worktreePath ?? run.workdir;

    // 1) What changed in git?
    try {
      const status = run.worktreePath
        ? await this.git.gitInWorktree(cwd, ['status', '--porcelain'])
        : await this.git.getStatusPorcelain();
      lines.push('**Changed files:**');
      lines.push(status.trim() || '_no changes detected_');
    } catch (err) {
      lines.push(`_git status unavailable: ${err instanceof Error ? err.message : err}_`);
    }

    // 2) Diff stat (bounded)
    try {
      const diffStat = run.worktreePath
        ? await this.git.gitInWorktree(cwd, ['diff', '--stat'])
        : await this.git.getDiffStat();
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
      const { stdout, stderr } = await execAsync(verifyCmd, cwd);
      lines.push('```');
      lines.push((stdout || stderr).slice(0, 2000));
      lines.push('```');
    }

    // 4) Agent's own final output (bounded)
    lines.push('**Agent output (tail):**');
    lines.push('```');
    lines.push(output.slice(-3000));
    lines.push('```');

    // 5) Memory-driven POST-agent hook: workspace memory key `agent.after`
    // runs in the agent's working directory once the run is done; its
    // output is captured into the summary so it survives panel close/reopen.
    const afterHook = this.workspaceMemory?.read('agent.after')?.trim();
    if (afterHook) {
      lines.push(`**Post-agent hook (\`${afterHook}\`):**`);
      const { stdout, stderr } = await execAsync(afterHook, cwd);
      lines.push('```');
      lines.push((stdout || stderr).trim().slice(0, 2000) || '_no output_');
      lines.push('```');
    }

    return lines.join('\n');
  }
}

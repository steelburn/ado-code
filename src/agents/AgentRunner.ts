import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import { AgentRun, AgentName, AgentCapability } from './types';
import { AgentRegistry } from './registry';
import { createAdapter } from './adapters';
import { AgentAdapter } from './adapters/types';
import { GitService } from '../git/GitService';
import { extractDeliveryReport } from '../llm/prompts';

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
  // In-memory accumulated output per run id (bounded tail). Fed by
  // emitStatus() so the live editor progress panel (and the open-command)
  // can backfill everything streamed so far, even when opened mid-run.
  private runLogs = new Map<string, string>();
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
    private workspaceMemory?: { read(key: string): string | null },
    // Adapter factory — injectable so tests don't depend on whether a real
    // agent CLI (claude, codex, …) is installed on the machine.
    private adapterFactory: (name: AgentName) => AgentAdapter = createAdapter
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

  /**
   * Forward a status chunk to the registered callback AND accumulate it into
   * the per-run log (bounded tail) so late-openers (editor panel, reopen
   * command) see everything streamed so far. All onStatus call sites route
   * through here.
   */
  private emitStatus(run: AgentRun, delta: string): void {
    const MAX_LOG = 256 * 1024; // keep the tail — logs are a convenience, not archival
    const next = (this.runLogs.get(run.id) ?? '') + delta;
    this.runLogs.set(run.id, next.length > MAX_LOG ? next.slice(-MAX_LOG) : next);
    this.callbacks.onStatus(run, delta);
  }

  /** Accumulated output for a run ('' when nothing streamed / unknown id). */
  getRunOutput(runId: string): string {
    return this.runLogs.get(runId) ?? '';
  }

  async delegate(workItemId: number, prompt: string, agent?: AgentName, title?: string, childIds?: number[], chatSessionId?: string): Promise<AgentRun> {
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

    // Guardrail: never run two agents on the same work item concurrently —
    // both would create the same branch and stomp each other's worktree.
    const activeForItem = [...this.runs.values()].find(
      r => r.workItemId === workItemId && r.status === 'running'
    );
    if (activeForItem) {
      throw new Error(
        `work item #${workItemId} already has an active agent run (${activeForItem.agent}, ${activeForItem.id}) — finish or cancel it before delegating again`
      );
    }

    // Parent/child coordination guard: when delegating a parent WITH its
    // children, refuse if any descendant already has its own active run (both
    // would touch the same work and stomp each other) — and refuse delegating
    // an item that an active parent run already covers.
    const childIdsSet = new Set(childIds ?? []);
    const childCovered = [...this.runs.values()].find(
      r => r.status === 'running' && r.workItemId !== undefined && childIdsSet.has(r.workItemId)
    );
    if (childCovered) {
      throw new Error(
        `work item #${childCovered.workItemId} (a child of #${workItemId}) already has an active agent run (${childCovered.agent}, ${childCovered.id}) — finish or cancel it before delegating the parent`
      );
    }
    const insideParent = [...this.runs.values()].find(
      r => r.status === 'running' && (r.childIds ?? []).includes(workItemId)
    );
    if (insideParent) {
      throw new Error(
        `work item #${workItemId} is covered by the active parent run (${insideParent.agent}, ${insideParent.id}) — finish or cancel it before delegating the child separately`
      );
    }

    const workdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const run: AgentRun = {
      id: `run-${Date.now()}-${workItemId}`,
      workItemId,
      agent: chosen.name,
      // Spawn the exact executable detection verified (e.g. claude.cmd on
      // Windows npm installs) — adapters fall back to their canonical name
      // when this is absent (older persisted runs).
      bin: chosen.bin ?? chosen.name,
      title: title || '',
      workdir,
      status: 'running',
      startedAt: new Date().toISOString(),
      childIds: childIds && childIds.length > 0 ? childIds : undefined,
      chatSessionId,
    };

    // Create isolated worktree for this agent run. The branch is slugged from
    // the WORK ITEM TITLE (the ADO subject) when available — the prompt's
    // first line is only a fallback (it is usually "Read and follow
    // AGENTS.md…", which made ugly branch names).
    try {
      const slugSource = (title ?? prompt.split('\n')[0] ?? '').slice(0, 80) || `task-${workItemId}`;
      const branchName = this.git.getBranchName(workItemId, slugSource);
      // Guardrail: reusing a branch that predates the current base means the
      // agent works from stale code — surface a warning but continue. The
      // guard must NEVER break run setup (wrapped defensively).
      try {
        if (await this.git.branchExists(branchName)) {
          const upToDate = await this.git.isBranchUpToDate(branchName);
          if (!upToDate) {
            const warn = `warning: branch '${branchName}' already exists and is behind the base branch — this run will continue from outdated code`;
            this.emitStatus(run, warn);
          }
        }
      } catch {
        // Guard helpers unavailable (e.g. minimal fakes) — skip the warning.
      }
      run.branch = branchName;
      const worktreePath = await this.git.createWorktree(run.id, branchName);
      run.worktreePath = worktreePath;
      run.workdir = worktreePath; // Agent runs in its own worktree
      this.emitStatus(run, `worktree created: ${branchName}`);
    } catch (err) {
      // Fall back to main repo if worktree creation fails
      this.emitStatus(run, `worktree failed, using main repo: ${err instanceof Error ? err.message : err}`);
    }

    this.runs.set(run.id, run);
    this.persist();
    this.emitStatus(run, `delegating to ${chosen.displayName}...`);

    // Memory-driven PRE-agent hook: workspace memory key `agent.before` runs
    // in the agent's working directory before the adapter starts. Output
    // streams into the run panel; a failing hook does not block the run.
    await this.runPreHook(run);

    const abort = new AbortController();
    this.aborts.set(run.id, abort);
    const adapter = this.adapterFactory(chosen.name);

    // Fire and forget; result delivered via callback
    void (async () => {
      try {
        const { exitCode, output } = await adapter.runTask(run, prompt, abort.signal, (chunk) => {
          this.emitStatus(run, chunk);
        });
        // H7 fix: if cancelled mid-run, do NOT overwrite the status or run verifyWork.
        if (run.status === 'cancelled') return;
        run.sessionId = adapter.extractSessionId?.(output);
        run.finishedAt = new Date().toISOString();
        // H7 fix: a null exit code on abort means the process was killed — mark cancelled, not succeeded.
        run.status = exitCode === null ? 'cancelled' : (exitCode === 0 ? 'succeeded' : 'failed');
        if (run.status === 'cancelled') { this.persist(); return; }
        // Parent delegation: capture the agent's Delivery Report so the
        // post-run child-completion sync can transition ADO states per child.
        if (run.status === 'succeeded') {
          run.deliveryReport = extractDeliveryReport(output);
        }
        // H8 fix: persist the output tail so interrupted runs have something to show.
        // Fire-and-forget: output file is a convenience, not required — don't block
        // the completion path on vscode.workspace.fs (which can hang in test env).
        void this.writeOutput(run.id, output).then(p => { run.outputFile = p; }).catch(() => {});
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
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();
      const dir = vscode.Uri.joinPath(vscode.Uri.file(workspacePath), '.ado-code', 'runs');
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
            this.emitStatus(run, chunk);
          });
        } else {
          // H13 fix: synthesized follow-up for agents without session resume
          // (codex, aider, pi, openclaw, cursor-agent, dsh): re-run one-shot with
          // the previous summary + the follow-up prompt as context.
          const context = `[Previous run summary]\n${run.summary ?? '(no summary)'}\n\n[Follow-up request]\n${followUpPrompt}`;
          result = await adapter.runTask(run, context, abort.signal, (chunk) => {
            this.emitStatus(run, chunk);
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
      // Notify listeners of the transition (webview panel status + working
      // indicator) — the async IIFE bails early on cancelled and never fires
      // onComplete, so this is the only status signal for a cancelled run.
      this.emitStatus(run, 'cancelled by user');
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
    this.emitStatus(run, hookOut
      ? `pre-agent hook (\`${hook}\`):\n${hookOut}`
      : `pre-agent hook ran: ${hook}`);
  }

  /** Check-back: after the agent finishes, verify the work it claims to have done. */
  private async verifyWork(run: AgentRun, output: string): Promise<string> {
    try {
      return await this._verifyWorkInner(run, output);
    } catch (err) {
      // Safety net: if any section of verifyWork throws (e.g. VS Code API
      // unavailable in test env), return a minimal summary instead of crashing.
      return `**Agent finished (${run.agent})** exit=${run.status}\n\n_verifyWork failed: ${err instanceof Error ? err.message : err}_`;
    }
  }

  private async _verifyWorkInner(run: AgentRun, output: string): Promise<string> {
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
    let verifyCmd = '';
    try {
      verifyCmd = vscode.workspace.getConfiguration('adoCode').get<string>('agents.verifyCommand', '') ?? '';
    } catch {
      // VS Code API may not be available in test environments
    }
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

/**
 * Host-side half of the /new-project dependency check.
 *
 * `checkProjectDependencies()` probes the machine for the tools the selected
 * template needs and turns the plan from `src/shared/projectDependencies.ts`
 * into a report the wizard can render. `runAutoInstalls()` executes the
 * steps the host *can* do autonomously (project packages) inside the freshly
 * scaffolded folder.
 *
 * Rules of the house: never throw (the caller posts the failure as an `error`
 * field, the wizard degrades to a soft warning) and never block project
 * creation — a missing toolchain is guidance, not a veto.
 */

import { execFile } from 'child_process';
import {
  AutoInstallStep,
  DependencyReport,
  DependencySpec,
  DependencyStatus,
  ProjectDependencyPlan,
  guidanceFor,
  meetsMinimum,
  parseVersion,
  planForTemplate,
} from '../shared/projectDependencies';
import { resolveShellEnv } from '../shared/shellEnv';

export interface CommandOutcome {
  ok: boolean;
  output: string;
  error?: string;
}

/** Injectable so the tests never spawn a process. */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandOutcome>;

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Real runner. `shell: true` on win32 so `npm`/`pnpm` resolve to their `.cmd`
 * shims (`npm --version` via execFile without a shell → ENOENT). The arguments
 * are all literals from the spec table — nothing user-supplied reaches a shell.
 *
 * `env` is the freshly resolved block from `shellEnv.ts` (see CheckOptions);
 * without it the child inherits the block VS Code was started with.
 */
export const execRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise<CommandOutcome>(resolve => {
    try {
      execFile(
        cmd,
        args,
        {
          cwd: opts.cwd,
          env: opts.env,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          windowsHide: true,
          shell: process.platform === 'win32',
          maxBuffer: 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`.trim();
          if (err) {
            resolve({
              ok: false,
              output,
              error: err.code === 'ENOENT' ? 'not found on PATH' : String(err.message || err),
            });
            return;
          }
          resolve({ ok: true, output });
        },
      );
    } catch (e) {
      resolve({ ok: false, output: '', error: (e as Error)?.message || String(e) });
    }
  });

/** Probe one spec, trying each candidate command until one answers. */
async function probeSpec(
  spec: DependencySpec,
  run: CommandRunner,
  platform: string,
  env?: NodeJS.ProcessEnv,
): Promise<DependencyStatus> {
  const guidance = guidanceFor(spec, platform);
  let lastError = 'not found on PATH';

  for (const probe of spec.probes) {
    const outcome = await run(probe.cmd, probe.args, { timeoutMs: DEFAULT_TIMEOUT_MS, env });
    if (!outcome.ok) {
      lastError = outcome.error || lastError;
      continue;
    }
    const version = parseVersion(outcome.output);
    const ok = meetsMinimum(version, spec.minVersion);
    return {
      id: spec.id,
      label: spec.label,
      why: spec.why,
      kind: spec.kind,
      required: spec.required,
      ok,
      version,
      minVersion: spec.minVersion,
      guidance,
      url: spec.install?.url,
      note: spec.install?.note,
      error: ok
        ? undefined
        : `found ${version ?? 'an unreadable version'}, need ${spec.minVersion}+`,
    };
  }

  return {
    id: spec.id,
    label: spec.label,
    why: spec.why,
    kind: spec.kind,
    required: spec.required,
    ok: false,
    minVersion: spec.minVersion,
    guidance,
    url: spec.install?.url,
    note: spec.install?.note,
    error: lastError,
  };
}

export interface CheckOptions {
  run?: CommandRunner;
  platform?: string;
  /**
   * Environment for the probes. Omitted -> a fresh PATH is resolved once for
   * the whole round (`shellEnv.ts`), so a toolchain installed after VS Code
   * started is found without restarting it. `false` keeps the inherited
   * block — the tests use it because they inject their own runner.
   */
  env?: NodeJS.ProcessEnv | false;
  /** Cancels a long probe round (the wizard re-checked with another template). */
  isCancelled?: () => boolean;
}

/** Full report for a template; the `error` field is set instead of throwing. */
export async function checkProjectDependencies(
  templateId: string,
  options: Record<string, unknown> = {},
  planOptions: { gitInit?: boolean } = {},
  opts: CheckOptions = {},
): Promise<DependencyReport> {
  const run = opts.run ?? execRunner;
  const platform = opts.platform ?? process.platform;
  const plan: ProjectDependencyPlan = planForTemplate(templateId, options, planOptions);

  try {
    const env = opts.env === false ? undefined : opts.env ?? (await resolveShellEnv({ platform }));
    const checks: DependencyStatus[] = [];
    for (const spec of plan.checks) {
      if (opts.isCancelled?.()) break;
      checks.push(await probeSpec(spec, run, platform, env));
    }
    return {
      platform,
      checks,
      autoInstall: plan.autoInstall,
      missingRequired: checks.filter(c => !c.ok && c.required).map(c => c.label),
      missingOptional: checks.filter(c => !c.ok && !c.required).map(c => c.label),
    };
  } catch (e) {
    return {
      platform,
      checks: [],
      autoInstall: plan.autoInstall,
      missingRequired: [],
      missingOptional: [],
      error: (e as Error)?.message || String(e),
    };
  }
}

export interface AutoInstallOutcome {
  id: string;
  label: string;
  ok: boolean;
  /** Tail of stdout/stderr, trimmed — surfaced in the wizard warnings. */
  output: string;
}

/**
 * Runs the autonomous steps inside `projectDir`. Steps whose `requiresFile` is
 * absent from the scaffold are skipped silently (a Python template without a
 * requirements.txt has nothing to install). Never throws.
 */
export async function runAutoInstalls(
  projectDir: string,
  steps: AutoInstallStep[],
  opts: {
    run?: CommandRunner;
    fileExists?: (p: string) => boolean;
    /** Same contract as `CheckOptions.env`. */
    env?: NodeJS.ProcessEnv | false;
  } = {},
): Promise<AutoInstallOutcome[]> {
  const run = opts.run ?? execRunner;
  const fileExists = opts.fileExists;
  // Nothing to install: do not pay for the PATH lookup.
  if (steps.length === 0) return [];
  const env = opts.env === false ? undefined : opts.env ?? (await resolveShellEnv());
  const results: AutoInstallOutcome[] = [];

  for (const step of steps) {
    if (step.requiresFile && fileExists && !fileExists(step.requiresFile)) {
      results.push({ id: step.id, label: step.label, ok: true, output: `skipped (no ${step.requiresFile})` });
      continue;
    }
    try {
      const outcome = await run(step.cmd, step.args, { cwd: projectDir, timeoutMs: 180000, env });
      results.push({
        id: step.id,
        label: step.label,
        ok: outcome.ok,
        output: outcome.ok ? 'ok' : String(outcome.error || outcome.output || 'failed').slice(0, 400),
      });
    } catch (e) {
      results.push({ id: step.id, label: step.label, ok: false, output: ((e as Error)?.message || String(e)).slice(0, 400) });
    }
  }
  return results;
}

/** Warnings for the wizard result: one line per failed autonomous step. */
export function autoInstallWarnings(outcomes: AutoInstallOutcome[]): string[] {
  return outcomes.filter(o => !o.ok).map(o => `Dependency install failed — ${o.label}: ${o.output}`);
}

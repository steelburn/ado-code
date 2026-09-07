import * as cp from 'child_process';
import * as vscode from 'vscode';
import { promisify } from 'util';
import { AgentCapability, AgentName } from './types';
import { agentBinCandidates } from './resolveBin';

const execFile = promisify(cp.execFile);

/**
 * Detection results are re-probed once this long after the last probe, so a
 * CLI installed (or updated) while VS Code is already running is picked up
 * without reloading the window. Cheap: every probe is an execFile that either
 * answers or ENOENTs in milliseconds; only binaries that HANG burn the 5s
 * timeout, so frequent re-probing costs almost nothing.
 */
export const DETECT_TTL_MS = 15_000;

export interface AgentSpec {
  name: AgentName;
  displayName: string;
  bin: string;               // binary to probe
  versionFlag: string[];
  oneShot: () => string[];   // base args for one-shot run
  session: () => string[];   // base args for session mode
  /** M11 fix: whether the CLI supports session resume (drives Follow-up UI). */
  supportsSession: boolean;
}

export const AGENT_SPECS: Record<AgentName, AgentSpec> = {
  claude: {
    name: 'claude', displayName: 'Claude Code',
    bin: 'claude', versionFlag: ['--version'],
    oneShot: () => ['-p', '--output-format', 'json', '--max-turns', '20'],
    session: () => ['--output-format', 'stream-json'],
    supportsSession: true,
  },
  codex: {
    name: 'codex', displayName: 'Codex CLI',
    bin: 'codex', versionFlag: ['--version'],
    oneShot: () => ['exec', '--sandbox', 'workspace-write', '--json'],
    session: () => ['exec', '--sandbox', 'workspace-write'],
    supportsSession: false, // no session resume — synthesized follow-up (H13)
  },
  opencode: {
    name: 'opencode', displayName: 'OpenCode',
    bin: 'opencode', versionFlag: ['--version'],
    oneShot: () => ['run', '--format', 'json'],
    session: () => ['run'],
    supportsSession: true,
  },
  hermes: {
    name: 'hermes', displayName: 'Hermes Agent',
    bin: 'hermes', versionFlag: ['--version'],
    oneShot: () => ['chat', '-q'],
    session: () => ['chat'],
    supportsSession: true, // hermes chat --continue
  },
  pi: {
    name: 'pi', displayName: 'Pi',
    bin: 'pi', versionFlag: ['--version'],
    oneShot: () => ['-p'],
    session: () => [],
    supportsSession: false,
  },
  openclaw: {
    name: 'openclaw', displayName: 'OpenClaw',
    bin: 'openclaw', versionFlag: ['--version'],
    oneShot: () => ['-p'],
    session: () => [],
    supportsSession: false,
  },
  // ── Q9 resolution: additional v1 agents ───────────────────────────
  aider: {
    name: 'aider', displayName: 'Aider',
    bin: 'aider', versionFlag: ['--version'],
    oneShot: () => ['--message'], // aider --message "<prompt>" --no-git
    session: () => [],
    supportsSession: false,
  },
  gemini: {
    name: 'gemini', displayName: 'Gemini CLI',
    bin: 'gemini', versionFlag: ['--version'],
    oneShot: () => ['-p'],
    session: () => ['-c'], // resume most recent session
    supportsSession: true,
  },
  'cursor-agent': {
    name: 'cursor-agent', displayName: 'Cursor Agent',
    bin: 'cursor-agent', versionFlag: ['--version'],
    oneShot: () => ['exec'],
    session: () => [],
    supportsSession: false,
  },
  dsh: {
    name: 'dsh', displayName: 'DeepSeek Harness',
    bin: 'dsh', versionFlag: ['--version'],
    oneShot: () => ['--profile', 'headless', '--'], // dsh --profile headless -- "<prompt>"
    session: () => [],
    supportsSession: false, // headless profile is one-shot only (H13 synthesized follow-up)
  },
};

/**
 * The previous default `agents.enabled` list (before DeepSeek Harness was
 * registered). Users whose stored value is EXACTLY this list predate dsh —
 * their allowlist silently disables it (dsh is never probed).
 */
export const PRE_DSH_ENABLED_DEFAULT: string[] = [
  'claude', 'codex', 'opencode', 'hermes', 'pi', 'openclaw', 'aider', 'gemini', 'cursor-agent',
];

/**
 * Migrate a stale `agents.enabled` value (0.6.0): when the stored list is
 * exactly the pre-dsh default, treat it as unset so newly-registered agents
 * (dsh) are probed too. Custom pruned lists are returned unchanged — explicit
 * pruning is always respected. Pure + in-memory (no config writes).
 */
export function migrateEnabledAgents(enabled: string[]): string[] {
  if (
    enabled.length > 0
    && !enabled.includes('dsh')
    && enabled.length === PRE_DSH_ENABLED_DEFAULT.length
    && PRE_DSH_ENABLED_DEFAULT.every(a => enabled.includes(a))
  ) {
    return Object.keys(AGENT_SPECS);
  }
  return enabled;
}

export class AgentRegistry {
  private cache?: AgentCapability[];
  private cachedAt = 0;

  // Clock injectable for tests (TTL expiry without waiting).
  constructor(private now: () => number = Date.now) {}

  async detect(): Promise<AgentCapability[]> {
    const now = this.now();
    if (this.cache && now - this.cachedAt < DETECT_TTL_MS) return this.cache;
    // M3/M17: honor adoCode.agents.enabled — disabled agents are never probed.
    let enabled: string[] = [];
    try {
      enabled = vscode.workspace.getConfiguration('adoCode').get<string[]>('agents.enabled', []);
      enabled = migrateEnabledAgents(enabled);
    } catch {
      // not running inside VS Code (tests) — probe everything
      enabled = Object.keys(AGENT_SPECS);
    }
    const caps: AgentCapability[] = [];
    for (const spec of Object.values(AGENT_SPECS)) {
      if (enabled.length > 0 && !enabled.includes(spec.name)) {
        caps.push({ name: spec.name, displayName: spec.displayName, installed: false, version: undefined, modes: ['one-shot'] });
        continue;
      }
      // Try every executable shape the CLI could ship as — `.cmd` npm shim →
      // native `.exe` → bare name — and record the EXACT executable that
      // answered, so delegation spawns the same binary the probe verified
      // (adapters resolve run.bin via resolveSpawn).
      let found: { bin: string; version: string } | undefined;
      for (const candidate of agentBinCandidates(spec.bin, process.platform)) {
        try {
          // M12/M-7 fix: on Windows, npm-installed CLIs ship as .cmd shims;
          // execFile can't execute .cmd without shell:true — probe with a
          // shell on win32 (args are static version flags, no injection risk).
          const { stdout } = await execFile(candidate, spec.versionFlag, {
            timeout: 5000,
            shell: process.platform === 'win32',
          });
          found = { bin: candidate, version: stdout.trim().split('\n')[0] };
          break;
        } catch {
          // try the next candidate shape
        }
      }
      if (found) {
        caps.push({
          name: spec.name,
          displayName: spec.displayName,
          installed: true,
          version: found.version,
          bin: found.bin,
          modes: spec.supportsSession ? ['one-shot', 'session'] : ['one-shot'],
        });
      } else {
        caps.push({ name: spec.name, displayName: spec.displayName, installed: false, version: undefined, modes: ['one-shot'] });
      }
    }
    this.cache = caps;
    this.cachedAt = now;
    return caps;
  }

  async getInstalled(): Promise<AgentCapability[]> {
    const all = await this.detect();
    return all.filter(c => c.installed);
  }

  clearCache(): void {
    this.cache = undefined;
    this.cachedAt = 0;
  }
}

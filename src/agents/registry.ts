import * as cp from 'child_process';
import * as vscode from 'vscode';
import { promisify } from 'util';
import { AgentCapability, AgentName } from './types';

const execFile = promisify(cp.execFile);

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

export class AgentRegistry {
  private cache?: AgentCapability[];

  async detect(): Promise<AgentCapability[]> {
    if (this.cache) return this.cache;
    // M3/M17: honor adoCode.agents.enabled — disabled agents are never probed.
    let enabled: string[] = [];
    try {
      enabled = vscode.workspace.getConfiguration('adoCode').get<string[]>('agents.enabled', []);
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
      try {
        // M12 fix: on Windows, npm-installed CLIs ship as .cmd shims.
        // M-7 fix: execFile can't execute .cmd without shell:true — probe with
        // a shell on win32 (args are static version flags, no injection risk).
        const bin = process.platform === 'win32' ? `${spec.bin}.cmd` : spec.bin;
        const { stdout } = await execFile(bin, spec.versionFlag, {
          timeout: 5000,
          shell: process.platform === 'win32',
        });
        caps.push({
          name: spec.name,
          displayName: spec.displayName,
          installed: true,
          version: stdout.trim().split('\n')[0],
          modes: spec.supportsSession ? ['one-shot', 'session'] : ['one-shot'],
        });
      } catch {
        caps.push({ name: spec.name, displayName: spec.displayName, installed: false, version: undefined, modes: ['one-shot'] });
      }
    }
    this.cache = caps;
    return caps;
  }

  async getInstalled(): Promise<AgentCapability[]> {
    const all = await this.detect();
    return all.filter(c => c.installed);
  }

  clearCache(): void {
    this.cache = undefined;
  }
}

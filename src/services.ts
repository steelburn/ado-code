import * as vscode from 'vscode';
import { AdoClient } from './ado/client';
import { getSettings, getActiveOrg } from './config/settings';

// ── C6 stubs (real implementations land in Tasks 9/10/11) ──────────
export class GitService {
  constructor(public readonly workspaceRoot: string) {}
  async isGitRepo(): Promise<boolean> { return false; }
  async getCurrentBranch(): Promise<string | null> { return null; }
  async getShortCommitHash(): Promise<string | null> { return null; }
  async hasUncommittedChanges(): Promise<boolean> { return true; }
  async createTaskBranch(_id: number, _title: string): Promise<string | null> { return null; }
}

export class ChangelogService {
  constructor(private workspaceRoot: string) {}
  async addEntry(_entry: any): Promise<string> { return `${this.workspaceRoot}/CHANGELOG.md`; }
  hasEntry(_id: number): boolean { return false; }
  formatForAdo(_entry: any): string { return ''; }
}

export interface Services {
  ado: AdoClient;
  git: GitService;
  changelog: ChangelogService;
}

/**
 * Build the services for the current workspace. Services that depend on
 * configuration (ADO org/PAT, workspace root) are recreated on
 * `onDidChangeConfiguration` / workspace change.
 */
export function createServices(context: vscode.ExtensionContext): Services {
  const settings = getSettings();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  // Q1: the active org is per-workspace (workspaceState), set by
  // selectActiveOrganization() and resolved by getActiveOrg(). Q2: adoServerUrl
  // (via getActiveOrgBaseUrl) supports on-prem ADO Server.
  const active = getActiveOrg(context, settings);

  // C8 fix: never throw at activation on unconfigured settings — a fresh
  // install has empty org/PAT, and Task 19's welcome view must still render.
  // AdoClient is constructed lazily (first use) so the extension activates
  // cleanly; callers guard with the refreshWorkItems config check.
  // C10 fix: use the per-org URL (active.url) — a per-org on-prem/cloud URL
  // wins over the global adoServerUrl.
  let adoClient: AdoClient | null = null;
  const ado: AdoClient = new Proxy({} as AdoClient, {
    get(_t, prop) {
      if (!adoClient) {
        adoClient = new AdoClient(active.name, settings.adoPat, active.url);
      }
      return (adoClient as any)[prop];
    },
  });

  return {
    ado,
    git: new GitService(workspaceRoot),
    changelog: new ChangelogService(workspaceRoot),
  };
}

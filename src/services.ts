import * as vscode from 'vscode';
import { AdoClient } from './ado/client';
import { GitService } from './git/GitService';
import { ChangelogService } from './changelog/ChangelogService';
import { AgentRegistry } from './agents/registry';
import { CheckpointService } from './services/checkpoints/CheckpointService';
import { McpManager } from './services/mcp/McpManager';
import { SkillManager } from './services/SkillManager';
import { SkillRegistryService } from './services/SkillRegistryService';
import { ProjectCreationService } from './webview/ProjectCreationService';
import { WorkspaceMemory } from './memory/WorkspaceMemory';
import { UnderstandingService } from './services/understanding/UnderstandingService';
import { getSettings, getActiveOrg } from './config/settings';
import { UserMemory } from './memory/UserMemory';
import { logger } from './services/logger';

// ── C6 stubs (real implementations land in Tasks 9/10/11) ──────────
// GitService + ChangelogService stubs REMOVED in Tasks 10/11 — real classes
// imported above.

export interface Services {
  ado: AdoClient;
  git: GitService;
  changelog: ChangelogService;
  agents: AgentRegistry;
  checkpoints: CheckpointService;
  mcp: McpManager;
  skills: SkillManager;
  skillRegistry: SkillRegistryService;
  projectCreation: ProjectCreationService;
  workspaceMemory: WorkspaceMemory;
  memory: UserMemory;
  /** Durable, fingerprinted cache of repository + work-item understanding. */
  understanding: UnderstandingService;
  logger: typeof logger;
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

  // Services that later services depend on (git + workspaceMemory feed the
  // understanding cache) are created first.
  const git = new GitService(workspaceRoot);
  const workspaceMemory = new WorkspaceMemory(workspaceRoot);

  return {
    ado,
    git,
    changelog: new ChangelogService(workspaceRoot),
    agents: new AgentRegistry(),
    checkpoints: new CheckpointService(workspaceRoot),
    mcp: new McpManager(context),
    skills: new SkillManager(context),
    skillRegistry: new SkillRegistryService(context),
    projectCreation: new ProjectCreationService(),
    workspaceMemory,
    memory: new UserMemory(context),
    understanding: new UnderstandingService(workspaceRoot, git, workspaceMemory),
    logger,
  };
}

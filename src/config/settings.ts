import * as vscode from 'vscode';
import { DEFAULT_MAX_ITERATIONS } from '../shared/agenticLimits';

export type LlmProvider = 'openai' | 'anthropic';

export interface AdoCodeSettings {
  organizations: Array<{ name: string; url: string; project: string }>;
  adoOrganization: string;
  adoProject: string;
  adoServerUrl: string;
  adoPat: string;
  llmProvider: LlmProvider;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Optional cheaper model for AI choice-prompt detection ('' = main model). */
  llmChoiceDetectionModel: string;
  /** Per-model capability overrides — user knowledge beats heuristics. */
  llmCapabilityOverrides: Array<{ model: string; vision?: boolean; tools?: boolean }>;
  /** Enable Advanced Configuration mode (per-mode model + reasoning effort). */
  advancedConfig: boolean;
  /** Per-mode model overrides — keys: inline, plan, act, yolo. */
  llmModeConfigs: Record<string, { model: string }>;
  /** Per-mode reasoning effort — keys: inline, plan, act, yolo; values: low, medium, high. */
  llmModeReasoningEffort: Record<string, string>;
  mode: 'inline' | 'plan' | 'act';
  /** Max agentic loop iterations per chat turn (config key 'act.toolBudget' — legacy name kept). */
  actMaxIterations: number;
  actTerminalAllowlist: string[];
  gitRequireGitRepo: boolean;
  gitCreateBranchOnTaskStart: boolean;
  gitRequireCleanTree: boolean;
  gitPrOnCompletion: boolean;
  /** Branches create_pull_request must never target (default main/master). */
  gitProtectedBranches: string[];
  changelogEnabled: boolean;
  changelogAutoCommit: boolean;
  changelogPostToAdo: boolean;
  adoClarificationState: string;
  adoWarnOnSparseTask: boolean;
  ignoreDotAdoCode: boolean;
  agentsAutoReview: boolean;
  consentHarmlessAutoApprove: boolean;
  consentHarmlessAutoApproveSeconds: number;
  /** Tool-name glob patterns auto-approved without a consent prompt (e.g. "read_*", "get_*"). */
  consentAutoApproveTools: string[];
  chatShowThinking: boolean;
  /** Hide the live tool-call cards in the chat (running/completed cards still execute normally). */
  chatShowToolCalls: boolean;
  /** Use provider-native token counting (Anthropic count_tokens; OpenAI-compatible via usage.prompt_tokens) for status-bar accuracy. */
  useNativeTokenCounting: boolean;
  /** Cache repository + work-item understanding in .ado-code/understanding/ and inject it into chat + agent handoffs. */
  understandingEnabled: boolean;
  /** Regenerate the LLM repository summary automatically when the repo fingerprint changes. */
  understandingAutoSummarize: boolean;
  /** Offer to generate AGENTS.md when missing and update it when the repository understanding shows it outdated. */
  agentsMdSync: boolean;
}

export function getSettings(): AdoCodeSettings {
  const config = vscode.workspace.getConfiguration('adoCode');
  const llmProvider = config.get<LlmProvider>('llmProvider', 'openai');
  return {
    organizations: config.get<Array<{ name: string; url: string; project: string }>>('organizations', []),
    adoOrganization: config.get<string>('adoOrganization', ''),
    adoProject: config.get<string>('adoProject', ''),
    adoServerUrl: config.get<string>('adoServerUrl', ''),
    adoPat: config.get<string>('adoPat', ''),
    llmProvider,
    llmApiUrl: config.get<string>('llmApiUrl', 'https://api.openai.com/v1'),
    llmApiKey: config.get<string>('llmApiKey', ''),
    llmModel: config.get<string>('llmModel', 'gpt-4o'),
    llmChoiceDetectionModel: config.get<string>('llm.choiceDetectionModel', ''),
    llmCapabilityOverrides: config.get<Array<{ model: string; vision?: boolean; tools?: boolean }>>('llm.capabilityOverrides', []),
    advancedConfig: config.get<boolean>('advancedConfig', false),
    llmModeConfigs: config.get<Record<string, { model: string }>>('llm.modeConfigs', {}),
    llmModeReasoningEffort: config.get<Record<string, string>>('llm.modeReasoningEffort', {}),
    mode: config.get<'inline' | 'plan' | 'act'>('mode', 'inline'),
    actMaxIterations: config.get<number>('act.toolBudget', DEFAULT_MAX_ITERATIONS),
    actTerminalAllowlist: config.get<string[]>('act.terminalAllowlist', ['npm test', 'npm run lint', 'git diff', 'git status']),
    gitRequireGitRepo: config.get<boolean>('git.requireGitRepo', true),
    gitCreateBranchOnTaskStart: config.get<boolean>('git.createBranchOnTaskStart', true),
    gitRequireCleanTree: config.get<boolean>('git.requireCleanTree', false),
    gitPrOnCompletion: config.get<boolean>('git.prOnCompletion', false),
    gitProtectedBranches: config.get<string[]>('git.protectedBranches', ['main', 'master']),
    changelogEnabled: config.get<boolean>('changelog.enabled', true),
    changelogAutoCommit: config.get<boolean>('changelog.autoCommit', true),
    changelogPostToAdo: config.get<boolean>('changelog.postToAdo', true),
    adoClarificationState: config.get<string>('ado.clarificationState', 'Blocked'),
    adoWarnOnSparseTask: config.get<boolean>('ado.warnOnSparseTask', true),
    ignoreDotAdoCode: config.get<boolean>('ignore.dotAdoCode', true),
    agentsAutoReview: config.get<boolean>('agents.autoReview', true),
    consentHarmlessAutoApprove: config.get<boolean>('consent.harmlessAutoApprove', false),
    consentHarmlessAutoApproveSeconds: config.get<number>('consent.harmlessAutoApproveSeconds', 20),
    consentAutoApproveTools: config.get<string[]>('consent.autoApproveTools', []),
    chatShowThinking: config.get<boolean>('chat.showThinking', true),
    chatShowToolCalls: config.get<boolean>('chat.showToolCalls', true),
    // A1: the DECLARED default is false; the host additionally forces native
    // counting ON for Anthropic (its /count_tokens endpoint is free), so this
    // setting only matters as an explicit opt-in for OpenAI-compatible
    // gateways that bill a tiny request per count.
    useNativeTokenCounting: config.get<boolean>('llm.useNativeTokenCounting', false),
    understandingEnabled: config.get<boolean>('understanding.enabled', true),
    understandingAutoSummarize: config.get<boolean>('understanding.autoSummarize', true),
    agentsMdSync: config.get<boolean>('understanding.agentsMdSync', true),
  };
}

/** Select which configured organization is active for this workspace. */
export async function selectActiveOrganization(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  if (settings.organizations.length === 0) return;
  const current = getActiveOrg(context, settings);
  const pick = await vscode.window.showQuickPick(
    settings.organizations.map(o => ({ label: o.name, description: o.project, detail: o.url })),
    { placeHolder: `Active org: ${current?.name ?? 'none'}`, ignoreFocusOut: true }
  );
  if (!pick) return;
  const org = settings.organizations.find(o => o.name === pick.label);
  if (!org) return;
  // Persist BOTH the org name and its default project so createServices
  // (Task 8) reads consistent values.
  await context.workspaceState.update('adoCode.activeOrgName', org.name);
  await context.workspaceState.update('adoCode.activeProject', org.project);
}

/** Resolve the ACTIVE org + project (workspaceState first, settings fallback).
 * Only NON-EMPTY workspaceState bindings win: an empty or stale stored value
 * (e.g. a wizard save that stored '' for adoProject, or an org-switch binding
 * from before a Configuration-page save) must never shadow the settings that
 * the Configuration page / setup wizard just wrote — otherwise PAT/org/project
 * updates silently stop taking effect and ADO gates fail with "configure
 * organization, project and PAT first". */
export function getActiveOrg(context: vscode.ExtensionContext, settings: AdoCodeSettings): { name: string; project: string; url: string } {
  // Defensive: workspaceState may be undefined in test environments.
  const ws = context.workspaceState;
  const storedName = ws?.get<string>('adoCode.activeOrgName') || '';
  const storedProject = ws?.get<string>('adoCode.activeProject') || '';
  const name = storedName || settings.adoOrganization;
  const project = storedProject || settings.adoProject;
  const configured = settings.organizations.find(o => o.name === name);
  return {
    name,
    project,
    // C10: per-org URL wins; fall back to global server URL / cloud.
    // H-4 fix: the cloud fallback MUST use the ACTIVE org name, not the
    // settings default — getActiveOrgBaseUrl(settings, name).
    url: configured?.url || getActiveOrgBaseUrl(settings, name),
  };
}

/** Resolve the ACTIVE org base URL: per-org configured URL wins (getActiveOrg),
 * else global adoServerUrl (on-prem, Q2), else cloud from the ACTIVE org name
 * (H-4: pass the active name explicitly — settings.adoOrganization may be stale). */
export function getActiveOrgBaseUrl(settings: AdoCodeSettings, activeName?: string): string {
  if (settings.adoServerUrl) return settings.adoServerUrl;
  return `https://dev.azure.com/${activeName ?? settings.adoOrganization}`;
}

/** Build an LlmConfig from current settings (Task 13). */
export function llmConfigFromSettings(mode?: string): any {
  const s = getSettings();
  // In advanced mode, resolve per-mode model override
  let model = s.llmModel;
  let reasoningEffort: string | undefined;
  if (s.advancedConfig && mode && s.llmModeConfigs[mode]?.model) {
    model = s.llmModeConfigs[mode].model;
  }
  if (s.advancedConfig && mode && s.llmModeReasoningEffort[mode]) {
    reasoningEffort = s.llmModeReasoningEffort[mode];
  }
  return {
    provider: s.llmProvider,
    apiUrl: s.llmApiUrl,
    apiKey: s.llmApiKey,
    model,
    reasoningEffort,
  };
}

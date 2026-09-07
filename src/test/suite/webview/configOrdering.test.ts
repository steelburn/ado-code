import * as assert from 'assert';
import * as vscode from 'vscode';
import { getActiveOrg, AdoCodeSettings } from '../../../config/settings';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

// Regression: PAT / org / project updates from the Configuration page must
// take effect even when the workspace carries an empty or stale active-org
// binding in workspaceState. getActiveOrg consulted workspaceState FIRST and
// honored stored EMPTY strings, so an empty binding (e.g. left by a wizard
// save with no project) shadowed the settings forever → every ADO gate bailed
// with "configure organization, project and PAT first" even though the new PAT
// was saved — the user had to re-run the setup wizard to recover.

function settingsWith(partial: Partial<AdoCodeSettings>): AdoCodeSettings {
  return {
    organizations: [],
    adoOrganization: '',
    adoProject: '',
    adoServerUrl: '',
    adoPat: '',
    llmProvider: 'openai',
    llmApiUrl: '',
    llmApiKey: '',
    llmModel: 'gpt-4o',
    llmChoiceDetectionModel: '',
    llmCapabilityOverrides: [],
    advancedConfig: false,
    llmModeConfigs: {},
    llmModeReasoningEffort: {},
    mode: 'inline',
    actMaxIterations: 20,
    actTerminalAllowlist: [],
    gitRequireGitRepo: true,
    gitCreateBranchOnTaskStart: true,
    gitRequireCleanTree: false,
    gitPrOnCompletion: false,
    gitProtectedBranches: ['main', 'master'],
    changelogEnabled: true,
    changelogAutoCommit: true,
    changelogPostToAdo: true,
    adoClarificationState: 'Blocked',
    adoWarnOnSparseTask: true,
    ignoreDotAdoCode: true,
    agentsAutoReview: true,
    consentHarmlessAutoApprove: false,
    consentHarmlessAutoApproveSeconds: 20,
    consentAutoApproveTools: [],
    chatShowThinking: true,
    chatShowToolCalls: true,
    useNativeTokenCounting: false,
    understandingEnabled: true,
    understandingAutoSummarize: true,
    agentsMdSync: true,
    ...partial,
  };
}

function ctxWithState(state: Record<string, unknown>): any {
  return {
    workspaceState: {
      get: (key: string) => state[key],
      update: async (key: string, value: unknown) => { state[key] = value; },
    },
  };
}

suite('getActiveOrg empty-binding fallback', () => {
  test('empty stored bindings fall back to settings (the PAT-save blocker)', () => {
    const settings = settingsWith({ adoOrganization: 'myorg', adoProject: 'MyProj', adoPat: 'NEW-PAT' });
    // workspaceState holds EMPTY bindings — the state a wizard save could leave.
    const ctx = ctxWithState({ 'adoCode.activeOrgName': '', 'adoCode.activeProject': '' });
    const active = getActiveOrg(ctx, settings);
    assert.strictEqual(active.name, 'myorg', 'empty stored org must fall back to settings');
    assert.strictEqual(active.project, 'MyProj', 'empty stored project must fall back to settings');
    assert.strictEqual(active.url, 'https://dev.azure.com/myorg');
  });

  test('missing bindings fall back to settings', () => {
    const settings = settingsWith({ adoOrganization: 'myorg', adoProject: 'MyProj' });
    const active = getActiveOrg(ctxWithState({}), settings);
    assert.strictEqual(active.name, 'myorg');
    assert.strictEqual(active.project, 'MyProj');
  });

  test('non-empty per-workspace bindings still win (org switcher behavior preserved)', () => {
    const settings = settingsWith({ adoOrganization: 'global-default', adoProject: 'GlobalProj' });
    const ctx = ctxWithState({ 'adoCode.activeOrgName': 'workspace-org', 'adoCode.activeProject': 'WsProj' });
    const active = getActiveOrg(ctx, settings);
    assert.strictEqual(active.name, 'workspace-org', 'deliberate per-workspace org binding wins');
    assert.strictEqual(active.project, 'WsProj');
  });
});

// ── saveConfig host handler: workspaceState sync on edited fields ──────────
function makeProviderHarness(state: Record<string, unknown>): {
  provider: ChatViewProvider;
  handlers: Array<(m: any) => Promise<void>>;
  posts: any[];
  state: Record<string, unknown>;
  ready: Promise<void>;
} {
  const posts: any[] = [];
  const handlers: Array<(m: any) => Promise<void>> = [];
  const services: any = {
    ado: {
      getWorkItemsAssignedTo: async () => [],
      getMe: async () => ({ displayName: 'Tester', emailAddress: 't@test.local' }),
    },
    git: { workspaceRoot: '' },
  };
  const context = ctxWithState(state);
  const provider = new ChatViewProvider(
    vscode.Uri.file('/tmp/ext'),
    services,
    { ...context, globalState: { get: () => undefined, update: async () => {} }, subscriptions: [] },
    () => {}
  );
  const webviewView: any = {
    onDidDispose: () => {},
    onDidChangeVisibility: () => {},
    webview: {
      options: {},
      html: '',
      postMessage: (m: any) => posts.push(m),
      asWebviewUri: (u: any) => u,
      onDidReceiveMessage: (h: (m: any) => void) => { handlers.push(async (m: any) => h(m)); },
    },
  };
  const ready = (provider as any).resolveWebviewView(webviewView, {}, {});
  return { provider, handlers, posts, state, ready };
}

suite('saveConfig workspaceState sync', () => {
  test('editing adoProject on the Configuration page rebinds the workspace project', async () => {
    const cfg = vscode.workspace.getConfiguration('adoCode');
    const prevProj = cfg.get<string>('adoProject', '');
    const prevOrg = cfg.get<string>('adoOrganization', '');
    const prevPat = cfg.get<string>('adoPat', '');
    const prevKey = cfg.get<string>('llmApiKey', '');
    const state: Record<string, unknown> = {};
    try {
      await cfg.update('adoOrganization', 'myorg', vscode.ConfigurationTarget.Global);
      await cfg.update('adoProject', 'OldProj', vscode.ConfigurationTarget.Global);
      await cfg.update('adoPat', 'PAT', vscode.ConfigurationTarget.Global);
      await cfg.update('llmApiKey', 'llm-key', vscode.ConfigurationTarget.Global);
      const { handlers, state: st, ready } = makeProviderHarness(state);
      await ready;

      const payload: Record<string, any> = {};
      for (const key of ['organizations', 'adoOrganization', 'adoProject', 'adoPat', 'adoServerUrl', 'llmProvider', 'llmApiUrl', 'llmApiKey', 'llmModel']) {
        payload[key] = vscode.workspace.getConfiguration('adoCode').get<any>(key);
      }
      payload.adoProject = 'NewProj'; // the user changed the project field
      await handlers[0]({ type: 'saveConfig', config: payload });

      assert.strictEqual(st['adoCode.activeProject'], 'NewProj', 'edited project rebinds workspaceState');
      assert.strictEqual(state['adoCode.activeOrgName'], undefined, 'unchanged org must NOT clobber (no binding written)');
    } finally {
      await cfg.update('adoProject', prevProj, vscode.ConfigurationTarget.Global);
      await cfg.update('adoOrganization', prevOrg, vscode.ConfigurationTarget.Global);
      await cfg.update('adoPat', prevPat, vscode.ConfigurationTarget.Global);
      await cfg.update('llmApiKey', prevKey, vscode.ConfigurationTarget.Global);
    }
  });

  test('clearing adoProject clears the workspace binding', async () => {
    const cfg = vscode.workspace.getConfiguration('adoCode');
    const prevProj = cfg.get<string>('adoProject', '');
    const prevOrg = cfg.get<string>('adoOrganization', '');
    const prevPat = cfg.get<string>('adoPat', '');
    const prevKey = cfg.get<string>('llmApiKey', '');
    const state: Record<string, unknown> = { 'adoCode.activeProject': 'BoundProj' };
    try {
      await cfg.update('adoOrganization', 'myorg', vscode.ConfigurationTarget.Global);
      await cfg.update('adoProject', 'BoundProj', vscode.ConfigurationTarget.Global);
      await cfg.update('adoPat', 'PAT', vscode.ConfigurationTarget.Global);
      await cfg.update('llmApiKey', 'llm-key', vscode.ConfigurationTarget.Global);
      const { handlers, state: st, ready } = makeProviderHarness(state);
      await ready;

      const payload: Record<string, any> = {};
      for (const key of ['organizations', 'adoOrganization', 'adoProject', 'adoPat', 'adoServerUrl', 'llmProvider', 'llmApiUrl', 'llmApiKey', 'llmModel']) {
        payload[key] = vscode.workspace.getConfiguration('adoCode').get<any>(key);
      }
      payload.adoProject = ''; // user cleared the project field
      await handlers[0]({ type: 'saveConfig', config: payload });

      assert.strictEqual(st['adoCode.activeProject'], undefined, 'clearing the project field clears the stale binding');
    } finally {
      await cfg.update('adoProject', prevProj, vscode.ConfigurationTarget.Global);
      await cfg.update('adoOrganization', prevOrg, vscode.ConfigurationTarget.Global);
      await cfg.update('adoPat', prevPat, vscode.ConfigurationTarget.Global);
      await cfg.update('llmApiKey', prevKey, vscode.ConfigurationTarget.Global);
    }
  });
});

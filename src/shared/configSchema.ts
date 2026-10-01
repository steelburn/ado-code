// Canonical schema for the Configuration page's `saveConfig` payload — Stage 4.
//
// Why this is hand-rolled instead of zod:
//   ADO Code ships ZERO runtime dependencies (.vscodeignore excludes
//   node_modules/**) and is compiled with plain `tsc` (no bundler). Importing
//   zod from extension-host code would emit a runtime `require('zod')` that
//   fails in the packaged extension. zod is therefore a TEST-ONLY oracle
//   (see src/test/suite/webview/configSchema.test.ts); this module provides the
//   dependency-free validator that runs in both the host and the tests.
//
// The key list is the settings surface contributed in package.json
// (contributes.configuration.properties, `adoCode.` prefix stripped). The guard
// suite asserts this list, _allSettings() and the webview catalog all agree, so
// a newly contributed setting cannot silently escape validation.

/** Every setting the Configuration page may send back, in contribution order. */
export const CONFIG_SETTING_KEYS = [
  'organizations',
  'adoOrganization',
  'adoProject',
  'adoServerUrl',
  'adoPat',
  'llmProvider',
  'llmApiUrl',
  'llmApiKey',
  'llmModel',
  'llm.choiceDetectionModel',
  'llm.capabilityOverrides',
  'llm.modeConfigs',
  'llm.modeReasoningEffort',
  'advancedConfig',
  'git.requireGitRepo',
  'git.createBranchOnTaskStart',
  'git.requireCleanTree',
  'git.prOnCompletion',
  'git.protectedBranches',
  'mode',
  'act.toolBudget',
  'act.terminalAllowlist',
  'changelog.enabled',
  'changelog.autoCommit',
  'changelog.postToAdo',
  'ado.clarificationState',
  'ado.warnOnSparseTask',
  'ignore.dotAdoCode',
  'sessions.maxPerProject',
  'agents.enabled',
  'agents.verifyCommand',
  'agents.autoSelect',
  'agents.autoReview',
  'agents.autoCompleteChildren',
  'agents.progressView',
  'mcp.servers',
  'understanding.enabled',
  'understanding.autoSummarize',
  'understanding.agentsMdSync',
  'consent.harmlessAutoApprove',
  'yolo.pushApproval',
  'consent.autoApproveTools',
  'chat.inputWhileBusy',
  'chat.suggestDelegation',
  'chat.showThinking',
  'chat.density',
  'chat.showToolCalls',
  'llm.useNativeTokenCounting',
  'skillRegistryUrls',
] as const;

export type ConfigSettingKey = (typeof CONFIG_SETTING_KEYS)[number];

const CONFIG_SETTING_KEY_SET: ReadonlySet<string> = new Set(CONFIG_SETTING_KEYS);

/** A value that can round-trip through JSON — the only shapes we persist. */
export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue };

/**
 * Typed settings map. Reads/writes go through this shape so a bare string key
 * cannot be mistyped without a compile error (the old `Record<string, any>`).
 */
export type ConfigSettingsMap = Partial<Record<ConfigSettingKey, ConfigValue>>;

/** True for values that survive a JSON round-trip (rejects functions/symbols/NaN/undefined). */
export function isConfigValue(value: unknown): value is ConfigValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isConfigValue);
  if (t === 'object') {
    return Object.values(value as Record<string, unknown>).every(isConfigValue);
  }
  return false;
}

export interface SaveConfigParseResult {
  /** False only when the payload itself is not a plain object. */
  ok: boolean;
  /** Unknown-key reason, set only when `ok` is false. */
  reason?: string;
  /** Keys accepted for writing, in payload order. */
  entries: Array<[ConfigSettingKey, ConfigValue]>;
  /** Keys dropped because they are unknown or carry a non-config value. */
  ignored: Array<{ key: string; reason: string }>;
}

/**
 * Validate an inbound saveConfig payload.
 *
 * Deliberately tolerant per key: an unknown or malformed entry is reported in
 * `ignored` (and logged by the caller) instead of aborting — the same
 * "one bad key must never drop the rest" invariant the host loop already had.
 */
export function parseSaveConfigPayload(payload: unknown): SaveConfigParseResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      reason: 'saveConfig payload must be a plain object',
      entries: [],
      ignored: [],
    };
  }

  const entries: Array<[ConfigSettingKey, ConfigValue]> = [];
  const ignored: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    // `undefined` means the field is simply unset — nothing to persist, and not
    // worth a warning (structured clone keeps the property but carries no value).
    if (value === undefined) continue;
    if (!CONFIG_SETTING_KEY_SET.has(key)) {
      ignored.push({ key, reason: 'unknown setting key' });
      continue;
    }
    if (!isConfigValue(value)) {
      ignored.push({ key, reason: 'value is not a JSON config value' });
      continue;
    }
    entries.push([key as ConfigSettingKey, value]);
  }

  return { ok: true, entries, ignored };
}

/**
 * The welcome-screen wizard's form props → the setting key each persists to.
 *
 * Typed as ConfigSettingKey, so a renamed setting becomes a COMPILE error
 * rather than a silently-dropped write (this was a bare `Array<[string, string]>`).
 */
export const WIZARD_CONFIG_KEYS: ReadonlyArray<readonly [ConfigSettingKey, string]> = [
  ['adoOrganization', 'adoOrganization'],
  ['adoProject', 'adoProject'],
  ['adoPat', 'adoPat'],
  ['llmProvider', 'llmProvider'],
  ['llmApiUrl', 'llmApiUrl'],
  ['llmApiKey', 'llmApiKey'],
  ['llmModel', 'llmModel'],
  ['git.requireGitRepo', 'gitRequireGitRepo'],
  ['git.createBranchOnTaskStart', 'gitCreateBranchOnTaskStart'],
  ['changelog.enabled', 'changelogEnabled'],
  ['changelog.postToAdo', 'changelogPostToAdo'],
  ['chat.density', 'chatDensity'],
];

export interface WizardConfigParseResult {
  entries: Array<[ConfigSettingKey, ConfigValue]>;
  ignored: ConfigSettingKey[];
}

/**
 * Validate the wizard payload the same way `parseSaveConfigPayload` validates a
 * page save: unknown props are ignored, `undefined` is treated as unset, and a
 * value that is not a JSON config value is dropped (reported) rather than
 * persisted. Non-object payloads yield nothing instead of throwing.
 */
export function parseWizardConfigPayload(payload: unknown): WizardConfigParseResult {
  const entries: Array<[ConfigSettingKey, ConfigValue]> = [];
  const ignored: ConfigSettingKey[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { entries, ignored };
  }
  const src = payload as Record<string, unknown>;
  for (const [key, prop] of WIZARD_CONFIG_KEYS) {
    const value = src[prop];
    if (value === undefined) continue;
    if (!isConfigValue(value)) {
      ignored.push(key);
      continue;
    }
    entries.push([key, value]);
  }
  return { entries, ignored };
}

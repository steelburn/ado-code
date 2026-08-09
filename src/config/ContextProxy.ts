import * as vscode from 'vscode';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas – typed validation for every stored key
// ---------------------------------------------------------------------------

/** Keys that live in ExtensionContext.globalState (plain key-value). */
export const GLOBAL_STATE_KEYS = [
  'apiProvider',
  'apiModelId',
  'orgName',
  'projectName',
  'maxTokens',
  'temperature',
  'autoApproveReadOnly',
  'autoApproveWrite',
  'customInstructions',
  'mode',
  'customModes',
] as const;

/** Keys that live in ExtensionContext.secrets (encrypted). */
export const SECRET_STATE_KEYS = [
  'apiKey',
  'adoPat',
] as const;

export type GlobalStateKey = (typeof GLOBAL_STATE_KEYS)[number];
export type SecretStateKey = (typeof SECRET_STATE_KEYS)[number];

// ---------------------------------------------------------------------------
// ADOSettings – the typed shape consumers receive
// ---------------------------------------------------------------------------

const globalStateSchema = z.object({
  apiProvider: z.string().default('openai'),
  apiModelId: z.string().default('gpt-4o'),
  orgName: z.string().default(''),
  projectName: z.string().default(''),
  maxTokens: z.number().default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  autoApproveReadOnly: z.boolean().default(true),
  autoApproveWrite: z.boolean().default(false),
  customInstructions: z.string().default(''),
  mode: z.enum(['inline', 'plan', 'act', 'yolo']).default('inline'),
  customModes: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
});

const secretStateSchema = z.object({
  apiKey: z.string().default(''),
  adoPat: z.string().default(''),
});

export type ADOSettings = z.infer<typeof globalStateSchema>;
export type ADOSecrets = z.infer<typeof secretStateSchema>;

export type SettingsKey = GlobalStateKey | SecretStateKey;

/** Return true when `key` is a secret key (requires encrypted storage). */
export function isSecretKey(key: string): key is SecretStateKey {
  return (SECRET_STATE_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// ContextProxy – cached, validated wrapper around ExtensionContext
// ---------------------------------------------------------------------------

export class ContextProxy {
  private readonly ctx: vscode.ExtensionContext;

  private stateCache: Record<string, unknown> = {};
  private secretCache: Record<string, string | undefined> = {};
  private _isInitialized = false;

  private static _instance: ContextProxy | null = null;

  // ---- Singleton ----------------------------------------------------------

  static get instance(): ContextProxy {
    if (!ContextProxy._instance) {
      throw new Error('ContextProxy has not been initialised – call getInstance() first');
    }
    return ContextProxy._instance;
  }

  /** Create (or return existing) singleton, then `await initialize()`. */
  static async getInstance(context: vscode.ExtensionContext): Promise<ContextProxy> {
    if (ContextProxy._instance) {
      return ContextProxy._instance;
    }
    const proxy = new ContextProxy(context);
    await proxy.initialize();
    ContextProxy._instance = proxy;
    return proxy;
  }

  private constructor(context: vscode.ExtensionContext) {
    this.ctx = context;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  // ---- Initialization -----------------------------------------------------

  /** Load every known key from globalState / secrets into the in-memory cache. */
  async initialize(): Promise<void> {
    // Load global-state keys
    for (const key of GLOBAL_STATE_KEYS) {
      try {
        this.stateCache[key] = this.ctx.globalState.get(key);
      } catch (err) {
        console.error(`[ContextProxy] Error loading globalState "${key}":`, err);
      }
    }

    // Load secrets (all async, in parallel)
    const secretPromises = SECRET_STATE_KEYS.map(async (key) => {
      try {
        this.secretCache[key] = await this.ctx.secrets.get(key);
      } catch (err) {
        console.error(`[ContextProxy] Error loading secret "${key}":`, err);
      }
    });
    await Promise.all(secretPromises);

    this._isInitialized = true;
  }

  // ---- Generic get / set --------------------------------------------------

  /** Read a value from the typed cache (globalState or secrets). */
  getValue<K extends GlobalStateKey>(key: K): ADOSettings[K];
  getValue(key: SecretStateKey): string | undefined;
  getValue(key: GlobalStateKey | SecretStateKey): unknown {
    if (isSecretKey(key)) {
      return this.secretCache[key];
    }
    return this.stateCache[key];
  }

  /** Write a value (write-through to VS Code storage + update cache). */
  async setValue<K extends GlobalStateKey>(
    key: K,
    value: ADOSettings[K],
  ): Promise<void>;
  async setValue(key: SecretStateKey, value: string | undefined): Promise<void>;
  async setValue(
    key: GlobalStateKey | SecretStateKey,
    value: unknown,
  ): Promise<void> {
    if (isSecretKey(key)) {
      this.secretCache[key] = value as string | undefined;
      if (value === undefined) {
        await this.ctx.secrets.delete(key);
      } else {
        await this.ctx.secrets.store(key, value as string);
      }
    } else {
      this.stateCache[key] = value;
      await this.ctx.globalState.update(key, value);
    }
  }

  // ---- Convenience helpers ------------------------------------------------

  /** Get the full validated ADOSettings object (globalState portion). */
  getSettings(): ADOSettings {
    try {
      return globalStateSchema.parse(this.stateCache);
    } catch {
      // Fallback: return whatever we have without strict validation
      return GLOBAL_STATE_KEYS.reduce(
        (acc, key) => ({ ...acc, [key]: this.stateCache[key] }),
        {} as ADOSettings,
      );
    }
  }

  /** Get the full validated secret state. */
  getSecrets(): ADOSecrets {
    try {
      return secretStateSchema.parse(this.secretCache);
    } catch {
      return { apiKey: '', adoPat: '' };
    }
  }

  /** Convenience: read just the LLM API key. */
  getApiKey(): string {
    return (this.getValue('apiKey') as string) ?? '';
  }

  /** Convenience: store the LLM API key. */
  async setApiKey(key: string): Promise<void> {
    await this.setValue('apiKey', key);
  }

  /** Convenience: read just the ADO Personal Access Token. */
  getAdoPat(): string {
    return (this.getValue('adoPat') as string) ?? '';
  }

  /** Convenience: store the ADO Personal Access Token. */
  async setAdoPat(pat: string): Promise<void> {
    await this.setValue('adoPat', pat);
  }

  // ---- Refresh secrets from disk ------------------------------------------

  /** Re-read all secret keys from VS Code storage into the cache. */
  async refreshSecrets(): Promise<void> {
    for (const key of SECRET_STATE_KEYS) {
      try {
        this.secretCache[key] = await this.ctx.secrets.get(key);
      } catch (err) {
        console.error(`[ContextProxy] Error refreshing secret "${key}":`, err);
      }
    }
  }

  // ---- Export / Import ----------------------------------------------------

  /**
   * Export all global-state settings (excluding secrets) as a plain object
   * suitable for serialisation to JSON.
   */
  exportSettings(): Record<string, unknown> {
    const settings = this.getSettings();
    // Strip undefined values
    return Object.fromEntries(
      Object.entries(settings).filter(([, v]) => v !== undefined && v !== null),
    );
  }

  /**
   * Import settings from a plain object (e.g. parsed JSON).
   * Only keys present in `GLOBAL_STATE_KEYS` are applied; secrets are not
   * imported via this path (use `setApiKey` / `setAdoPat` directly).
   */
  async importSettings(data: Record<string, unknown>): Promise<void> {
    for (const key of GLOBAL_STATE_KEYS) {
      if (key in data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.setValue(key as GlobalStateKey, data[key] as any);
      }
    }
  }

  // ---- Reset --------------------------------------------------------------

  /** Clear all caches and persisted state, then re-initialise. */
  async resetAllState(): Promise<void> {
    this.stateCache = {};
    this.secretCache = {};

    const updates = [
      ...GLOBAL_STATE_KEYS.map((key) => this.ctx.globalState.update(key, undefined)),
      ...SECRET_STATE_KEYS.map((key) => this.ctx.secrets.delete(key)),
    ];
    await Promise.all(updates);

    await this.initialize();
  }

  // ---- Passthroughs (ExtensionContext read-only properties) ---------------

  get extensionUri(): vscode.Uri {
    return this.ctx.extensionUri;
  }

  get extensionPath(): string {
    return this.ctx.extensionPath;
  }

  get globalStorageUri(): vscode.Uri {
    return this.ctx.globalStorageUri;
  }

  get logUri(): vscode.Uri {
    return this.ctx.logUri;
  }

  get extension(): vscode.Extension<unknown> {
    return this.ctx.extension;
  }

  get extensionMode(): vscode.ExtensionMode {
    return this.ctx.extensionMode;
  }

  /** Access the raw ExtensionContext (for advanced use-cases). */
  get rawContext(): vscode.ExtensionContext {
    return this.ctx;
  }
}

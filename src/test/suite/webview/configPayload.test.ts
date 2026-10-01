import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_SETTING_KEYS, parseWizardConfigPayload } from '../../../shared/configSchema';

// Guardrail for R4/R7 — the config payload contract.
//
// R4: the wire contract was asymmetric. `saveConfig` was `Record<string, unknown>`
//     (Stage 4) but `fullConfig` — the map the page CONSUMES — was still
//     `Record<string, any>`, and the page's own state was `Record<string, any>`.
//     Field drift between host and page was therefore unchecked.
// R7: the welcome-screen wizard wrote settings through `applyConfigUpdate(config:
//     any)` — a fourth bare-string key mapping with no guard at all (and it threw
//     on a null payload). It now validates through a pure, tested parser.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MESSAGES = 'src/shared/messages.ts';
const PAGE = 'src/webview-ui/src/components/ConfigurationPage.tsx';
const HOST = 'src/webview/ChatViewProvider.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

suite('Configuration payload contract (R4/R7)', () => {
  test('both config payloads are Record<string, unknown> — no asymmetry', () => {
    const src = read(MESSAGES);
    assert.ok(
      /type: 'saveConfig';\s*config: Record<string, unknown>/.test(src),
      'saveConfig.config must be Record<string, unknown>',
    );
    assert.ok(
      /type: 'fullConfig';\s*config: Record<string, unknown>/.test(src),
      'fullConfig.config must be Record<string, unknown> (was any)',
    );
    assert.ok(
      !/config: Record<string, any>/.test(src),
      'no config payload may be typed Record<string, any>',
    );
  });

  test('the page holds the typed settings map, not Record<string, any>', () => {
    const src = read(PAGE);
    assert.ok(
      /useState<ConfigSettingsMap>\(/.test(src),
      'the page config state must be the typed ConfigSettingsMap',
    );
    assert.ok(
      !/useState<Record<string,\s*any>>/.test(src),
      'the page config state must not be Record<string, any>',
    );
    assert.ok(
      /ConfigSettingKey/.test(src),
      'the page must use ConfigSettingKey',
    );
  });

  test('the wizard write path is typed unknown and delegates to the parser', () => {
    const src = read(HOST);
    assert.ok(
      /applyConfigUpdate\(config: unknown\)/.test(src),
      'applyConfigUpdate must take unknown, not any',
    );
    assert.ok(
      /parseWizardConfigPayload\(config\)/.test(src),
      'applyConfigUpdate must validate via parseWizardConfigPayload',
    );
    assert.ok(
      !/Array<\[string, string\]>\s*=\s*\[\s*\[/.test(src),
      'the bare-string wizard key mapping must be gone',
    );
  });

  // --- behavioural coverage of the parser (the R7 fix) -------------------

  test('the wizard parser maps camelCase props to setting keys', () => {
    const { entries, ignored } = parseWizardConfigPayload({
      adoOrganization: 'contoso',
      llmModel: 'gpt-4o',
      chatDensity: 'compact',
    });
    assert.deepStrictEqual(ignored, []);
    assert.deepStrictEqual(entries, [
      ['adoOrganization', 'contoso'],
      ['llmModel', 'gpt-4o'],
      ['chat.density', 'compact'],
    ]);
  });

  test('the wizard parser ignores unknown props and skips unset ones', () => {
    const { entries, ignored } = parseWizardConfigPayload({
      adoPat: 'secret',
      totallyUnknown: 'nope',
      llmApiUrl: undefined,
    });
    assert.deepStrictEqual(entries, [['adoPat', 'secret']]);
    assert.deepStrictEqual(ignored, [], 'unknown props are ignored silently, not reported');
  });

  test('the wizard parser drops non-JSON values instead of persisting them', () => {
    const { entries, ignored } = parseWizardConfigPayload({
      llmApiKey: 'k',
      llmApiUrl: () => 'nope',
    });
    assert.deepStrictEqual(entries, [['llmApiKey', 'k']]);
    assert.deepStrictEqual(ignored, ['llmApiUrl']);
  });

  test('the wizard parser rejects non-object payloads (previously it threw)', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      assert.deepStrictEqual(
        parseWizardConfigPayload(bad),
        { entries: [], ignored: [] },
        `payload ${JSON.stringify(bad)} must be rejected`,
      );
    }
  });

  test('every wizard-mapped setting key is a canonical setting key', () => {
    const canonical = new Set<string>(CONFIG_SETTING_KEYS as readonly string[]);
    const { entries } = parseWizardConfigPayload({
      adoOrganization: 'x', adoProject: 'x', adoPat: 'x',
      llmProvider: 'x', llmApiUrl: 'x', llmApiKey: 'x', llmModel: 'x',
      gitRequireGitRepo: true, gitCreateBranchOnTaskStart: true,
      changelogEnabled: true, changelogPostToAdo: true, chatDensity: 'compact',
    });
    assert.ok(entries.length === 12, `expected 12 wizard settings, got ${entries.length}`);
    const strays = entries.map(([k]) => k).filter(k => !canonical.has(k));
    assert.deepStrictEqual(strays, [], `wizard keys not in CONFIG_SETTING_KEYS: ${strays.join(', ')}`);
  });
});

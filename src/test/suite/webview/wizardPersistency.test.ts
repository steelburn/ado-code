import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  CONFIG_SETTING_KEYS,
  WIZARD_CONFIG_KEYS,
  WIZARD_WRITE_ONLY_KEYS,
  isWriteOnlyWizardKey,
  splitBlankWriteOnlySecrets,
  type ConfigSettingKey,
  type ConfigValue,
} from '../../../shared/configSchema';

// Regression guard for the Setup-Wizard persistency review (F1–F6).
//
// The wizard is not stateless by accident: the host DELIBERATELY withholds
// `adoCode.adoPat` / `adoCode.llmApiKey` from the webview, but the wizard used
// to treat that as "nothing was saved" and wrote the blank values straight back
// (F2), while gating Save on the very secret it could never see (F1). Result:
// "my settings are gone" on every re-open.
//
// The persistence rule lives in `splitBlankWriteOnlySecrets` so it is testable
// without a VS Code host; the rest of the suite pins the wiring, because a
// refactor that quietly drops the rule would otherwise pass everything else.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HOST = 'src/webview/ChatViewProvider.ts';
const WELCOME = 'src/webview-ui/src/components/WelcomeScreen.tsx';
const APP = 'src/webview-ui/src/App.tsx';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const entry = (key: ConfigSettingKey, value: ConfigValue): [ConfigSettingKey, ConfigValue] => [key, value];

suite('Wizard persistency — a blank secret never clears a stored one (F2)', () => {
  test('blank write-only secrets are kept, not written', () => {
    const { writable, kept } = splitBlankWriteOnlySecrets([
      entry('adoPat', ''),
      entry('llmApiKey', ''),
    ]);
    assert.deepStrictEqual(writable, [], 'a blank PAT / API key must not be written');
    assert.deepStrictEqual(kept, ['adoPat', 'llmApiKey'], 'both blank secrets must be reported as kept');
  });

  test('a typed secret is written through', () => {
    const { writable, kept } = splitBlankWriteOnlySecrets([
      entry('adoPat', 'vso.pat'),
      entry('llmApiKey', 'sk-live'),
    ]);
    assert.deepStrictEqual(writable, [['adoPat', 'vso.pat'], ['llmApiKey', 'sk-live']]);
    assert.deepStrictEqual(kept, [], 'no secret is kept when the user actually typed one');
  });

  test('empty-means-empty still holds for every other key', () => {
    const { writable, kept } = splitBlankWriteOnlySecrets([
      entry('adoOrganization', ''),
      entry('adoProject', ''),
      entry('llmModel', ''),
      entry('adoPat', ''),
    ]);
    assert.deepStrictEqual(
      writable.map(([k]) => k),
      ['adoOrganization', 'adoProject', 'llmModel'],
      'an empty org/project/model is a deliberate clear and must still be written',
    );
    assert.deepStrictEqual(kept, ['adoPat']);
  });

  test('null counts as blank for a write-only secret', () => {
    const { writable, kept } = splitBlankWriteOnlySecrets([entry('llmApiKey', null)]);
    assert.deepStrictEqual(writable, []);
    assert.deepStrictEqual(kept, ['llmApiKey']);
  });

  test('the write-only list is a subset of the real settings and wizard keys', () => {
    const settings = new Set<string>(CONFIG_SETTING_KEYS);
    const wizard = new Set<string>(WIZARD_CONFIG_KEYS.map(([key]) => key));
    for (const key of WIZARD_WRITE_ONLY_KEYS) {
      assert.ok(settings.has(key), `write-only key ${key} is not a real setting`);
      assert.ok(wizard.has(key), `write-only key ${key} is not sent by the wizard`);
      assert.ok(isWriteOnlyWizardKey(key), `isWriteOnlyWizardKey(${key}) must be true`);
    }
    assert.ok(!isWriteOnlyWizardKey('adoOrganization'), 'the org is not a secret');
  });
});

suite('Wizard persistency — host wiring (F1/F2)', () => {
  test('the wizard write path filters blank secrets before updating settings', () => {
    const src = read(HOST);
    assert.ok(
      /splitBlankWriteOnlySecrets\(entries\)/.test(src),
      'applyConfigUpdate must run the parsed entries through splitBlankWriteOnlySecrets',
    );
    assert.ok(
      /for \(const \[settingKey, value\] of writable\)/.test(src),
      'applyConfigUpdate must persist the filtered entries, not the raw ones',
    );
    assert.ok(
      !/for \(const \[settingKey, value\] of entries\)/.test(src),
      'the unfiltered write loop must be gone (it erased the stored secrets)',
    );
    assert.ok(
      /keeping stored \$\{kept\.join/.test(src),
      'kept secrets must be logged so a debug session can see why they survived',
    );
  });

  test('the published config reports WHICH secrets are stored, never their values', () => {
    const src = read(HOST);
    assert.ok(
      /secretConfigured: \{ adoPat: Boolean\(active\.pat\), llmApiKey: Boolean\(s\.llmApiKey\) \}/.test(src),
      'the wizard needs booleans for the stored secrets, not the secrets',
    );
  });
});

suite('Wizard persistency — webview wiring (F1/F3/F4/F5/F6)', () => {
  test('Save is no longer gated on a secret the wizard can never see (F1)', () => {
    const src = read(WELCOME);
    assert.ok(
      !/disabled=\{!form\.llmApiKey\}/.test(src),
      'the save button must not be disabled by the raw (always blank) API key field',
    );
    assert.ok(
      /disabled=\{!hasApiKey\}/.test(src),
      'the save button must use the typed-OR-stored key',
    );
    assert.ok(
      /const storedApiKey = Boolean\(config\.secretConfigured\?\.llmApiKey\);/.test(src),
      'the wizard must read the stored-secret inventory',
    );
    assert.ok(
      /placeholder=\{storedApiKey \?/.test(src) && /placeholder=\{storedAdoPat \?/.test(src),
      'both secret inputs must advertise the stored value',
    );
  });

  test('the save payload omits an untouched secret instead of blanking it (F2)', () => {
    const src = read(WELCOME);
    assert.ok(
      /if \(form\.llmApiKey\) payload\.llmApiKey = form\.llmApiKey;/.test(src),
      'a blank API key must not be put on the wire',
    );
    assert.ok(
      /if \(form\.adoPat\) payload\.adoPat = form\.adoPat;/.test(src),
      'a blank PAT must not be put on the wire',
    );
    assert.ok(
      /onSave\(buildPayload\(\)\)/.test(src),
      'the save button must send the guarded payload',
    );
    assert.ok(
      !/onSave\(form\)/.test(src),
      'posting the raw form erased the stored secrets',
    );
    const app = read(APP);
    assert.ok(
      /secretConfigured\?: \{ adoPat: boolean; llmApiKey: boolean \};/.test(app),
      'App must type the new field so the wizard can consume it',
    );
    assert.ok(
      /adoPat\?: string;/.test(app),
      'the host save handler must accept an absent secret',
    );
  });

  test('a republished config re-seeds the form unless the user edited it (F3)', () => {
    const src = read(WELCOME);
    assert.ok(
      /if \(dirty\.current\) return;/.test(src),
      'the config sync effect must not clobber user edits',
    );
    assert.ok(
      /dirty\.current = true;/.test(src),
      'typing through update() must mark the form dirty',
    );
    assert.ok(
      /llmModel: config\.llmModel \|\| prev\.llmModel,/.test(src),
      'the re-sync must not blank a model the user picked',
    );
  });

  test('the wizard validates the ADO connection instead of picking a project (F4)', () => {
    const src = read(WELCOME);
    assert.ok(
      !/form\.adoProject/.test(src),
      'the wizard must not carry a project field any more — the project is per chat session',
    );
    assert.ok(
      /onValidateAdo\(form\.adoOrganization, form\.adoPat \|\| undefined\)/.test(src),
      'the wizard must ask the host to validate the typed org + PAT',
    );
    assert.ok(
      /welcome-ado-validation/.test(src),
      'the ADO card must render the validation verdict',
    );
  });

  test('defaults no longer pretend a missing config is a fresh OpenAI install (F5)', () => {
    const src = read(WELCOME);
    assert.ok(
      /anthropic: 'https:\/\/api\.anthropic\.com\/v1'/.test(src),
      'the default API URL must follow the provider',
    );
    assert.ok(
      !/config\.llmApiUrl \|\| 'https:\/\/api\.openai\.com\/v1'/.test(src),
      'the hard-coded OpenAI URL default must be gone',
    );
    assert.ok(
      /config\.startupError && \(/.test(src),
      'a failed settings read must be surfaced, not masked by defaults',
    );
    assert.ok(
      /const first = models\[0\];/.test(src),
      'an empty model must be filled from the fetched list rather than invented',
    );
  });

  test('a stored PAT completes the ADO section (F6)', () => {
    const src = read(WELCOME);
    assert.ok(
      /const adoFormComplete = Boolean\(form\.adoOrganization && hasAdoPat\);/.test(src),
      'the "continuing without ADO" hint must count the stored PAT',
    );
    assert.ok(
      /const hasAdoPat = Boolean\(form\.adoPat \|\| storedAdoPat\);/.test(src),
      'typed-OR-stored must be a single derived value',
    );
    assert.ok(
      /if \(config\.adoOrganization \|\| config\.adoProject\) setAdoSkipped\(false\);/.test(src),
      'a configured ADO setup must re-open its card',
    );
  });
});

suite('Wizard ADO check — host wiring', () => {
  test('the host probes the ADO configuration without a project', () => {
    const src = read(HOST);
    assert.ok(/case 'validateAdo': \{/.test(src), 'the webview can ask for an ADO probe');
    assert.ok(/private async validateAdo\(/.test(src), 'the probe lives on the provider');
    assert.ok(/type: 'adoValidation'/.test(src), 'the verdict is posted back to the wizard');
    assert.ok(
      /return \{ ok: true, organization, projectCount: projects\.length \};/.test(src),
      'a successful probe reports how many projects the token can see',
    );
    assert.ok(
      /return \{ ok: false, organization, error:/.test(src),
      'a rejected credential comes back as a verdict, not a thrown error',
    );
  });
});

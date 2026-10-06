import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
// Imported as DATA — the payoff of moving the catalog into src/config (R5).
// Before the move, src/webview-ui was excluded from the root tsconfig, so the
// guard could only regex-parse the catalog SOURCE as text.
import { CATEGORIES, ADVANCED_CATEGORY } from '../../../config/catalog';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// Guardrail for the canonical-key consolidation (R2/R5).
//
// Before this, the settings surface had THREE+ hand-maintained key lists:
//   1. shared/configSchema.ts  CONFIG_SETTING_KEYS  (canonical, Stage 4)
//   2. ChatViewProvider        _allSettings() keys[] (a byte-for-byte copy)
//   3. webview-ui catalog.ts   ConfigSetting.key: string (untyped, 4th mapping)
// The host's copy was the one that had already silently dropped 5 settings
// (fixed in Stage 4). These tests keep the list single-sourced.

suite('Configuration catalog is a single importable source (R2/R5)', () => {
  test('the catalog lives in src/config and is importable as data', () => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, 'src/config/catalog.ts')),
      'the catalog must live in src/config (importable by the host-side test)',
    );
    assert.ok(
      !fs.existsSync(path.join(REPO_ROOT, 'src/webview-ui/src/components/config/catalog.ts')),
      'the old webview copy of the catalog must be gone',
    );
    assert.ok(Array.isArray(CATEGORIES) && CATEGORIES.length > 0, 'CATEGORIES must import as data');
    assert.ok(ADVANCED_CATEGORY.id.length > 0, 'ADVANCED_CATEGORY must import as data');
  });

  test('the catalog key field is typed as ConfigSettingKey (compile-time guard)', () => {
    const src = read('src/config/catalog.ts');
    assert.ok(
      /import type \{[^}]*ConfigSettingKey[^}]*\}/.test(src),
      'catalog.ts must import ConfigSettingKey',
    );
    assert.ok(
      /key:\s*ConfigSettingKey/.test(src),
      'ConfigSetting.key must be typed ConfigSettingKey, not string',
    );
  });

});

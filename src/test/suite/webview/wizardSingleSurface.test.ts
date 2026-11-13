import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard for "the Setup Wizard opens in BOTH areas" (0.8.5).
//
// A chat that lives in an editor tab leaves the sidebar view alive as a
// placeholder ("chat is open in the editor area"). The host re-runs the wizard
// with `postConfig({ configured: false })` and `postMessage({ type:
// 'openSettings' })`, which reach the sidebar webview AND the editor panel. The
// sidebar gated its placeholder only in the chat layout, i.e. AFTER the
// welcome/config/project-wizard early returns, so the wizard painted there as
// well. These assertions pin the ordering rule (every full-page screen defers
// to the placeholder) and the host half (the editor panel is revealed first).
// Source guards, since the webview has no DOM test runner in this repo.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP = 'src/webview-ui/src/App.tsx';
const HOST = 'src/webview/ChatViewProvider.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

suite('Setup Wizard paints on ONE surface only', () => {
  const app = read(APP);

  test('the sidebar knows whether the chat actually lives in an editor tab', () => {
    assert.ok(
      /const chatMovedToEditorSurface = chatMovedToEditor && !config\?\.isEditor;/.test(app),
      'the placeholder surface must be derived from chatMovedToEditor AND isEditor: false',
    );
  });

  test('the welcome screen defers to the placeholder', () => {
    assert.ok(
      /if \(config && !config\.configured && !chatMovedToEditorSurface\) \{/.test(app),
      're-running the wizard must not paint the welcome screen in the sidebar placeholder',
    );
  });

  test('the in-webview Configuration page defers to the placeholder', () => {
    assert.ok(
      /if \(showConfig && !chatMovedToEditorSurface\) \{/.test(app),
      'openSettings() must not paint the Configuration page in the sidebar placeholder',
    );
  });

  test('the skill catalog defers to the placeholder', () => {
    assert.ok(
      /if \(showSkillCatalog && !chatMovedToEditorSurface\) \{/.test(app),
      'a restored full-page overlay must not paint in the sidebar placeholder',
    );
  });

  test('the placeholder returns before any other full-page screen', () => {
    const placeholder = app.indexOf('if (chatMovedToEditorSurface) {');
    assert.ok(placeholder > 0, 'the chat-moved placeholder return is missing');
    const projectWizard = app.indexOf('{showProjectWizard && (');
    const skillCatalog = app.indexOf('if (showSkillCatalog && !chatMovedToEditorSurface) {');
    const configPage = app.indexOf('if (showConfig && !chatMovedToEditorSurface) {');
    const welcome = app.indexOf('if (config && !config.configured && !chatMovedToEditorSurface) {');
    for (const [name, index] of [
      ['project wizard render', projectWizard],
      ['skill catalog', skillCatalog],
      ['configuration page', configPage],
      ['welcome screen', welcome],
    ] as Array<[string, number]>) {
      assert.ok(index > 0, `${name} not found`);
    }
    assert.ok(
      placeholder < projectWizard,
      'the placeholder must return before the project wizard can render',
    );
  });

  test('the maximised-wizard flag ignores the placeholder surface', () => {
    assert.ok(
      /!chatMovedToEditorSurface && \(Boolean\(config && !config\.configured\) \|\| showConfig \|\| showProjectWizard\)/.test(
        app,
      ),
      'the placeholder must not ask the host to maximise views for a wizard it never shows',
    );
  });

  test('returning the chat to the sidebar drops wizard state it never painted', () => {
    assert.ok(
      /case 'chatMovedToEditor':[\s\S]{0,400}?if \(!msg\.inEditor\) \{[\s\S]{0,200}?setShowConfig\(false\);/.test(
        app,
      ),
      'the sidebar must clear a wizard opened while the chat lived in the editor tab',
    );
  });

  test('the host reveals the editor panel before it re-runs the wizard', () => {
    const host = read(HOST);
    assert.ok(
      /public focus\(\): void \{\s*if \(this\._editorPanel\) \{\s*this\._editorPanel\.reveal\(\);\s*return;/.test(
        host,
      ),
      'focus() must reveal the editor panel and NOT also reveal the view container',
    );
    assert.ok(
      /public rerunWizard\(\): void \{\s*this\.focus\(\);\s*this\.postConfig\(\{ configured: false \}\);/.test(
        host,
      ),
      'rerunWizard() must focus the chat surface before broadcasting configured: false',
    );
    assert.ok(
      /public openSettings\(\): void \{\s*this\.focus\(\);\s*this\.postMessage\(\{ type: 'openSettings' \}\);/.test(
        host,
      ),
      'openSettings() must focus the chat surface before broadcasting openSettings',
    );
  });
});

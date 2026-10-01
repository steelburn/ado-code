import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Stage 4 polish guard: the config page styles must live next to the config page.
//
// History: ~720 lines of `.config-*` rules sat in the global styles/app.css even
// after the page was split into components/config/*. Co-locating them (mirroring
// SkillCatalog/styles.css and ProjectCreationWizard/styles.css) keeps the page's
// styling with its source and stops app.css from growing without bound.

const webview = path.resolve(__dirname, '../../../../src/webview-ui/src');
const appCss = fs.readFileSync(path.join(webview, 'styles/app.css'), 'utf8');

suite('Configuration styles — co-located (Stage 4)', () => {
  test('a co-located config/styles.css exists and is imported by the page', () => {
    const p = path.join(webview, 'components/config/styles.css');
    assert.ok(fs.existsSync(p), 'components/config/styles.css must exist');
    const page = fs.readFileSync(path.join(webview, 'components/ConfigurationPage.tsx'), 'utf8');
    assert.ok(
      /import\s+["']\.\/config\/styles\.css["']/.test(page),
      'the config page must import its co-located stylesheet'
    );
  });

  test('app.css no longer carries any .config- rules', () => {
    assert.strictEqual(
      (appCss.match(/\.config-/g) || []).length,
      0,
      'app.css must not contain .config-* rules'
    );
  });

  test('the chat-only .model-capability-warning rule stayed in app.css', () => {
    // It sits inside the config region in the source but styles the chat view
    // (App.tsx), so it must not be swept into the config stylesheet.
    assert.ok(
      /\.model-capability-warning\s*\{/.test(appCss),
      '.model-capability-warning belongs to the chat view (app.css)'
    );
  });

  test('the moved stylesheet holds only config-owned rules (no global leakage)', () => {
    const css = fs.readFileSync(path.join(webview, 'components/config/styles.css'), 'utf8');
    const allowed = new Set(['@keyframes tagFadeIn']);
    const selectors = css
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('{') && !l.startsWith('/*'))
      .map(l => l.replace(/\s*\{$/, '').trim());

    assert.ok(selectors.length > 40, `expected many config rules, got ${selectors.length}`);
    for (const sel of selectors) {
      if (allowed.has(sel)) continue;
      for (const part of sel.split(',')) {
        assert.ok(
          part.trim().startsWith('.config-'),
          `non-config selector leaked into the moved stylesheet: ${part.trim()}`
        );
      }
    }
  });
});

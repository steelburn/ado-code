import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Stage 4 polish guard: the top-of-panel error banner must have a single owner.
//
// History: App.tsx rendered the `.error-banner` markup and ran its own
// ERROR_AUTO_DISMISS_MS timer; ConfigurationPage.tsx duplicated both — a bespoke
// `.config-error-banner` block plus a second timer — purely because App early-returns
// the config page before the global banner is mounted. Two mechanisms, one behaviour.
// Consolidated into components/common/ErrorBanner.tsx.

const webview = path.resolve(__dirname, '../../../../src/webview-ui/src');

function read(rel: string): string {
  return fs.readFileSync(path.join(webview, rel), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

suite('Error banner — single owner (Stage 4)', () => {
  test('a shared ErrorBanner component exists and owns the auto-dismiss timer + markup', () => {
    const p = path.join(webview, 'components/common/ErrorBanner.tsx');
    assert.ok(fs.existsSync(p), 'components/common/ErrorBanner.tsx must exist');
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(/export\s+function\s+ErrorBanner/.test(src), 'must export ErrorBanner');
    assert.ok(src.includes('ERROR_AUTO_DISMISS_MS'), 'must reuse the shared timeout constant');
    assert.ok(/clearTimeout/.test(src), 'must clear the timer on cleanup');
    assert.ok(
      /className="error-banner"/.test(src),
      'must render the shared .error-banner markup'
    );
    assert.ok(/onDismiss/.test(src), 'must accept an onDismiss callback');
  });

  test('App.tsx renders <ErrorBanner> and no longer owns an error timer', () => {
    const src = read('App.tsx');
    assert.ok(/<ErrorBanner/.test(src), 'App.tsx must render <ErrorBanner>');
    assert.ok(
      !src.includes('ERROR_AUTO_DISMISS_MS'),
      'App.tsx must not run its own auto-dismiss timer any more'
    );
    assert.ok(
      !/className="error-banner"/.test(src),
      'App.tsx must not duplicate the .error-banner markup'
    );
  });

  test('ConfigurationPage.tsx renders <ErrorBanner>, not a bespoke config banner', () => {
    const src = read('components/ConfigurationPage.tsx');
    assert.ok(/<ErrorBanner/.test(src), 'ConfigurationPage must render <ErrorBanner>');
    assert.ok(
      !src.includes('config-error-banner'),
      'the bespoke .config-error-banner markup must be gone'
    );
    assert.ok(
      !src.includes('ERROR_AUTO_DISMISS_MS'),
      'ConfigurationPage must not run its own auto-dismiss timer'
    );
  });

  test('ERROR_AUTO_DISMISS_MS is referenced only by its util and the shared component', () => {
    const refs = walk(webview)
      .filter(f => fs.readFileSync(f, 'utf8').includes('ERROR_AUTO_DISMISS_MS'))
      .map(f => path.relative(webview, f).split(path.sep).join('/'))
      .sort();
    assert.deepStrictEqual(
      refs,
      ['components/common/ErrorBanner.tsx', 'utils/errorBanner.ts'],
      'the timeout constant must have exactly one runtime consumer'
    );
  });
});

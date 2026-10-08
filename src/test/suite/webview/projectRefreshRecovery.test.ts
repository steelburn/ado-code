import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Guard: refreshing the ADO project list must always recover. A fetch that
// never resolves used to leave the header stuck on "Fetching projects…" with
// the ↻ button hidden — the only way out was reloading the webview. Three
// invariants keep it recoverable: (1) AdoClient aborts stalled requests,
// (2) the webview arms a watchdog that clears the loading flag, and
// (3) the refresh control stays mounted (disabled, not removed) while loading.
suite('project list refresh recovery', () => {
  const root = path.resolve(__dirname, '../../../../');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  test('AdoClient aborts stalled requests with a clear error', () => {
    const src = read('src/ado/client.ts');
    assert.ok(/AbortController/.test(src), 'requests must be abortable');
    assert.ok(/fetchWithTimeout/.test(src), 'fetch must be wrapped in a timeout');
    assert.ok(/timed out/i.test(src), 'a timeout must surface a clear error message');
  });

  test('App arms a watchdog that clears projectsLoading', () => {
    const src = read('src/webview-ui/src/App.tsx');
    assert.ok(/PROJECTS_FETCH_WATCHDOG_MS/.test(src), 'watchdog duration constant required');
    assert.ok(/projectsWatchdogRef/.test(src), 'watchdog timer ref required');
    assert.ok(/armProjectsWatchdog/.test(src), 'must arm the watchdog when a fetch starts');
    assert.ok(/disarmProjectsWatchdog/.test(src), 'must disarm it when a response arrives');
  });

  test('ProjectSwitcher keeps the refresh control mounted while loading', () => {
    const src = read('src/webview-ui/src/components/ProjectSwitcher.tsx');
    assert.ok(src.includes('project-switcher-refresh'), 'the refresh button must exist');
    assert.ok(
      /disabled=\{loading\}/.test(src),
      'refresh must disable (not disappear) while loading'
    );
    assert.ok(
      !/\{loading\s*\?\s*\(/.test(src),
      'loading must not swap out the select/refresh controls (keep them mounted)'
    );
  });
});

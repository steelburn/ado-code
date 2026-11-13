import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard for the 0.8.4 "Setup Wizard opens to a blank page" bug.
//
// The App view declares its hooks, then has a render section that returns EARLY
// (`if (config && !config.configured) return <WelcomeScreen/>`). A hook placed
// after that return runs on the first render (no config yet) but not on the
// next one (config arrives unconfigured), so React sees a different hook count
// and throws — the error unmounts the tree and the webview shows NOTHING. There
// is no lint rule for this here (no react-hooks plugin) and no DOM test
// harness, so the invariant is pinned on the source text.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP = 'src/webview-ui/src/App.tsx';

/** A top-level (two-space) React hook call or declaration. */
const TOP_LEVEL_HOOK =
  /^  (?:(?:const|let|var)\s+[\w{[\s\S]*?\buse(?:State|Effect|Callback|Memo|Ref|Reducer|LayoutEffect|Context)\s*\(|use(?:Effect|LayoutEffect|Memo|Callback|Reducer)\s*\()/;

const HOOK_NAMES = ['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useReducer', 'useLayoutEffect', 'useContext'];

/** True for a two-space-indented line that starts a React hook in this file. */
function isTopLevelHook(line: string): boolean {
  if (!line.startsWith('  ') || line.startsWith('   ')) {
    return false;
  }
  return HOOK_NAMES.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(line)) && TOP_LEVEL_HOOK.test(line);
}

suite('Webview hook order — no hook after an early return', () => {
  test('App.tsx declares every hook before its first conditional return', () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, APP), 'utf8').split(/\r?\n/);

    let firstEarlyReturn = -1;
    for (let i = 0; i < lines.length && firstEarlyReturn < 0; i++) {
      if (!/^  if \(/.test(lines[i])) {
        continue;
      }
      // The return of a top-level `if` sits on the next non-blank line at four
      // spaces of indentation; stop as soon as the block leaves the `if`.
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const line = lines[j];
        if (/^\s*$/.test(line) || /^\s*\/\//.test(line)) {
          continue;
        }
        if (/^    return\b/.test(line)) {
          firstEarlyReturn = i;
        }
        break;
      }
    }

    assert.ok(firstEarlyReturn > 0, `${APP}: expected at least one top-level conditional return`);

    const offenders = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line, number }) => number > firstEarlyReturn + 1 && isTopLevelHook(line));

    assert.deepStrictEqual(
      offenders.map((o) => `${APP}:${o.number}: ${o.line.trim()}`),
      [],
      'a React hook is called after a conditional return, so the hook count changes between renders and React blanks the webview'
    );
  });
});

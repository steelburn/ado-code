import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Mermaid render probe — Extension Development Host test.
 *
 * This closes the last unobserved link in the diagram export chain: mermaid's
 * OWN output being rasterised inside a real VS Code webview. The `docExportSmoke`
 * test proves the mechanism with a hand-written SVG; this one proves it with
 * `mermaid.render()` + the production `rasterizeMermaidToPng`, because
 * `webview-ui-dist/mermaid.js` exposes no global a probe could call.
 *
 * Two things about how the chunk is loaded, both learned the hard way:
 *
 *   1. It is loaded with `<script src>`, exactly like `webview.js` in the chat
 *      panel — NOT with a native `import()`. Webpack's `publicPath: 'auto'`
 *      derives the chunk base from `document.currentScript` at runtime-init;
 *      for a natively imported module that is null and webpack throws
 *      "Automatic publicPath is not supported in this browser". Loading it the
 *      way production does removes that artifact *and* means this test exercises
 *      webpack's own chunk loader under the real CSP (mermaid lazy-loads its
 *      diagram renderers), which the earlier smoke test never did.
 *   2. The probe chunk is a build artifact, not source: it is produced by
 *      `src/webview-ui/webpack.probe.config.js` into `.ado-code/probe-dist/`
 *      (gitignored + `.vscodeignore`d). When it is missing the test SKIPS with
 *      the rebuild command rather than failing, so a fresh clone's Electron gate
 *      stays green — a probe that quietly rots its assertions is worse than a
 *      skip.
 *
 * Rebuild:
 *   node C:/nvm4w/nodejs/node_modules/npm/bin/npm-cli.js --prefix src/webview-ui exec -- webpack --config webpack.probe.config.js
 */

interface ProbeFacts {
  ok: boolean;
  error?: string;
  mermaidVersion?: string;
  renderReturnKind?: string;
  svgLength?: number;
  rootTag?: string;
  rawHasPercentWidth?: boolean;
  rawHasStyleAttr?: boolean;
  rawHasViewBox?: boolean;
  forcedOk?: boolean;
  forcedWidth?: number;
  forcedHeight?: number;
  forcedError?: string;
  forcedPercentWidth?: boolean;
  rasterOk?: boolean;
  rasterError?: string;
  rasterWidth?: number;
  rasterHeight?: number;
  rasterBytes?: number;
  rasterWarnings?: string[];
  pngMagic?: string;
  ink?: number;
  opaquePixels?: number;
  totalPixels?: number;
  leftoverNodes?: number;
  chunkScripts?: number;
  chunkFiles?: string[];
  lazyChunkMarker?: string;
  lazyChunkError?: string;
  labelChecks?: Array<{ name: string; foreignObjects: number; hasLabel: boolean }>;
}

function readMermaidVersion(repoRoot: string): string {
  try {
    const pkg = path.join(repoRoot, 'src', 'webview-ui', 'node_modules', 'mermaid', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'webview-ui-dist'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '../../../..');
}

suite('Documentation export — mermaid renders in a real webview', () => {
  test('mermaid.render() rasterises to a real, non-blank PNG under the chat CSP', async function () {
    if (!process.versions.electron) {
      this.skip();
    }
    this.timeout(180000);

    const repoRoot = findRepoRoot();
    const probeDir = path.join(repoRoot, '.ado-code', 'probe-dist');
    const entry = path.join(probeDir, 'mermaid-probe.js');
    if (!fs.existsSync(entry)) {
      console.log(
        `[mermaidRenderProbe] skipped: ${entry} not built. Rebuild with:\n` +
          '  node C:/nvm4w/nodejs/node_modules/npm/bin/npm-cli.js --prefix src/webview-ui exec -- webpack --config webpack.probe.config.js'
      );
      this.skip();
    }

    const panel = vscode.window.createWebviewPanel(
      'mermaidRenderProbe',
      'Mermaid Render Probe',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(probeDir)],
      }
    );

    try {
      const chunkUri = panel.webview.asWebviewUri(vscode.Uri.file(entry)).toString();

      const driver = `
(function () {
  var vscode = acquireVsCodeApi();
  var out = { loaded: false, facts: null, cspBlocked: [], threw: null };
  window.addEventListener('securitypolicyviolation', function (e) {
    out.cspBlocked.push(String(e.violatedDirective || '') + ' ' + String(e.blockedURI || ''));
  });
  out.loaded = typeof window.__adoCodeMermaidProbe === 'function';
  Promise.resolve().then(function () {
    if (!out.loaded) {
      throw new Error('the probe chunk did not register window.__adoCodeMermaidProbe');
    }
    return window.__adoCodeMermaidProbe();
  }).then(function (facts) {
    out.facts = facts;
    vscode.postMessage(out);
  }).catch(function (err) {
    out.threw = String((err && err.message) || err);
    vscode.postMessage(out);
  });
})();
`;

      const nonce = 'mermaidProbeNonce1';
      panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:;">
<title>Mermaid Render Probe</title>
</head>
<body>
<script src="${chunkUri}"></script>
<script nonce="${nonce}">${driver}</script>
</body>
</html>`;

      const result = await new Promise<{
        loaded: boolean;
        facts: ProbeFacts | null;
        cspBlocked: string[];
        threw: string | null;
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the probe did not report back within 90s')),
          90000
        );
        const sub = panel.webview.onDidReceiveMessage((message) => {
          clearTimeout(timer);
          sub.dispose();
          resolve(message);
        });
      });

      assert.strictEqual(result.threw, null, `the probe threw: ${result.threw}`);
      assert.ok(result.loaded, 'the probe chunk must load in the webview');
      assert.deepStrictEqual(result.cspBlocked, [], 'no CSP violations expected');

      const facts = result.facts;
      assert.ok(facts, 'the probe must return facts');
      assert.strictEqual(facts!.error, undefined, `probe error: ${facts!.error}`);
      assert.ok(facts!.ok, 'the probe reports ok');

      // -- webpack's own chunk loader, under the chat CSP ---------------------
      // This is the assertion that catches a publicPath/CSP regression instead
      // of letting it surface as a confusing "export did nothing".
      assert.strictEqual(
        facts!.lazyChunkError,
        undefined,
        `webpack could not fetch a sibling chunk: ${facts!.lazyChunkError}`
      );
      assert.strictEqual(
        facts!.lazyChunkMarker,
        'ado-code-probe-lazy-chunk-ok',
        'a lazy sibling chunk was fetched and executed inside the webview'
      );

      // -- mermaid itself -----------------------------------------------------
      assert.ok((facts!.svgLength ?? 0) > 200, `mermaid produced SVG (${facts!.svgLength} chars)`);
      assert.ok(
        (facts!.rootTag ?? '').toLowerCase().startsWith('<svg'),
        `mermaid output starts with an <svg> root: ${(facts!.rootTag ?? '').slice(0, 80)}`
      );
      assert.strictEqual(
        facts!.rawHasViewBox,
        true,
        'mermaid emits a viewBox — the basis for forceSvgIntrinsicSize'
      );

      // -- intrinsic-size rewrite --------------------------------------------
      assert.strictEqual(facts!.forcedOk, true, `forceSvgIntrinsicSize: ${facts!.forcedError}`);
      assert.ok((facts!.forcedWidth ?? 0) > 0, 'forced width is a real pixel value');
      assert.ok((facts!.forcedHeight ?? 0) > 0, 'forced height is a real pixel value');
      assert.strictEqual(
        facts!.forcedPercentWidth,
        false,
        'the rewritten root must not keep a percentage width'
      );

      // -- HTML labels really can be turned off on this mermaid version ------
      // Without a working form of `htmlLabels: false`, labels stay
      // <foreignObject> HTML and Chromium drops them from an <img>-sourced SVG —
      // a diagram that arrives with no text. Assert the REQUIREMENT (some form
      // gives text labels), and report which one, because the winning form may
      // move between mermaid releases.
      const checks = facts!.labelChecks ?? [];
      assert.ok(checks.length >= 2, 'the probe reports the label-check matrix');
      const directive = checks.find((c) => c.name === 'directive');
      assert.ok(directive, 'the probe reports the directive variant');
      assert.strictEqual(
        directive!.foreignObjects,
        0,
        `the production export directive must disable HTML labels — matrix: ${JSON.stringify(checks)}`
      );
      assert.strictEqual(directive!.hasLabel, true, 'the label text survives as <text>');

      // -- rasterisation ------------------------------------------------------
      assert.strictEqual(facts!.rasterOk, true, `rasterisation failed: ${facts!.rasterError}`);
      assert.strictEqual(facts!.pngMagic, 'iVBORw0K', 'the payload really is a PNG');
      assert.ok(
        (facts!.rasterWidth ?? 0) > 100 && (facts!.rasterWidth ?? 0) <= 4096,
        `raster width within canvas limits: ${facts!.rasterWidth}`
      );
      assert.ok(
        (facts!.rasterHeight ?? 0) > 40 && (facts!.rasterHeight ?? 0) <= 4096,
        `raster height within canvas limits: ${facts!.rasterHeight}`
      );

      // The claim that matters: the bitmap has a drawing in it. A blank canvas
      // passes every structural check above, so count non-background pixels.
      assert.ok(
        (facts!.ink ?? 0) > 200,
        `the diagram actually drew something (ink px: ${facts!.ink} of ${facts!.totalPixels})`
      );
      const opaqueRatio = (facts!.opaquePixels ?? 0) / Math.max(1, facts!.totalPixels ?? 1);
      assert.ok(
        opaqueRatio > 0.9,
        `the rasteriser filled its background (opaque ratio: ${opaqueRatio.toFixed(3)})`
      );

      // mermaid injects temporary nodes while measuring; a leak would grow the
      // chat panel's DOM on every export.
      assert.strictEqual(facts!.leftoverNodes, 0, 'mermaid left no probe nodes in the DOM');

      console.log(
        `[mermaidRenderProbe] mermaid ${readMermaidVersion(repoRoot)} · ${facts!.rasterWidth}x${facts!.rasterHeight} · ` +
          `ink ${facts!.ink}/${facts!.totalPixels} · png ${facts!.rasterBytes} base64 chars · ` +
          `chunk scripts ${JSON.stringify(facts!.chunkFiles ?? [])} · ` +
          `labels ${JSON.stringify(facts!.labelChecks ?? [])} · ` +
          `warnings ${JSON.stringify(facts!.rasterWarnings ?? [])}`
      );
    } finally {
      panel.dispose();
    }
  });
});

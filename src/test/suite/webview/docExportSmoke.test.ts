import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Documentation export — Extension Development Host smoke test.
 *
 * TEMPORARY harness probe (delete after the smoke run). It answers the two
 * things no headless test can, inside a real VS Code Chromium webview, under a
 * CSP shaped exactly like the chat panel's:
 *
 *   1. a first-party dynamic `import()` of an emitted webpack chunk resolves
 *      (the DOCX/XLSX writers are lazy — this is the chunk fetch);
 *   2. a `data:image/svg+xml;base64,…` image can be drawn to a canvas and
 *      exported with `toDataURL()` without tainting (the mermaid → PNG path).
 *
 * It also pins the lazy-loading invariant: `webview.js` must not contain the
 * DOCX writer, or every chat panel load pays for it.
 */
suite('Documentation export — Extension Development Host smoke', () => {
  test('webview dynamic-imports the DOCX chunk and rasterises a data: SVG to PNG', async function () {
    // Headless mocha has no Chromium webview to host this, so the probe would only
    // time out. `npm test` runs inside Electron, where process.versions.electron is set.
    if (!process.versions.electron) {
      this.skip();
      return;
    }
    const repoRoot = path.resolve(__dirname, '../../../..');
    const distDir = path.join(repoRoot, 'webview-ui-dist');
    assert.ok(fs.existsSync(distDir), 'webview-ui-dist must be built before this smoke test');

    const chunks = fs.readdirSync(distDir).filter((f) => /^\d+\.js$/.test(f));
    assert.ok(chunks.length > 0, 'the webview build must emit async chunks');

    const docxChunk = chunks.find((f) =>
      fs.readFileSync(path.join(distDir, f), 'utf8').includes('word/document.xml')
    );
    assert.ok(docxChunk, 'a lazy chunk carrying the DOCX writer must exist');

    const mainBundle = fs.readFileSync(path.join(distDir, 'webview.js'), 'utf8');
    assert.ok(
      !mainBundle.includes('word/document.xml'),
      'the DOCX writer must stay out of webview.js (lazy chunk only)'
    );

    const panel = vscode.window.createWebviewPanel(
      'docExportSmoke',
      'Doc Export Smoke',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(distDir)],
      }
    );

    const chunkUri = panel.webview
      .asWebviewUri(vscode.Uri.file(path.join(distDir, docxChunk)))
      .toString();

    const probe = `
(function () {
  var vscode = acquireVsCodeApi();
  var out = { dynamicImport: null, canvas: null, cspBlocked: [] };
  window.addEventListener('securitypolicyviolation', function (e) {
    out.cspBlocked.push(String(e.violatedDirective || '') + ' ' + String(e.blockedURI || ''));
  });
  (function () {
    import('__CHUNK__').then(function (mod) {
      out.dynamicImport = { ok: true, exportCount: Object.keys(mod || {}).length };
    }, function (err) {
      out.dynamicImport = { ok: false, error: String((err && err.message) || err) };
    }).then(async function () {
      try {
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">'
          + '<rect width="120" height="60" fill="#0a5"/>'
          + '<text x="8" y="36" font-family="sans-serif" font-size="16" fill="#fff">OK</text>'
          + '</svg>';
        var bytes = new TextEncoder().encode(svg);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
        var dataUri = 'data:image/svg+xml;base64,' + btoa(bin);
        var img = new Image();
        await new Promise(function (resolve, reject) {
          img.onload = resolve;
          img.onerror = function () { reject(new Error('SVG image failed to load')); };
          img.src = dataUri;
        });
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 120;
        canvas.height = img.naturalHeight || 60;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        var png = canvas.toDataURL('image/png');
        out.canvas = {
          ok: png.indexOf('data:image/png;base64,') === 0,
          pngMagic: png.indexOf('data:image/png;base64,iVBORw0KGgo') === 0,
          length: png.length,
          width: canvas.width,
          height: canvas.height
        };
      } catch (err) {
        out.canvas = { ok: false, error: String((err && err.message) || err) };
      }
      vscode.postMessage(out);
    });
  })();
})();
`;

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-__NONCE__' ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:;">
<title>Doc Export Smoke</title>
</head>
<body>
<script nonce="__NONCE__">${probe.replace('__CHUNK__', chunkUri)}</script>
</body>
</html>`.replace(/__NONCE__/g, 'smokeNonce123');

    panel.reveal(vscode.ViewColumn.One, true);

    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('webview probe timed out after 60s')),
        60000
      );
      const sub = panel.webview.onDidReceiveMessage((msg: any) => {
        clearTimeout(timer);
        sub.dispose();
        resolve(msg);
      });
    });

    try {
      assert.ok(
        result.dynamicImport && result.dynamicImport.ok,
        `dynamic import of ${docxChunk} failed: ${JSON.stringify(result.dynamicImport)}`
      );
      assert.ok(
        result.canvas && result.canvas.ok,
        `data: SVG → PNG rasterise failed: ${JSON.stringify(result.canvas)}`
      );
      assert.ok(result.canvas.pngMagic, 'toDataURL must return real PNG bytes');
      assert.ok(result.canvas.length > 200, 'the rasterised PNG must not be empty');
      assert.strictEqual(result.canvas.width, 120);
      assert.strictEqual(result.canvas.height, 60);
      assert.deepStrictEqual(result.cspBlocked, [], 'no CSP violations expected');
    } finally {
      panel.dispose();
    }
  });
});

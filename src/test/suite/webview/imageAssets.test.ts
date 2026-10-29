import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  collectImageAssets,
  formatImageIssue,
  normaliseImageRef,
  type ImageIssue,
} from '../../../webview/imageAssets';
import { gifBytes, jpegBytes, pngBytes, svgWith } from '../shared/imageFixtures';
import { makeScratchDir } from '../utils/scratchDir';

/**
 * These tests drive a real temporary project on disk so the path resolution,
 * the `vscode.workspace.fs` default reader and the size guard are all exercised
 * the way the export path will use them — only the file *contents* are synthetic
 * (headers built by imageFixtures).
 */

const DOC_REL = path.join('04-user-docs', 'user-manual.md');

let root = '';
let docPath = '';

const ref = (relative: string): string => `../assets/img/${relative}`;

suiteSetup(() => {
  root = makeScratchDir('adocode-imageassets-');
  fs.mkdirSync(path.join(root, 'assets', 'img'), { recursive: true });
  fs.mkdirSync(path.join(root, '04-user-docs'), { recursive: true });

  const assets = path.join(root, 'assets', 'img');
  fs.writeFileSync(path.join(assets, 'FIG-001.png'), pngBytes(1920, 1080));
  fs.writeFileSync(path.join(assets, 'shot 2.png'), pngBytes(800, 600));
  fs.writeFileSync(path.join(assets, 'DIA-001.svg'), svgWith('viewBox="0 0 2000 1000"'));
  fs.writeFileSync(path.join(assets, 'sized.svg'), svgWith('width="210mm" height="297mm"'));
  fs.writeFileSync(path.join(assets, 'blank.svg'), svgWith(''));
  fs.writeFileSync(path.join(assets, 'anim.gif'), gifBytes(320, 200));
  fs.writeFileSync(path.join(assets, 'photo.jpg'), jpegBytes(640, 480));
  fs.writeFileSync(path.join(assets, 'notes.txt'), 'not an image\n');
  fs.writeFileSync(path.join(assets, 'empty.png'), new Uint8Array(0));

  docPath = path.join(root, DOC_REL);
  fs.writeFileSync(docPath, '# User manual\n');
  fs.writeFileSync(path.join(root, 'outside.png'), pngBytes(100, 100));
});

suiteTeardown(() => {
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function collect(refs: string[], overrides: Partial<Parameters<typeof collectImageAssets>[0]> = {}) {
  return collectImageAssets({ documentPath: docPath, projectRoot: root, refs, ...overrides });
}

const codes = (issues: ImageIssue[]): string[] => issues.map(issue => issue.code);

suite('imageAssets — resolution and sizing', () => {
  test('resolves a reference, sniffs it and caps it to the content width', async () => {
    const result = await collect([ref('FIG-001.png')]);
    assert.strictEqual(result.issues.length, 0, JSON.stringify(result.warnings));
    assert.strictEqual(result.assets.length, 1);
    const asset = result.assets[0];
    assert.strictEqual(asset.format, 'png');
    assert.strictEqual(asset.mime, 'image/png');
    assert.strictEqual(asset.relativePath, 'assets/img/FIG-001.png');
    assert.strictEqual(asset.originalWidth, 1920);
    assert.strictEqual(asset.originalHeight, 1080);
    assert.deepStrictEqual({ width: asset.width, height: asset.height }, { width: 640, height: 360 });
    assert.strictEqual(asset.bytes, pngBytes(1920, 1080).byteLength);
    assert.deepStrictEqual(
      Array.from(Buffer.from(asset.base64, 'base64')),
      Array.from(pngBytes(1920, 1080)),
      'the base64 payload must round-trip to the exact file bytes',
    );
    assert.strictEqual(result.byRef[ref('FIG-001.png')], asset);
  });

  test('resolves a rasterised diagram passed as a PNG data URI', async () => {
    // A mermaid fence becomes an `image` block whose ref is a data: URI
    // (src/shared/mermaidBlocks.ts), so the export must embed it without ever
    // touching the disk — this pins that seam.
    const png = pngBytes(320, 200);
    const inlineRef = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    const result = await collect([inlineRef]);
    assert.strictEqual(result.issues.length, 0, JSON.stringify(result.warnings));
    assert.strictEqual(result.assets.length, 1);
    const asset = result.assets[0];
    assert.strictEqual(asset.format, 'png');
    assert.strictEqual(asset.mime, 'image/png');
    assert.strictEqual(asset.filePath, '', 'an inline diagram has no file on disk');
    assert.strictEqual(asset.originalWidth, 320);
    assert.strictEqual(asset.originalHeight, 200);
    assert.strictEqual(asset.width, 320, 'a diagram narrower than the content width is not stretched');
    assert.deepStrictEqual(Array.from(Buffer.from(asset.base64, 'base64')), Array.from(png));
    assert.strictEqual(result.byRef[inlineRef], asset, 'the DOCX renderer looks the block ref up here');
  });

  test('reads through vscode.workspace.fs when no reader is injected', async () => {
    const result = await collectImageAssets({
      documentPath: docPath,
      projectRoot: root,
      refs: [ref('photo.jpg')],
    });
    assert.strictEqual(result.issues.length, 0, JSON.stringify(result.warnings));
    assert.strictEqual(result.assets[0].format, 'jpeg');
    assert.strictEqual(result.assets[0].mime, 'image/jpeg');
  });

  test('leaves an image narrower than the cap at its intrinsic size', async () => {
    const result = await collect([ref('anim.gif'), ref('photo.jpg')]);
    assert.deepStrictEqual(
      result.assets.map(a => [a.format, a.width, a.height]),
      [
        ['gif', 320, 200],
        ['jpeg', 640, 480],
      ],
      'document order must be preserved',
    );
  });

  test('caps a wide SVG diagram from its viewBox', async () => {
    const result = await collect([ref('DIA-001.svg')]);
    const asset = result.assets[0];
    assert.strictEqual(asset.mime, 'image/svg+xml');
    assert.deepStrictEqual(
      { ow: asset.originalWidth, oh: asset.originalHeight, w: asset.width, h: asset.height },
      { ow: 2000, oh: 1000, w: 640, h: 320 },
    );
  });

  test('honours a custom cap', async () => {
    const result = await collect([ref('sized.svg')], { maxWidthPx: 300 });
    assert.deepStrictEqual({ w: result.assets[0].width, h: result.assets[0].height }, { w: 300, h: 424 });
  });

  test('decodes a percent-encoded reference to a path containing a space', async () => {
    const result = await collect([ref('shot%202.png')]);
    assert.strictEqual(result.issues.length, 0, JSON.stringify(result.warnings));
    assert.strictEqual(result.assets[0].relativePath, 'assets/img/shot 2.png');
  });

  test('reads a reference once and tracks every alias that pointed at it', async () => {
    const first = ref('FIG-001.png');
    const second = ref('./FIG-001.png');
    const result = await collect([first, second, first]);
    assert.strictEqual(result.assets.length, 1);
    assert.deepStrictEqual(result.assets[0].refs, [first, second]);
    assert.strictEqual(result.byRef[first], result.assets[0]);
    assert.strictEqual(result.byRef[second], result.assets[0]);
  });

  test('embeds an inline data URI without touching the filesystem', async () => {
    const bytes = pngBytes(4, 3);
    const dataUri = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const result = await collectImageAssets({
      documentPath: docPath,
      refs: [dataUri],
      readFile: async () => {
        throw new Error('inline images must not be read from disk');
      },
    });
    assert.strictEqual(result.issues.length, 0, JSON.stringify(result.warnings));
    assert.strictEqual(result.assets[0].filePath, '');
    assert.deepStrictEqual({ w: result.assets[0].width, h: result.assets[0].height }, { w: 4, h: 3 });
  });
});

suite('imageAssets — diagnostics', () => {
  test('reports a missing file as an actionable warning', async () => {
    const result = await collect([ref('nope.png')]);
    assert.deepStrictEqual(codes(result.issues), ['missing']);
    assert.strictEqual(result.assets.length, 0);
    assert.ok(result.warnings[0].includes('Image not found: '), result.warnings[0]);
    assert.ok(result.warnings[0].includes('nope.png'), result.warnings[0]);
  });

  test('reports an unsupported format', async () => {
    const result = await collect([ref('notes.txt')]);
    assert.deepStrictEqual(codes(result.issues), ['unsupported-format']);
    assert.ok(result.warnings[0].includes('Unsupported image format'), result.warnings[0]);
  });

  test('reports an SVG with no intrinsic size', async () => {
    const result = await collect([ref('blank.svg')]);
    assert.deepStrictEqual(codes(result.issues), ['no-dimensions']);
  });

  test('reports an empty file as unreadable', async () => {
    const result = await collect([ref('empty.png')]);
    assert.deepStrictEqual(codes(result.issues), ['unreadable']);
  });

  test('skips an image above the byte limit', async () => {
    const result = await collect([ref('FIG-001.png')], { maxBytes: 10 });
    assert.deepStrictEqual(codes(result.issues), ['too-large']);
    assert.ok(result.warnings[0].includes('MB'), result.warnings[0]);
  });

  test('refuses to read outside the project folder', async () => {
    const result = await collect(['../../outside.png']);
    assert.deepStrictEqual(codes(result.issues), ['outside-project']);
    assert.strictEqual(result.assets.length, 0);
  });

  test('defaults the project boundary to the document folder', async () => {
    const result = await collectImageAssets({ documentPath: docPath, refs: [ref('FIG-001.png')] });
    assert.deepStrictEqual(codes(result.issues), ['outside-project']);
  });

  test('does not download remote images', async () => {
    const result = await collect(['https://example.com/logo.png', '//cdn.example.com/x.png']);
    assert.deepStrictEqual(codes(result.issues), ['remote', 'remote']);
  });

  test('reports an empty reference', async () => {
    const result = await collect(['', '   ']);
    assert.deepStrictEqual(codes(result.issues), ['empty-ref', 'empty-ref']);
  });

  test('keeps collecting after a failure so one broken image cannot abort the export', async () => {
    const result = await collect([ref('nope.png'), ref('FIG-001.png'), ref('notes.txt')]);
    assert.strictEqual(result.assets.length, 1);
    assert.deepStrictEqual(codes(result.issues), ['missing', 'unsupported-format']);
    assert.strictEqual(result.warnings.length, result.issues.length);
  });

  test('formats every issue code into a human-readable line', async () => {
    const issue: ImageIssue = { ref: 'assets/x.png', code: 'missing', message: 'boom' };
    for (const code of [
      'empty-ref',
      'remote',
      'missing',
      'unreadable',
      'too-large',
      'unsupported-format',
      'no-dimensions',
      'outside-project',
    ] as const) {
      const line = formatImageIssue({ ...issue, code });
      assert.ok(line.length > 0, code);
      assert.ok(!line.includes('undefined'), `${code}: ${line}`);
    }
    assert.strictEqual(
      formatImageIssue({ ...issue, code: 'too-large' }, DEFAULT_MAX_IMAGE_BYTES),
      'Image is larger than 20 MB and was skipped: assets/x.png',
    );
  });
});

suite('imageAssets — reference normalisation', () => {
  test('strips a Markdown title', () => {
    assert.strictEqual(normaliseImageRef('assets/a.png "Figure 1"'), 'assets/a.png');
    assert.strictEqual(normaliseImageRef("assets/a.png 'Figure 1'"), 'assets/a.png');
  });

  test('unwraps the angle-bracket form', () => {
    assert.strictEqual(normaliseImageRef('<assets/a b.png>'), 'assets/a b.png');
  });

  test('percent-decodes, but keeps a raw % that is not a valid escape', () => {
    assert.strictEqual(normaliseImageRef('assets/a%20b.png'), 'assets/a b.png');
    assert.strictEqual(normaliseImageRef('assets/100%.png'), 'assets/100%.png');
  });

  test('trims surrounding whitespace and leaves other references alone', () => {
    assert.strictEqual(normaliseImageRef('  assets/a.png  '), 'assets/a.png');
    assert.strictEqual(normaliseImageRef('assets/img/DIA-001.svg'), 'assets/img/DIA-001.svg');
  });
});

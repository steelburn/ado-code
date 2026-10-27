import * as assert from 'assert';

import {
  diagramCaption,
  diagramFileName,
  encodeUtf8Base64,
  EXPORT_INIT_DIRECTIVE,
  forceSvgIntrinsicSize,
  hasInitDirective,
  inspectPngBase64,
  isValidPngBytes,
  parseSvgLength,
  parseViewBox,
  planSvgRaster,
  RASTER_DEFAULTS,
  svgDimensions,
  svgToDataUri,
  withExportDirective,
} from '../../../shared/svgRaster';
import { jpegBytes, pngBytes, writeU32BE } from './imageFixtures';

const PNG_2x1 = pngBytes(2, 1);
const PNG_1x1_BASE64 = Buffer.from(pngBytes(1, 1)).toString('base64');
const JPEG_BASE64 = Buffer.from(jpegBytes(8, 8)).toString('base64');

/** Minimal mermaid-shaped SVG: percentage width, style cap, viewBox, nested content. */
const MERMAID_SVG = [
  '<svg id="adocode-docx-diagram-1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 640px;" viewBox="0 0 320 200" role="graphics-document document" aria-roledescription="flowchart-v2">',
  '  <style>#adocode-docx-diagram-1 .label{font-family:var(--vscode-font-family)}</style>',
  '  <g class="root"><text>Mulakan</text></g>',
  '</svg>',
].join('\n');

suite('svgRaster — base64 and data URIs', () => {
  test('encodes ASCII, multi-byte UTF-8 and every padding length', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'Mula', 'Tajuk: Laporan']) {
      assert.strictEqual(
        encodeUtf8Base64(text),
        Buffer.from(text, 'utf8').toString('base64'),
        `mismatch for ${JSON.stringify(text)}`,
      );
    }
  });

  test('encodes Bahasa Malaysia and box-drawing characters without btoa restrictions', () => {
    const text = 'Permohonan → Kelulusan │ Selesai';
    assert.strictEqual(encodeUtf8Base64(text), Buffer.from(text, 'utf8').toString('base64'));
  });

  test('builds a decodable data URI', () => {
    const uri = svgToDataUri('<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.ok(uri.startsWith('data:image/svg+xml;base64,'), uri.slice(0, 40));
    const decoded = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
    assert.strictEqual(decoded, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
});

suite('svgRaster — length and viewBox parsing', () => {
  test('accepts unitless and px lengths', () => {
    assert.strictEqual(parseSvgLength('640'), 640);
    assert.strictEqual(parseSvgLength(' 640px '), 640);
    assert.strictEqual(parseSvgLength('12.5'), 12.5);
  });

  test('converts absolute units to px at 96 dpi', () => {
    assert.strictEqual(parseSvgLength('1in'), 96);
    assert.strictEqual(Math.round(parseSvgLength('10mm') as number), 38);
    assert.strictEqual(parseSvgLength('1pt'), 96 / 72);
    assert.strictEqual(parseSvgLength('2em'), 32);
  });

  test('rejects percentages, unknown units and non-numbers', () => {
    for (const value of ['100%', 'auto', '', 'abc', '-5', '0', undefined, '50%']) {
      assert.strictEqual(parseSvgLength(value as string), null, `expected null for ${value}`);
    }
  });

  test('parses viewBox with spaces, commas and a non-zero origin', () => {
    assert.deepStrictEqual(parseViewBox('0 0 320 200'), { width: 320, height: 200 });
    assert.deepStrictEqual(parseViewBox('10,20,320,200'), { width: 320, height: 200 });
    assert.deepStrictEqual(parseViewBox('-10 -20 5 6'), { width: 5, height: 6 });
  });

  test('rejects malformed viewBox values', () => {
    for (const value of ['', '0 0 320', '0 0 0 200', '0 0 320 200 1', 'a b c d', undefined]) {
      assert.strictEqual(parseViewBox(value as string), null, `expected null for ${value}`);
    }
  });

  test('reads intrinsic size from attributes, preferring viewBox', () => {
    assert.deepStrictEqual(
      svgDimensions('<svg width="40" height="20"></svg>'),
      { width: 40, height: 20 },
    );
    assert.deepStrictEqual(
      svgDimensions('<svg width="100%" height="100%" viewBox="0 0 320 200"></svg>'),
      { width: 320, height: 200 },
    );
    assert.strictEqual(svgDimensions('<svg width="100%"></svg>'), null);
  });
});

suite('svgRaster — forcing an intrinsic size', () => {
  test('rewrites a mermaid root element to fixed pixels', () => {
    const result = forceSvgIntrinsicSize(MERMAID_SVG);
    assert.ok(result.ok, 'expected the root element to be recognised');
    if (!result.ok) {
      return;
    }
    assert.deepStrictEqual(result.size, { width: 320, height: 200 });
    assert.strictEqual(result.fromViewBox, true);

    const tag = /<svg[^>]*>/.exec(result.svg)?.[0] ?? '';
    assert.ok(tag.includes('width="320"'), tag);
    assert.ok(tag.includes('height="200"'), tag);
    assert.ok(tag.includes('viewBox="0 0 320 200"'), tag);
    assert.ok(tag.includes('xmlns="http://www.w3.org/2000/svg"'), tag);
    assert.ok(!tag.includes('max-width'), 'the style attribute must be dropped');
    assert.ok(!/width="100%"/.test(tag), 'the percentage width must be replaced');
    assert.ok(
      tag.includes('aria-roledescription="flowchart-v2"'),
      'unrelated attributes must survive',
    );
  });

  test('leaves the document body untouched', () => {
    const result = forceSvgIntrinsicSize(MERMAID_SVG);
    assert.ok(result.ok);
    if (!result.ok) {
      return;
    }
    assert.ok(result.svg.includes('<g class="root"><text>Mulakan</text></g>'));
    assert.ok(result.svg.includes('</svg>'));
    assert.strictEqual(result.svg.split('<svg').length - 1, 1, 'exactly one root element');
  });

  test('adds a viewBox when only pixel dimensions are declared', () => {
    const result = forceSvgIntrinsicSize('<svg width="40" height="20"><g/></svg>');
    assert.ok(result.ok);
    if (!result.ok) {
      return;
    }
    assert.deepStrictEqual(result.size, { width: 40, height: 20 });
    assert.strictEqual(result.fromViewBox, false);
    assert.ok(result.svg.includes('viewBox="0 0 40 20"'));
  });

  test('scales a fractional viewBox up to whole pixels', () => {
    const result = forceSvgIntrinsicSize('<svg viewBox="0 0 320.4 200.6"></svg>');
    assert.ok(result.ok);
    if (!result.ok) {
      return;
    }
    assert.deepStrictEqual(result.size, { width: 320, height: 201 });
    assert.ok(result.svg.includes('viewBox="0 0 320.4 200.6"'), 'viewBox keeps its precision');
  });

  test('treats a single declared axis as a square', () => {
    const result = forceSvgIntrinsicSize('<svg width="120"></svg>');
    assert.ok(result.ok);
    if (!result.ok) {
      return;
    }
    assert.deepStrictEqual(result.size, { width: 120, height: 120 });
  });

  test('survives a ">" inside a quoted attribute value', () => {
    const result = forceSvgIntrinsicSize(
      '<svg aria-label="a > b" viewBox="0 0 10 10"><text>a &gt; b</text></svg>',
    );
    assert.ok(result.ok);
    if (!result.ok) {
      return;
    }
    assert.deepStrictEqual(result.size, { width: 10, height: 10 });
    assert.ok(result.svg.includes('aria-label="a > b"'));
    assert.ok(result.svg.includes('<text>a &gt; b</text>'));
  });

  test('reports why it cannot size a document', () => {
    const noRoot = forceSvgIntrinsicSize('<html><body>no diagram</body></html>');
    assert.strictEqual(noRoot.ok, false);
    assert.strictEqual(noRoot.ok === false && noRoot.reason, 'no-svg-root');

    const unsized = forceSvgIntrinsicSize('<svg width="100%" height="100%"><g/></svg>');
    assert.strictEqual(unsized.ok, false);
    assert.strictEqual(unsized.ok === false && unsized.reason, 'no-intrinsic-size');
  });
});

suite('svgRaster — raster planning', () => {
  test('renders at 2x by default for print quality', () => {
    const plan = planSvgRaster({ width: 320, height: 200 });
    assert.ok(plan.ok);
    if (!plan.ok) {
      return;
    }
    assert.strictEqual(plan.scale, 2);
    assert.strictEqual(plan.canvasWidth, 640);
    assert.strictEqual(plan.canvasHeight, 400);
    assert.deepStrictEqual(plan.warnings, []);
  });

  test('clamps an oversized diagram to the canvas dimension limit and says so', () => {
    const plan = planSvgRaster({ width: 4000, height: 1000 });
    assert.ok(plan.ok);
    if (!plan.ok) {
      return;
    }
    assert.strictEqual(plan.canvasWidth, RASTER_DEFAULTS.maxDimensionPx);
    // 4000x1000 at 2x is 8000x2000; clamping the long edge to 4096 keeps the
    // aspect ratio, so the height follows at 1024 — not below the source 1000.
    assert.strictEqual(plan.canvasHeight, 1024);
    assert.ok(plan.scale < 2, `scale should have been reduced, was ${plan.scale}`);
    assert.strictEqual(plan.warnings.length, 1);
    assert.ok(/canvas limit/.test(plan.warnings[0]), plan.warnings[0]);
    assert.ok(/instead of 2×/.test(plan.warnings[0]), plan.warnings[0]);
  });

  test('clamps on total pixels for a very wide, short diagram', () => {
    const plan = planSvgRaster({ width: 8000, height: 400 });
    assert.ok(plan.ok);
    if (!plan.ok) {
      return;
    }
    assert.ok(plan.canvasWidth * plan.canvasHeight <= RASTER_DEFAULTS.maxPixels);
    assert.ok(plan.warnings.length >= 1);
  });

  test('honours an explicit scale and clamp overrides', () => {
    const plan = planSvgRaster({ width: 100, height: 50 }, { scale: 3, maxDimensionPx: 1000 });
    assert.ok(plan.ok);
    if (!plan.ok) {
      return;
    }
    assert.strictEqual(plan.canvasWidth, 300);
    assert.strictEqual(plan.canvasHeight, 150);
    assert.deepStrictEqual(plan.warnings, []);
  });

  test('caps an absurd scale instead of multiplying blindly', () => {
    const plan = planSvgRaster({ width: 10, height: 10 }, { scale: 1000 });
    assert.ok(plan.ok);
    if (!plan.ok) {
      return;
    }
    assert.ok(plan.scale <= 8, `scale was ${plan.scale}`);
  });

  test('refuses a diagram that cannot be rasterised at a usable scale', () => {
    const plan = planSvgRaster({ width: 100000, height: 100000 }, { minScale: 0.25 });
    assert.strictEqual(plan.ok, false);
    assert.ok(plan.ok === false && /too large/.test(plan.error), plan.ok === false ? plan.error : '');
  });

  test('rejects degenerate dimensions', () => {
    for (const size of [
      { width: 0, height: 10 },
      { width: 10, height: -1 },
      { width: Number.NaN, height: 10 },
      { width: Number.POSITIVE_INFINITY, height: 10 },
    ]) {
      const plan = planSvgRaster(size);
      assert.strictEqual(plan.ok, false, `expected a failure for ${JSON.stringify(size)}`);
    }
  });
});

suite('svgRaster — mermaid export directive', () => {
  test('prefixes the directive for a plain diagram', () => {
    const prepared = withExportDirective('flowchart TD\n  A --> B');
    assert.strictEqual(prepared.applied, true);
    assert.ok(prepared.code.startsWith(EXPORT_INIT_DIRECTIVE));
    assert.ok(prepared.code.includes('flowchart TD'));
  });

  test('the directive is valid JSON with a light palette', () => {
    const json = EXPORT_INIT_DIRECTIVE.replace(/^%%\{init: /, '').replace(/\}%%$/, '');
    const config = JSON.parse(json);
    assert.strictEqual(config.theme, 'default');
    assert.strictEqual(config.themeVariables.background, '#ffffff');
    assert.strictEqual(config.themeVariables.textColor, '#111111');
    assert.strictEqual(config.flowchart.htmlLabels, false);
    assert.ok(String(config.themeVariables.fontFamily).includes('Segoe UI'));
  });

  test("respects an author's own init directive", () => {
    const authored = '%%{init: {"theme": "forest"}}%%\nflowchart TD\n  A --> B';
    const prepared = withExportDirective(authored);
    assert.strictEqual(prepared.applied, false);
    assert.strictEqual(prepared.code, authored);
  });

  test('detects directives regardless of leading whitespace', () => {
    assert.strictEqual(hasInitDirective('%%{init: {"theme":"dark"}}%%\ngraph TD'), true);
    assert.strictEqual(hasInitDirective('   \n%%{init: {"theme":"dark"}}%%\ngraph TD'), true);
    assert.strictEqual(hasInitDirective('%% just a comment\nflowchart TD'), false);
    assert.strictEqual(hasInitDirective('flowchart TD'), false);
  });
});

suite('svgRaster — captions and file names', () => {
  test('prefers a declared accTitle', () => {
    assert.strictEqual(
      diagramCaption('flowchart TD\n  accTitle: Aliran Kelulusan Permohonan\n  A --> B'),
      'Aliran Kelulusan Permohonan',
    );
  });

  test('names known diagram types', () => {
    assert.strictEqual(diagramCaption('flowchart TD\n  A --> B'), 'Flowchart');
    assert.strictEqual(diagramCaption('graph LR\n  A --> B'), 'Flowchart');
    assert.strictEqual(diagramCaption('sequenceDiagram\n  A->>B: hi'), 'Sequence diagram');
    assert.strictEqual(diagramCaption('erDiagram\n  A ||--o{ B : has'), 'ER diagram');
  });

  test('falls back to the first meaningful line, ignoring comments and blank lines', () => {
    assert.strictEqual(
      diagramCaption('%%{init: {"theme":"dark"}}%%\n\n  customDiagram  \n  X'),
      'customDiagram',
    );
  });

  test('numbers an unrecognisable, empty diagram', () => {
    assert.strictEqual(diagramCaption('', 3), 'Diagram 3');
  });

  test('truncates a long caption', () => {
    const caption = diagramCaption(`unknownType ${'x'.repeat(200)}`);
    assert.ok(caption.length <= 120, `caption was ${caption.length} chars`);
    assert.ok(caption.endsWith('…'));
  });

  test('builds a register-safe file stem', () => {
    assert.strictEqual(
      diagramFileName('dia-003', 'To-be Approval Flow'),
      'DIA-003-to-be-approval-flow',
    );
    assert.strictEqual(diagramFileName('DIA-004', ''), 'DIA-004');
    assert.strictEqual(diagramFileName('DIA-005', '***'), 'DIA-005');
    assert.ok(diagramFileName('DIA-006', 'x'.repeat(200)).length <= 70);
  });
});

suite('svgRaster — PNG validation', () => {
  test('accepts a real PNG signature', () => {
    assert.strictEqual(isValidPngBytes(PNG_2x1), true);
  });

  test('rejects short, empty and non-PNG data', () => {
    assert.strictEqual(isValidPngBytes(new Uint8Array(0)), false);
    assert.strictEqual(isValidPngBytes(new Uint8Array([0x89, 0x50])), false);
    assert.strictEqual(isValidPngBytes(new TextEncoder().encode('not a png at all')), false);
  });

  test('reads the real dimensions out of a rasterised PNG', () => {
    const inspected = inspectPngBase64(PNG_1x1_BASE64);
    assert.ok(inspected, 'expected a valid PNG');
    if (!inspected) {
      return;
    }
    assert.deepStrictEqual(inspected.size, { width: 1, height: 1 });
    assert.ok(inspected.bytes > 8);
  });

  test('reports the size it actually got, not the size requested', () => {
    const two = Buffer.from(PNG_2x1).toString('base64');
    assert.deepStrictEqual(inspectPngBase64(two)?.size, { width: 2, height: 1 });
  });

  test('rejects a JPEG, garbage and empty payloads', () => {
    assert.strictEqual(inspectPngBase64(JPEG_BASE64), null);
    assert.strictEqual(inspectPngBase64('not base64 !!'), null);
    assert.strictEqual(inspectPngBase64(''), null);
  });

  test('tolerates a truncated PNG because the header is intact', () => {
    const truncated = PNG_2x1.slice(0, 24);
    assert.strictEqual(inspectPngBase64(Buffer.from(truncated).toString('base64'))?.size.width, 2);
  });

  test('rejects a PNG whose header declares zero width', () => {
    const zero = PNG_2x1.slice();
    writeU32BE(zero, 16, 0);
    assert.strictEqual(inspectPngBase64(Buffer.from(zero).toString('base64')), null);
  });
});

import * as assert from 'assert';
import {
  A4_CONTENT_WIDTH_PX,
  DOCX_DPI,
  SUPPORTED_IMAGE_EXTENSIONS,
  fitToContentWidth,
  formatToMime,
  imageSize,
  sniffImageFormat,
} from '../../../shared/imageSize';
import {
  bmpBytes,
  gifBytes,
  jpegBytes,
  pngBytes,
  svgBytes,
  svgWith,
  truncatedPngBytes,
  webpVp8lBytes,
  webpVp8xBytes,
} from './imageFixtures';

suite('imageSize — format sniffing', () => {
  test('recognises every supported container from its signature', () => {
    assert.strictEqual(sniffImageFormat(pngBytes(10, 10)), 'png');
    assert.strictEqual(sniffImageFormat(jpegBytes(10, 10)), 'jpeg');
    assert.strictEqual(sniffImageFormat(gifBytes(10, 10)), 'gif');
    assert.strictEqual(sniffImageFormat(gifBytes(10, 10, '87a')), 'gif');
    assert.strictEqual(sniffImageFormat(webpVp8xBytes(10, 10)), 'webp');
    assert.strictEqual(sniffImageFormat(webpVp8lBytes(10, 10)), 'webp');
    assert.strictEqual(sniffImageFormat(bmpBytes(10, 10)), 'bmp');
    assert.strictEqual(sniffImageFormat(svgWith('width="10" height="10"')), 'svg');
  });

  test('reports unknown for empty and non-image input', () => {
    assert.strictEqual(sniffImageFormat(new Uint8Array(0)), 'unknown');
    assert.strictEqual(sniffImageFormat(new TextEncoder().encode('just some text\n')), 'unknown');
    assert.strictEqual(sniffImageFormat(new Uint8Array([0x42])), 'unknown');
  });

  test('detects SVG behind an XML declaration, comment or doctype', () => {
    const withComment = svgBytes('<!-- exported by mermaid -->\n<svg viewBox="0 0 10 10"></svg>');
    const withDoctype = svgBytes('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg></svg>');
    assert.strictEqual(sniffImageFormat(withComment), 'svg');
    assert.strictEqual(sniffImageFormat(withDoctype), 'svg');
  });

  test('does not claim HTML that merely embeds an svg element', () => {
    const html = svgBytes('<html><body><p>no image here</p></body></html>');
    assert.strictEqual(sniffImageFormat(html), 'unknown');
  });
});

suite('imageSize — raster dimensions', () => {
  test('reads PNG width/height from IHDR', () => {
    assert.deepStrictEqual(imageSize(pngBytes(640, 480)), { format: 'png', width: 640, height: 480 });
    assert.deepStrictEqual(imageSize(pngBytes(1, 1)), { format: 'png', width: 1, height: 1 });
  });

  test('returns null for a truncated PNG header instead of throwing', () => {
    assert.strictEqual(imageSize(truncatedPngBytes()), null);
  });

  test('reads the GIF logical screen descriptor', () => {
    assert.deepStrictEqual(imageSize(gifBytes(320, 200)), { format: 'gif', width: 320, height: 200 });
  });

  test('reads JPEG dimensions from SOF0', () => {
    assert.deepStrictEqual(imageSize(jpegBytes(1024, 768)), { format: 'jpeg', width: 1024, height: 768 });
  });

  test('walks past intervening JPEG segments to reach the frame header', () => {
    // Each APPn segment between SOI and SOF must be skipped by its length field.
    assert.deepStrictEqual(imageSize(jpegBytes(1920, 1080, 3)), { format: 'jpeg', width: 1920, height: 1080 });
  });

  test('returns null when a JPEG reaches scan data before any frame header', () => {
    const sos = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
    assert.strictEqual(imageSize(sos), null);
  });

  test('reads both WebP container variants', () => {
    assert.deepStrictEqual(imageSize(webpVp8xBytes(1200, 630)), { format: 'webp', width: 1200, height: 630 });
    assert.deepStrictEqual(imageSize(webpVp8lBytes(1200, 630)), { format: 'webp', width: 1200, height: 630 });
    assert.deepStrictEqual(imageSize(webpVp8lBytes(1, 1)), { format: 'webp', width: 1, height: 1 });
  });

  test('reads BMP dimensions and normalises a top-down negative height', () => {
    assert.deepStrictEqual(imageSize(bmpBytes(800, 600)), { format: 'bmp', width: 800, height: 600 });
    assert.deepStrictEqual(imageSize(bmpBytes(800, 600, true)), { format: 'bmp', width: 800, height: 600 });
  });

  test('rejects a raster header declaring zero dimensions', () => {
    assert.strictEqual(imageSize(pngBytes(0, 480)), null);
    assert.strictEqual(imageSize(gifBytes(320, 0)), null);
  });
});

suite('imageSize — SVG dimensions', () => {
  test('uses explicit px attributes', () => {
    assert.deepStrictEqual(imageSize(svgWith('width="320" height="200"')), { format: 'svg', width: 320, height: 200 });
    assert.deepStrictEqual(imageSize(svgWith('width="320px" height="200px"')), { format: 'svg', width: 320, height: 200 });
  });

  test('converts physical units at 96 dpi', () => {
    // A4 at 96 dpi: 210 mm = 793.7 px, 297 mm = 1122.5 px (rounds up to 1123).
    assert.deepStrictEqual(imageSize(svgWith('width="210mm" height="297mm"')), { format: 'svg', width: 794, height: 1123 });
    // 1 inch = 96 px at 96 dpi, whichever unit it is written in.
    assert.deepStrictEqual(imageSize(svgWith('width="2.54cm" height="1in"')), { format: 'svg', width: 96, height: 96 });
    assert.deepStrictEqual(imageSize(svgWith('width="72pt" height="6pc"')), { format: 'svg', width: 96, height: 96 });
  });

  test('falls back to the viewBox when no width/height are given', () => {
    assert.deepStrictEqual(imageSize(svgWith('viewBox="0 0 640 480"')), { format: 'svg', width: 640, height: 480 });
    assert.deepStrictEqual(imageSize(svgWith('viewBox="0,0,640,480"')), { format: 'svg', width: 640, height: 480 });
  });

  test('derives the missing dimension from the viewBox aspect ratio', () => {
    assert.deepStrictEqual(imageSize(svgWith('width="160" viewBox="0 0 640 480"')), {
      format: 'svg',
      width: 160,
      height: 120,
    });
    assert.deepStrictEqual(imageSize(svgWith('height="120" viewBox="0 0 640 480"')), {
      format: 'svg',
      width: 160,
      height: 120,
    });
  });

  test('prefers explicit attributes over the viewBox', () => {
    assert.deepStrictEqual(imageSize(svgWith('width="100" height="50" viewBox="0 0 640 480"')), {
      format: 'svg',
      width: 100,
      height: 50,
    });
  });

  test('accepts a lowercased viewbox attribute', () => {
    assert.deepStrictEqual(imageSize(svgWith('viewbox="0 0 12 8"')), { format: 'svg', width: 12, height: 8 });
  });

  test('returns null when the SVG carries no intrinsic size', () => {
    assert.strictEqual(imageSize(svgWith('')), null);
    assert.strictEqual(imageSize(svgWith('width="100%" height="100%"')), null);
    assert.strictEqual(imageSize(svgWith('viewBox="0 0 0 0"')), null);
  });

  test('decodes a UTF-8 BOM prefixed SVG', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...svgWith('width="30" height="20"')]);
    assert.deepStrictEqual(imageSize(withBom), { format: 'svg', width: 30, height: 20 });
  });
});

suite('imageSize — MIME mapping', () => {
  test('maps every supported format to its MIME type', () => {
    assert.strictEqual(DOCX_DPI, 96, 'Word measures images at 96 dpi');
    assert.strictEqual(formatToMime('png'), 'image/png');
    assert.strictEqual(formatToMime('jpeg'), 'image/jpeg');
    assert.strictEqual(formatToMime('gif'), 'image/gif');
    assert.strictEqual(formatToMime('webp'), 'image/webp');
    assert.strictEqual(formatToMime('bmp'), 'image/bmp');
    assert.strictEqual(formatToMime('svg'), 'image/svg+xml');
    assert.strictEqual(formatToMime('unknown'), 'application/octet-stream');
  });

  test('offers every sniffable raster format in the dialog filter list', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
      assert.ok((SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(extension), extension);
    }
  });
});

suite('imageSize — content width fitting', () => {
  test('leaves images narrower than the cap untouched', () => {
    assert.deepStrictEqual(fitToContentWidth(320, 200), { width: 320, height: 200 });
    assert.deepStrictEqual(fitToContentWidth(A4_CONTENT_WIDTH_PX, 100), { width: A4_CONTENT_WIDTH_PX, height: 100 });
  });

  test('scales wide images down preserving the aspect ratio', () => {
    assert.deepStrictEqual(fitToContentWidth(1280, 800), { width: 640, height: 400 });
    assert.deepStrictEqual(fitToContentWidth(1920, 1080), { width: 640, height: 360 });
    assert.deepStrictEqual(fitToContentWidth(2000, 1000), { width: 640, height: 320 });
  });

  test('honours a custom cap', () => {
    assert.deepStrictEqual(fitToContentWidth(1000, 500, 250), { width: 250, height: 125 });
  });

  test('never upscales a small image', () => {
    assert.deepStrictEqual(fitToContentWidth(16, 16), { width: 16, height: 16 });
  });

  test('degrades to a 1x1 box for invalid input rather than emitting NaN to Word', () => {
    assert.deepStrictEqual(fitToContentWidth(0, 100), { width: 1, height: 1 });
    assert.deepStrictEqual(fitToContentWidth(Number.NaN, 100), { width: 1, height: 1 });
    assert.deepStrictEqual(fitToContentWidth(100, -5), { width: 1, height: 1 });
    assert.deepStrictEqual(fitToContentWidth(1000, 500, 0), { width: 640, height: 320 });
  });
});

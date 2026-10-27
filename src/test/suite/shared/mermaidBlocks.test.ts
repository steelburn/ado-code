import * as assert from 'assert';

import type { DocBlock, DocBlockWarning } from '../../../shared/docBlocks';
import {
  rasterizeMermaidBlocks,
  stripResolvedWarnings,
  type DiagramRasterRequest,
  type RasterizedDiagram,
} from '../../../shared/mermaidBlocks';
import { PNG_DATA_URI_PREFIX } from '../../../shared/svgRaster';

const PNG_1x1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]).toString('base64');

function mermaidBlock(raw: string, line: number): DocBlock {
  return { kind: 'unsupported', reason: 'mermaid', raw, line };
}

function recordingRasterizer(
  respond: (request: DiagramRasterRequest) => RasterizedDiagram = () => ({
    ok: true,
    pngBase64: PNG_1x1,
    width: 640,
    height: 400,
  }),
): { rasterize: (request: DiagramRasterRequest) => RasterizedDiagram; requests: DiagramRasterRequest[] } {
  const requests: DiagramRasterRequest[] = [];
  return {
    requests,
    rasterize: (request) => {
      requests.push(request);
      return respond(request);
    },
  };
}

suite('mermaidBlocks — substitution', () => {
  test('replaces a mermaid fence with an image block carrying a data URI', async () => {
    const { rasterize } = recordingRasterizer();
    const result = await rasterizeMermaidBlocks(
      [mermaidBlock('flowchart TD\n  A --> B', 12)],
      rasterize,
    );

    assert.strictEqual(result.rasterised, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.blocks.length, 1);

    const block = result.blocks[0];
    assert.strictEqual(block.kind, 'image');
    if (block.kind !== 'image') {
      return;
    }
    assert.ok(block.ref.startsWith(PNG_DATA_URI_PREFIX), block.ref.slice(0, 40));
    assert.strictEqual(block.ref, `${PNG_DATA_URI_PREFIX}${PNG_1x1}`);
    assert.strictEqual(block.alt, 'Flowchart');
    assert.strictEqual(block.widthPx, undefined, 'the image pipeline decides the width');
  });

  test('records the fence line as resolved so the parser warning can be dropped', async () => {
    const { rasterize } = recordingRasterizer();
    const result = await rasterizeMermaidBlocks(
      [mermaidBlock('flowchart TD\n  A --> B', 12)],
      rasterize,
    );
    assert.deepStrictEqual(result.resolvedLines, [12]);
    assert.deepStrictEqual(result.warnings, []);
  });

  test('exposes the data URI for the media register / saved diagrams', async () => {
    const { rasterize } = recordingRasterizer();
    const result = await rasterizeMermaidBlocks(
      [mermaidBlock('flowchart TD\n  A --> B', 5)],
      rasterize,
    );
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.images[0].line, 5);
    assert.strictEqual(result.images[0].caption, 'Flowchart');
    assert.strictEqual(result.images[0].width, 640);
    assert.strictEqual(result.images[0].ref, `${PNG_DATA_URI_PREFIX}${PNG_1x1}`);
  });

  test('preserves order and leaves every other block untouched', async () => {
    const blocks: DocBlock[] = [
      { kind: 'heading', level: 1, text: 'Pendahuluan', runs: [{ text: 'Pendahuluan' }] },
      mermaidBlock('flowchart TD\n  A --> B', 4),
      { kind: 'paragraph', runs: [{ text: 'Selepas rajah.' }] },
      { kind: 'unsupported', reason: 'html', raw: '<div class="x"></div>', line: 9 },
    ];
    const { rasterize } = recordingRasterizer();
    const result = await rasterizeMermaidBlocks(blocks, rasterize);

    assert.deepStrictEqual(
      result.blocks.map((b) => b.kind),
      ['heading', 'image', 'paragraph', 'unsupported'],
    );
    assert.strictEqual(result.blocks[0], blocks[0], 'non-mermaid blocks keep their identity');
    assert.strictEqual(result.blocks[3], blocks[3], 'raw HTML stays unsupported');
    assert.strictEqual(result.rasterised, 1);
  });

  test('passes the fence body, caption, line and index to the rasteriser', async () => {
    const { rasterize, requests } = recordingRasterizer();
    await rasterizeMermaidBlocks(
      [
        mermaidBlock('flowchart TD\n  A --> B', 3),
        { kind: 'paragraph', runs: [{ text: 'x' }] },
        mermaidBlock('sequenceDiagram\n  accTitle: Aliran Bayaran\n  A->>B: hi', 20),
      ],
      rasterize,
    );

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0].code, 'flowchart TD\n  A --> B');
    assert.strictEqual(requests[0].line, 3);
    assert.strictEqual(requests[0].index, 1);
    assert.strictEqual(requests[0].caption, 'Flowchart');
    assert.strictEqual(requests[1].index, 2, 'index counts mermaid fences only');
    assert.strictEqual(requests[1].caption, 'Aliran Bayaran');
  });
});

suite('mermaidBlocks — failure handling', () => {
  test('keeps the unsupported block and warns when rasterisation fails', async () => {
    const { rasterize } = recordingRasterizer(() => ({ ok: false, error: 'canvas unavailable' }));
    const result = await rasterizeMermaidBlocks(
      [mermaidBlock('flowchart TD\n  A --> B', 7)],
      rasterize,
    );

    assert.strictEqual(result.rasterised, 0);
    assert.strictEqual(result.failed, 1);
    assert.deepStrictEqual(result.resolvedLines, []);
    assert.strictEqual(result.blocks[0].kind, 'unsupported', 'the omission must still be reported');

    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('line 7'), result.warnings[0]);
    assert.ok(result.warnings[0].includes('Flowchart'), result.warnings[0]);
    assert.ok(result.warnings[0].includes('canvas unavailable'), result.warnings[0]);
  });

  test('treats a thrown rasteriser as a failure, not a crash', async () => {
    const result = await rasterizeMermaidBlocks([mermaidBlock('flowchart TD', 2)], () => {
      throw new Error('mermaid exploded');
    });

    assert.strictEqual(result.failed, 1);
    assert.ok(result.warnings[0].includes('mermaid exploded'), result.warnings[0]);
    assert.strictEqual(result.blocks[0].kind, 'unsupported');
  });

  test('treats "ok without a PNG" as a failure', async () => {
    const { rasterize } = recordingRasterizer(() => ({ ok: true }));
    const result = await rasterizeMermaidBlocks([mermaidBlock('flowchart TD', 2)], rasterize);

    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.rasterised, 0);
    assert.ok(/returned no PNG/.test(result.warnings[0]), result.warnings[0]);
  });

  test('carries rasteriser warnings (e.g. a canvas clamp) into the document warnings', async () => {
    const { rasterize } = recordingRasterizer(() => ({
      ok: true,
      pngBase64: PNG_1x1,
      warnings: ['Diagram rendered at 1× instead of 2×: canvas limit.'],
    }));
    const result = await rasterizeMermaidBlocks(
      [mermaidBlock('flowchart TD\n  accTitle: Rajah Besar', 14)],
      rasterize,
    );

    assert.strictEqual(result.rasterised, 1);
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].startsWith('Diagram at line 14 (Rajah Besar): '), result.warnings[0]);
    assert.ok(result.warnings[0].includes('canvas limit'));
  });

  test('a failing diagram does not stop the ones after it', async () => {
    let call = 0;
    const result = await rasterizeMermaidBlocks(
      [mermaidBlock('flowchart TD', 2), mermaidBlock('sequenceDiagram', 30)],
      () => {
        call += 1;
        return call === 1 ? { ok: false, error: 'first failed' } : { ok: true, pngBase64: PNG_1x1 };
      },
    );

    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.rasterised, 1);
    assert.deepStrictEqual(
      result.blocks.map((b) => b.kind),
      ['unsupported', 'image'],
    );
  });
});

suite('mermaidBlocks — no-op cases', () => {
  test('returns the same blocks when there is nothing to rasterise', async () => {
    const blocks: DocBlock[] = [{ kind: 'paragraph', runs: [{ text: 'tiada rajah' }] }];
    let called = false;
    const result = await rasterizeMermaidBlocks(blocks, () => {
      called = true;
      return { ok: true, pngBase64: PNG_1x1 };
    });

    assert.strictEqual(called, false);
    assert.strictEqual(result.rasterised, 0);
    assert.strictEqual(result.failed, 0);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.resolvedLines, []);
    assert.strictEqual(result.blocks.length, 1);
  });

  test('handles an empty block list', async () => {
    const result = await rasterizeMermaidBlocks([], () => ({ ok: true, pngBase64: PNG_1x1 }));
    assert.deepStrictEqual(result.blocks, []);
    assert.strictEqual(result.rasterised, 0);
  });
});

suite('mermaidBlocks — warning resolution', () => {
  const mermaidWarning = (line: number): DocBlockWarning => ({
    line,
    code: 'unsupported-mermaid',
    message: 'mermaid diagram omitted',
  });
  const htmlWarning = (line: number): DocBlockWarning => ({
    line,
    code: 'unsupported-html',
    message: 'raw HTML omitted',
  });

  test('drops the mermaid warning for a rasterised line', () => {
    const warnings = [mermaidWarning(4), htmlWarning(9)];
    assert.deepStrictEqual(stripResolvedWarnings(warnings, [4]), [warnings[1]]);
  });

  test('keeps an unrelated warning that happens to share the line', () => {
    const warnings = [mermaidWarning(4), htmlWarning(4)];
    assert.deepStrictEqual(stripResolvedWarnings(warnings, [4]), [warnings[1]]);
  });

  test('keeps every warning when nothing was resolved', () => {
    const warnings = [mermaidWarning(4)];
    assert.deepStrictEqual(stripResolvedWarnings(warnings, []), warnings);
  });

  test('does not mutate the input', () => {
    const warnings = [mermaidWarning(4)];
    const before = warnings.length;
    stripResolvedWarnings(warnings, [4]);
    assert.strictEqual(warnings.length, before);
  });
});

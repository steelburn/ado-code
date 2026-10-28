import * as assert from 'assert';
import { mdToDocBlocks } from '../../../shared/docBlocks';
import {
  DOC_GEOMETRY,
  buildCoverRows,
  buildFooterSegments,
  buildHeader,
  classificationBanner,
  columnWidths,
  docxImageType,
  labelsFor,
  planDocument,
  planImage,
  statusLabel,
  type DocxImageCollection,
} from '../../../shared/docxLayout';

const FRONT_MATTER_DOC = [
  '---',
  'docId: PROJ-BA-BRS-001',
  'title: Business Requirements Specification',
  'version: 1.2',
  'status: In Review',
  'owner: Business Analyst',
  'approver: Project Director',
  'adoWorkItem: 26934',
  'classification: TERHAD',
  'lang: en',
  '---',
  '',
  '# 1. Introduction',
  '',
  'Body text with **bold** and `code`.',
  '',
  '| ID | Requirement |',
  '| --- | --- |',
  '| FR-001 | The system **shall** authenticate users. |',
  '',
  '![Login screen](assets/img/FIG-001.png)',
  '',
  '![Missing](assets/img/FIG-404.png)',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '```json',
  '{ "a": 1 }',
  '```',
  '',
  '- [ ] first task',
  '- [x] second task',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '> quoted line',
  '',
  '---',
  '',
  '<!-- raw html -->',
  '',
  '## 2. Final',
].join('\n');

const BM_FRONT_MATTER_DOC = [
  '---',
  'id-dokumen: PROJ-BA-BRS-002',
  'tajuk: Spesifikasi Keperluan Perniagaan',
  'versi: 0.9',
  'status: Draft',
  'pemilik-dokumen: Penganalisis Perniagaan',
  'pelulus: Pengarah Projek',
  'klasifikasi: SULIT',
  'bahasa: Bahasa Malaysia',
  '---',
  '',
  '# Pengenalan',
].join('\n');

function imageCollection(): DocxImageCollection {
  return {
    byRef: {
      'assets/img/FIG-001.png': {
        refs: ['assets/img/FIG-001.png'],
        mime: 'image/png',
        format: 'png',
        width: 400,
        height: 200,
        base64: 'iVBORw0KGgo=',
      },
      'assets/img/wide.png': {
        refs: ['assets/img/wide.png'],
        mime: 'image/png',
        format: 'png',
        width: 1000,
        height: 500,
        base64: 'iVBORw0KGgo=',
      },
      'assets/img/shot.webp': {
        refs: ['assets/img/shot.webp'],
        mime: 'image/webp',
        format: 'webp',
        width: 800,
        height: 600,
        base64: 'UklGRg==',
      },
      'assets/img/zero.png': {
        refs: ['assets/img/zero.png'],
        mime: 'image/png',
        format: 'png',
        width: 0,
        height: 0,
        base64: 'iVBORw0KGgo=',
      },
      'assets/img/diagram.svg': {
        refs: ['assets/img/diagram.svg'],
        mime: 'image/svg+xml',
        format: 'svg',
        width: 640,
        height: 480,
        base64: 'PHN2Zz4=',
      },
    },
  };
}

suite('docxLayout — geometry', () => {
  test('the A4 text column is page width minus both 20 mm margins', () => {
    assert.strictEqual(
      DOC_GEOMETRY.pageWidthTwip - 2 * DOC_GEOMETRY.marginTwip,
      DOC_GEOMETRY.contentWidthTwip,
    );
  });

  test('A4 portrait dimensions are 210 x 297 mm in twips', () => {
    assert.strictEqual(DOC_GEOMETRY.pageWidthTwip, 11906);
    assert.strictEqual(DOC_GEOMETRY.pageHeightTwip, 16838);
  });

  test('the pixel content width matches the image cap at 96 dpi', () => {
    assert.strictEqual(DOC_GEOMETRY.contentWidthPx, 640);
  });
});

suite('docxLayout — labels', () => {
  test('English labels are used for English and bilingual documents', () => {
    assert.strictEqual(labelsFor('en').docId, 'Document ID');
    assert.strictEqual(labelsFor('bilingual').docId, 'Document ID');
  });

  test('Bahasa Malaysia documents get BM cover and footer labels', () => {
    const labels = labelsFor('ms');
    assert.strictEqual(labels.docId, 'ID Dokumen');
    assert.strictEqual(labels.owner, 'Pemilik Dokumen');
    assert.strictEqual(labels.page, 'Halaman');
    assert.strictEqual(labels.of, 'daripada');
  });

  test('document status is localised, unknown values pass through', () => {
    assert.strictEqual(statusLabel('ms', 'In Review'), 'Dalam Semakan');
    assert.strictEqual(statusLabel('ms', 'Draft'), 'Draf');
    assert.strictEqual(statusLabel('ms', 'Awaiting Signature'), 'Awaiting Signature');
    assert.strictEqual(statusLabel('en', 'Draft'), 'Draft');
  });
});

suite('docxLayout — classification banner', () => {
  test('INTERNAL and empty classifications produce no banner', () => {
    const labels = labelsFor('en');
    assert.strictEqual(classificationBanner({ ...baseMeta(), classification: 'INTERNAL' }, labels), null);
    assert.strictEqual(classificationBanner({ ...baseMeta(), classification: '  ' }, labels), null);
  });

  test('restricted classifications get the red banner in English', () => {
    const banner = classificationBanner({ ...baseMeta(), classification: 'terhad' }, labelsFor('en'));
    assert.ok(banner);
    assert.strictEqual(banner.code, 'TERHAD');
    assert.strictEqual(banner.text, 'TERHAD — CONTROLLED DOCUMENT');
    assert.strictEqual(banner.fill, 'F4CCCC');
  });

  test('restricted classifications get the BM banner', () => {
    const banner = classificationBanner(
      { ...baseMeta(), classification: 'SULIT', lang: 'ms' },
      labelsFor('ms'),
    );
    assert.ok(banner);
    assert.strictEqual(banner.text, 'SULIT — DOKUMEN TERKAWAL');
  });

  test('a non-restricted classification gets the amber banner', () => {
    const banner = classificationBanner({ ...baseMeta(), classification: 'OFFICIAL' }, labelsFor('en'));
    assert.ok(banner);
    assert.strictEqual(banner.fill, 'FFF2CC');
  });
});

suite('docxLayout — cover page', () => {
  test('rows appear in control-table order', () => {
    const rows = buildCoverRows(baseMeta(), labelsFor('en'));
    assert.deepStrictEqual(
      rows.map((row) => row.label),
      ['Document ID', 'Version', 'Status', 'Document owner', 'Approver', 'Classification', 'ADO work item'],
    );
  });

  test('an absent ADO work item omits the row entirely', () => {
    const rows = buildCoverRows({ ...baseMeta(), adoWorkItem: '  ' }, labelsFor('en'));
    assert.ok(!rows.some((row) => row.label === 'ADO work item'));
  });

  test('missing values render as (not set) rather than blank cells', () => {
    const rows = buildCoverRows({ ...baseMeta(), owner: '', approver: '   ' }, labelsFor('en'));
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    assert.strictEqual(byLabel.get('Document owner'), '(not set)');
    assert.strictEqual(byLabel.get('Approver'), '(not set)');
  });

  test('BM cover rows use BM labels and a localised status', () => {
    const rows = buildCoverRows(
      { ...baseMeta(), status: 'Approved', lang: 'ms' },
      labelsFor('ms'),
    );
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    assert.strictEqual(byLabel.get('ID Dokumen'), 'PROJ-BA-BRS-001');
    assert.strictEqual(byLabel.get('Status'), 'Diluluskan');
    assert.strictEqual(byLabel.get('Pemilik Dokumen'), 'Business Analyst');
  });
});

suite('docxLayout — header and footer', () => {
  test('the header carries the doc id, title and classification', () => {
    const header = buildHeader(baseMeta(), labelsFor('en'));
    assert.strictEqual(header.left, 'PROJ-BA-BRS-001 · Business Requirements Specification');
    assert.strictEqual(header.right, 'TERHAD');
  });

  test('an INTERNAL document has no classification in the header', () => {
    const header = buildHeader({ ...baseMeta(), classification: 'INTERNAL' }, labelsFor('en'));
    assert.strictEqual(header.right, '');
  });

  test('the footer paginates with Word field markers, not literal text', () => {
    const segments = buildFooterSegments({ ...baseMeta(), classification: 'INTERNAL' }, labelsFor('en'));
    assert.deepStrictEqual(segments, [
      { text: 'PROJ-BA-BRS-001' },
      { text: ' · ' },
      { text: 'Version 1.2' },
      { text: ' · ' },
      { text: 'Page ' },
      { field: 'page' },
      { text: ' of ' },
      { field: 'pages' },
    ]);
  });

  test('a classified document repeats the classification in the footer', () => {
    const segments = buildFooterSegments(baseMeta(), labelsFor('en'));
    assert.deepStrictEqual(segments.slice(0, 2), [{ text: 'TERHAD' }, { text: ' · ' }]);
  });

  test('BM footers read Halaman X daripada Y', () => {
    const segments = buildFooterSegments({ ...baseMeta(), lang: 'ms' }, labelsFor('ms'));
    const text = segments.map((segment) => ('text' in segment ? segment.text : `[[${segment.field}]]`)).join('');
    assert.ok(text.includes('Halaman [[page]] daripada [[pages]]'), text);
  });
});

suite('docxLayout — images', () => {
  test('Word-native formats map to the docx type token', () => {
    assert.strictEqual(docxImageType('png'), 'png');
    assert.strictEqual(docxImageType('jpeg'), 'jpg');
    assert.strictEqual(docxImageType('gif'), 'gif');
    assert.strictEqual(docxImageType('bmp'), 'bmp');
  });

  test('WebP and SVG are refused rather than embedded broken', () => {
    assert.strictEqual(docxImageType('webp'), null);
    assert.strictEqual(docxImageType('svg'), null);
    assert.strictEqual(docxImageType('tiff'), null);
  });

  test('an image narrower than the column keeps its intrinsic width', () => {
    const { image, warning } = planImage('assets/img/FIG-001.png', 'Login', undefined, imageCollection());
    assert.strictEqual(warning, undefined);
    assert.ok(image.ok);
    assert.strictEqual(image.widthPx, 400);
    assert.strictEqual(image.heightPx, 200);
    assert.strictEqual(image.alt, 'Login');
    assert.strictEqual(image.type, 'png');
  });

  test('an image wider than the column is scaled to the content width', () => {
    const { image } = planImage('assets/img/wide.png', 'Wide', undefined, imageCollection());
    assert.ok(image.ok);
    assert.strictEqual(image.widthPx, 640);
    assert.strictEqual(image.heightPx, 320);
  });

  test('a width hint narrows an image but never upscales it', () => {
    const narrowed = planImage('assets/img/FIG-001.png', '', 200, imageCollection());
    assert.ok(narrowed.image.ok);
    assert.strictEqual(narrowed.image.widthPx, 200);
    assert.strictEqual(narrowed.image.heightPx, 100);

    const upscaleAttempt = planImage('assets/img/FIG-001.png', '', 900, imageCollection());
    assert.ok(upscaleAttempt.image.ok);
    assert.strictEqual(upscaleAttempt.image.widthPx, 400);
  });

  test('a missing reference is reported, not thrown', () => {
    const { image, warning } = planImage('assets/img/FIG-404.png', 'Gone', undefined, imageCollection());
    assert.strictEqual(image.ok, false);
    assert.ok(!image.ok);
    assert.strictEqual(image.reason, 'missing');
    assert.ok(warning && warning.includes('FIG-404.png'), warning);
  });

  test('an empty reference is reported', () => {
    const { image, warning } = planImage('   ', '', undefined, imageCollection());
    assert.ok(!image.ok);
    assert.strictEqual(image.reason, 'missing');
    assert.ok(warning && warning.includes('(empty reference)'), warning);
  });

  test('an unsupported format warns with the target format', () => {
    const { image, warning } = planImage('assets/img/shot.webp', '', undefined, imageCollection());
    assert.ok(!image.ok);
    assert.strictEqual(image.reason, 'unsupported-format');
    assert.ok(warning && warning.includes('convert'), warning);
  });

  test('an image with no intrinsic size is reported', () => {
    const { image } = planImage('assets/img/zero.png', '', undefined, imageCollection());
    assert.ok(!image.ok);
    assert.strictEqual(image.reason, 'no-dimensions');
  });
});

suite('docxLayout — tables', () => {
  test('columns split the content width exactly', () => {
    const widths = columnWidths(3);
    assert.strictEqual(widths.length, 3);
    assert.strictEqual(
      widths.reduce((sum, width) => sum + width, 0),
      DOC_GEOMETRY.contentWidthTwip,
    );
  });

  test('the remainder lands in the last column', () => {
    const widths = columnWidths(3);
    assert.deepStrictEqual(widths, [3212, 3212, 3214]);
  });

  test('a single column spans the whole text column', () => {
    assert.deepStrictEqual(columnWidths(1), [DOC_GEOMETRY.contentWidthTwip]);
  });
});

suite('docxLayout — planDocument', () => {
  test('a full document plans every block in order', () => {
    const parsed = mdToDocBlocks(FRONT_MATTER_DOC);
    const plan = planDocument(parsed, imageCollection());
    const kinds = plan.blocks.map((block) => block.kind);
    assert.deepStrictEqual(kinds, [
      'heading',
      'paragraph',
      'table',
      'image',
      'image',
      'notice',
      'code',
      'list',
      'list',
      'paragraph',
      'rule',
      'heading',
    ]);
  });

  test('the cover page reflects the front matter', () => {
    const plan = planDocument(mdToDocBlocks(FRONT_MATTER_DOC), imageCollection());
    assert.strictEqual(plan.cover.title, 'Business Requirements Specification');
    assert.strictEqual(plan.cover.banner?.code, 'TERHAD');
    assert.deepStrictEqual(
      plan.cover.rows.slice(0, 2),
      [
        { label: 'Document ID', value: 'PROJ-BA-BRS-001' },
        { label: 'Version', value: '1.2' },
      ],
    );
  });

  test('a missing image becomes a failed image block plus a warning', () => {
    const plan = planDocument(mdToDocBlocks(FRONT_MATTER_DOC), imageCollection());
    const images = plan.blocks.filter((block) => block.kind === 'image');
    assert.strictEqual(images.length, 2, 'the resolvable image and the unresolvable one');
    const missing = images[1];
    assert.ok(missing && missing.kind === 'image' && !missing.image.ok);
    assert.strictEqual(
      missing.kind === 'image' && !missing.image.ok ? missing.image.reason : '',
      'missing',
    );
    assert.ok(plan.warnings.some((warning) => warning.includes('FIG-404.png')), plan.warnings.join('|'));
  });

  test('a mermaid fence is replaced by a visible notice and a warning', () => {
    const plan = planDocument(mdToDocBlocks(FRONT_MATTER_DOC), imageCollection());
    assert.ok(plan.warnings.some((warning) => /mermaid/i.test(warning)), plan.warnings.join('|'));
    const notices = plan.blocks.filter((block) => block.kind === 'notice');
    assert.strictEqual(notices.length, 1);
    assert.ok(notices[0].kind === 'notice' && notices[0].text.includes('Diagram omitted'));
  });

  test('raw HTML is flagged as omitted', () => {
    const plan = planDocument(mdToDocBlocks('# Title\n\n<div class="x">chart</div>\n'), { byRef: {} });
    assert.ok(
      plan.blocks.some((block) => block.kind === 'notice' && block.text.includes('Formatted content omitted')),
    );
    assert.ok(plan.warnings.some((warning) => /raw HTML cannot be rendered/i.test(warning)), plan.warnings.join('|'));
  });

  test('HTML comments are dropped without a notice — parity with pandoc', () => {
    const plan = planDocument(mdToDocBlocks('# Title\n\n<!-- reviewer note -->\n\nBody.'), { byRef: {} });
    assert.deepStrictEqual(
      plan.blocks.map((block) => block.kind),
      ['heading', 'paragraph'],
      'the comment is markup, not content, so it must not become a paragraph or a notice',
    );
    assert.ok(
      !plan.warnings.some((warning) => /omitted/i.test(warning)),
      'dropping a comment is not an omission: ' + plan.warnings.join('|'),
    );
  });

  test('parser warnings are folded into the export warnings with line numbers', () => {
    const plan = planDocument(mdToDocBlocks('# Heading only\n\nNo front matter.'), { byRef: {} });
    assert.ok(plan.warnings.some((warning) => /^Line \d+:/.test(warning)), plan.warnings.join('|'));
  });

  test('a Bahasa Malaysia document plans with BM labels throughout', () => {
    const plan = planDocument(mdToDocBlocks(BM_FRONT_MATTER_DOC), { byRef: {} });
    assert.strictEqual(plan.meta.lang, 'ms');
    assert.strictEqual(plan.labels.docId, 'ID Dokumen');
    assert.strictEqual(plan.cover.title, 'Spesifikasi Keperluan Perniagaan');
    assert.strictEqual(plan.cover.banner?.text, 'SULIT — DOKUMEN TERKAWAL');
    assert.deepStrictEqual(
      plan.cover.rows[2],
      { label: 'Status', value: 'Draf' },
      'BM documents localise the status value',
    );
  });

  test('the header can be suppressed for short documents', () => {
    const plan = planDocument(mdToDocBlocks(FRONT_MATTER_DOC), imageCollection(), { includeHeader: false });
    assert.strictEqual(plan.header, null);
  });

  test('a custom image cap is honoured', () => {
    const plan = planDocument(mdToDocBlocks(FRONT_MATTER_DOC), imageCollection(), { maxWidthPx: 200 });
    const images = plan.blocks.filter((block) => block.kind === 'image');
    const first = images[0];
    assert.ok(first && first.kind === 'image' && first.image.ok);
    assert.ok(first.kind === 'image' && first.image.ok && first.image.widthPx <= 200);
  });

  test('a numbered list directly after a bullet list stays numbered', () => {
    const plan = planDocument(mdToDocBlocks('- bullet one\n- bullet two\n\n1. first\n2. second\n'), {
      byRef: {},
    });
    const lists = plan.blocks.filter((block) => block.kind === 'list');
    assert.strictEqual(lists.length, 2, 'a marker change starts a new list block');
    assert.ok(lists[0].kind === 'list' && lists[0].ordered === false);
    assert.ok(lists[1].kind === 'list' && lists[1].ordered === true);
    assert.strictEqual(lists[1].kind === 'list' ? lists[1].items.length : 0, 2);
  });

  test('inline HTML warns instead of leaking literal tags into Word', () => {
    const plan = planDocument(mdToDocBlocks('# T\n\nline one<br>line two\n'), { byRef: {} });
    assert.ok(
      plan.warnings.some((warning) => /inline HTML cannot be rendered/i.test(warning)),
      plan.warnings.join('|'),
    );
  });

  test('an empty document still produces a usable plan', () => {
    const plan = planDocument(mdToDocBlocks(''), { byRef: {} });
    assert.deepStrictEqual(plan.blocks, []);
    assert.strictEqual(plan.cover.title, '(not set)');
  });
});

function baseMeta() {
  return {
    docId: 'PROJ-BA-BRS-001',
    title: 'Business Requirements Specification',
    version: '1.2',
    status: 'In Review',
    owner: 'Business Analyst',
    approver: 'Project Director',
    adoWorkItem: '26934',
    classification: 'TERHAD',
    lang: 'en' as const,
    extra: {},
  };
}

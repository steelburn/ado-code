import * as assert from 'assert';
import {
  mdToDocBlocks,
  parseInline,
  runsToText,
  REQUIRED_FRONT_MATTER,
  type DocBlock,
  type ParsedDoc,
} from '../../../shared/docBlocks';

/** Build markdown source without fighting backtick-escaping inside template literals. */
const md = (...lines: string[]): string => lines.join('\n');

const kinds = (doc: ParsedDoc): string[] => doc.blocks.map(b => b.kind);

const only = <K extends DocBlock['kind']>(doc: ParsedDoc, kind: K): Extract<DocBlock, { kind: K }> => {
  const found = doc.blocks.filter(b => b.kind === kind) as Array<Extract<DocBlock, { kind: K }>>;
  assert.strictEqual(found.length, 1, `expected exactly one ${kind} block, found ${found.length}`);
  return found[0];
};

const codes = (doc: ParsedDoc): string[] => doc.warnings.map(w => w.code);

const FRONT = [
  '---',
  'docId: DEMO-BA-FRS-001',
  'title: Functional Requirements',
  'version: 1.2',
  'owner: Business Analyst',
  'approver: Project Director',
  'classification: TERHAD',
  'ado-work-item: 26940',
  '---',
];

suite('shared/docBlocks', () => {
  suite('front matter', () => {
    test('parses the English header keys', () => {
      const doc = mdToDocBlocks(md(...FRONT, '# Body'));
      assert.strictEqual(doc.meta.docId, 'DEMO-BA-FRS-001');
      assert.strictEqual(doc.meta.title, 'Functional Requirements');
      assert.strictEqual(doc.meta.version, '1.2');
      assert.strictEqual(doc.meta.owner, 'Business Analyst');
      assert.strictEqual(doc.meta.approver, 'Project Director');
      assert.strictEqual(doc.meta.classification, 'TERHAD');
      assert.strictEqual(doc.meta.adoWorkItem, '26940');
      assert.deepStrictEqual(doc.warnings, []);
    });

    test('defaults status, classification and lang when the keys are absent', () => {
      const doc = mdToDocBlocks(md('---', 'docId: X', 'title: T', 'version: 1.0', 'owner: BA', '---', '# Body'));
      assert.strictEqual(doc.meta.status, 'Draft');
      assert.strictEqual(doc.meta.classification, 'INTERNAL');
      assert.strictEqual(doc.meta.lang, 'en');
    });

    test('maps the Bahasa Malaysia aliases onto the same fields', () => {
      const doc = mdToDocBlocks(
        md(
          '---',
          'id-dokumen: DEMO-BA-FRS-002',
          'tajuk: Keperluan Fungsian',
          'versi: 2.0',
          'pemilik-dokumen: Penganalisis Perniagaan',
          'pelulus: Pengarah Projek',
          'klasifikasi: TERHAD',
          'bahasa: Bahasa Malaysia',
          '---',
          '# Pengenalan'
        )
      );
      assert.strictEqual(doc.meta.docId, 'DEMO-BA-FRS-002');
      assert.strictEqual(doc.meta.title, 'Keperluan Fungsian');
      assert.strictEqual(doc.meta.version, '2.0');
      assert.strictEqual(doc.meta.owner, 'Penganalisis Perniagaan');
      assert.strictEqual(doc.meta.approver, 'Pengarah Projek');
      assert.strictEqual(doc.meta.classification, 'TERHAD');
      assert.strictEqual(doc.meta.lang, 'ms');
      assert.deepStrictEqual(doc.warnings, []);
    });

    test('recognises a bilingual document', () => {
      const doc = mdToDocBlocks(md('---', 'docId: X', 'title: T', 'version: 1', 'owner: BA', 'lang: English + Bahasa Malaysia', '---'));
      assert.strictEqual(doc.meta.lang, 'bilingual');
    });

    test('preserves unknown keys in extra', () => {
      const doc = mdToDocBlocks(md('---', 'docId: X', 'title: T', 'version: 1', 'owner: BA', 'contract-ref: JAN-2026/014', '---'));
      assert.strictEqual(doc.meta.extra['contract-ref'], 'JAN-2026/014');
    });

    test('warns about every missing required key', () => {
      const doc = mdToDocBlocks(md('---', 'title: Only a title', '---', '# Body'));
      const missing = doc.warnings.filter(w => w.code === 'missing-front-matter-key');
      assert.deepStrictEqual(
        missing.map(w => w.message),
        REQUIRED_FRONT_MATTER.filter(k => k !== 'title').map(k => `front matter is missing required key '${k}'`)
      );
    });

    test('warns and still parses the body when there is no front matter', () => {
      const doc = mdToDocBlocks(md('# Title', 'Body text.'));
      assert.deepStrictEqual(codes(doc), ['no-front-matter']);
      assert.strictEqual(only(doc, 'heading').level, 1);
    });

    test('keeps a hash inside a quoted value', () => {
      const doc = mdToDocBlocks(md('---', 'docId: X', 'title: "Release #4 notes"', 'version: 1', 'owner: BA', '---'));
      assert.strictEqual(doc.meta.title, 'Release #4 notes');
    });

    test('ignores a trailing comment on an unquoted value', () => {
      const doc = mdToDocBlocks(md('---', 'docId: X', 'title: T', 'version: 1 # bumped by CR-007', 'owner: BA', '---'));
      assert.strictEqual(doc.meta.version, '1');
    });

    test('line numbers point into the original file past the front matter', () => {
      const doc = mdToDocBlocks(md(...FRONT, '# Body', '', 'Text', '', '```mermaid', 'graph TD', '```'));
      const mermaid = doc.warnings.find(w => w.code === 'unsupported-mermaid');
      assert.strictEqual(mermaid?.line, 14);
    });
  });

  suite('headings and paragraphs', () => {
    test('parses ATX heading levels', () => {
      const doc = mdToDocBlocks(md('# One', '## Two', '### Three', '#### Four', '##### Five', '###### Six'));
      assert.deepStrictEqual(
        doc.blocks.map(b => (b.kind === 'heading' ? b.level : 0)),
        [1, 2, 3, 4, 5, 6]
      );
    });

    test('strips closing hashes from a heading', () => {
      const doc = mdToDocBlocks(md('## Scope ##'));
      assert.strictEqual(only(doc, 'heading').text, 'Scope');
    });

    test('folds soft-wrapped lines into one paragraph', () => {
      const doc = mdToDocBlocks(md('This requirement is long', 'and wraps across lines.'));
      assert.strictEqual(runsToText(only(doc, 'paragraph').runs), 'This requirement is long and wraps across lines.');
    });

    test('keeps a two-space hard break as a newline run', () => {
      const doc = mdToDocBlocks(md('First line  ', 'Second line'));
      assert.strictEqual(runsToText(only(doc, 'paragraph').runs), 'First line\nSecond line');
    });

    test('marks block quotes', () => {
      const doc = mdToDocBlocks(md('> Approved by the change board', '> on 2026-02-01.'));
      const para = only(doc, 'paragraph');
      assert.strictEqual(para.quote, true);
      assert.strictEqual(runsToText(para.runs), 'Approved by the change board on 2026-02-01.');
    });

    test('separates paragraphs on a blank line', () => {
      const doc = mdToDocBlocks(md('First.', '', 'Second.'));
      assert.deepStrictEqual(kinds(doc), ['paragraph', 'paragraph']);
    });
  });

  suite('inline formatting', () => {
    test('splits bold, italic and code', () => {
      const runs = parseInline('a **b** *c* `d`');
      assert.deepStrictEqual(runs, [
        { text: 'a ' },
        { text: 'b', bold: true },
        { text: ' ' },
        { text: 'c', italic: true },
        { text: ' ' },
        { text: 'd', code: true },
      ]);
    });

    test('treats *** as bold plus italic', () => {
      assert.deepStrictEqual(parseInline('***both***'), [{ text: 'both', bold: true, italic: true }]);
    });

    test('handles strikethrough', () => {
      assert.deepStrictEqual(parseInline('~~gone~~'), [{ text: 'gone', strike: true }]);
    });

    test('keeps link text and target', () => {
      assert.deepStrictEqual(parseInline('see [the register](assets/media-register.csv)'), [
        { text: 'see ' },
        { text: 'the register', link: 'assets/media-register.csv' },
      ]);
    });

    test('honours a backslash escape', () => {
      assert.deepStrictEqual(parseInline('a \\*literal\\* b'), [{ text: 'a *literal* b' }]);
    });

    test('nests code inside bold without losing the outer formatting', () => {
      const runs = parseInline('**ref `TC-001` here**');
      assert.deepStrictEqual(runs, [
        { text: 'ref ', bold: true },
        { text: 'TC-001', bold: true, code: true },
        { text: ' here', bold: true },
      ]);
    });

    test('leaves a lone asterisk as text', () => {
      assert.deepStrictEqual(parseInline('2 * 3 = 6'), [{ text: '2 * 3 = 6' }]);
    });
  });

  suite('lists', () => {
    test('detects unordered and ordered lists', () => {
      const unordered = mdToDocBlocks(md('- one', '- two'));
      assert.strictEqual(only(unordered, 'list').ordered, false);
      const ordered = mdToDocBlocks(md('1. one', '2. two'));
      assert.strictEqual(only(ordered, 'list').ordered, true);
    });

    test('derives nesting level from indentation', () => {
      const doc = mdToDocBlocks(md('- top', '  - child', '    - grandchild'));
      assert.deepStrictEqual(
        only(doc, 'list').items.map(i => i.level),
        [0, 1, 2]
      );
    });

    test('parses task markers on the tester checklists', () => {
      const doc = mdToDocBlocks(md('- [ ] execute TC-001', '- [x] execute TC-002'));
      const items = only(doc, 'list').items;
      assert.deepStrictEqual(
        items.map(i => i.checked),
        [false, true]
      );
      assert.strictEqual(runsToText(items[1].runs), 'execute TC-002');
    });

    test('keeps a loose list together across blank lines', () => {
      const doc = mdToDocBlocks(md('- one', '', '- two'));
      assert.strictEqual(only(doc, 'list').items.length, 2);
    });

    test('appends an indented continuation line to the previous item', () => {
      const doc = mdToDocBlocks(md('- first item', '  continued here', '- second item'));
      const items = only(doc, 'list').items;
      assert.strictEqual(runsToText(items[0].runs), 'first item continued here');
      assert.strictEqual(items.length, 2);
    });

    test('ends the list at a heading', () => {
      const doc = mdToDocBlocks(md('- one', '## Next'));
      assert.deepStrictEqual(kinds(doc), ['list', 'heading']);
    });
  });

  suite('tables', () => {
    test('parses header, alignment and rows', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', '| Requirement | Status | Owner |', '|:---|---:|:---:|', '| REQ-001 | Approved | BA |'));
      const table = only(doc, 'table');
      assert.deepStrictEqual(table.header, ['Requirement', 'Status', 'Owner']);
      assert.deepStrictEqual(table.align, ['left', 'right', 'center']);
      assert.deepStrictEqual(table.rows, [['REQ-001', 'Approved', 'BA']]);
      assert.deepStrictEqual(doc.warnings, []);
    });

    test('keeps an escaped pipe inside a cell', () => {
      const doc = mdToDocBlocks(md('| Expression | Meaning |', '|---|---|', '| a \\| b | either |'));
      assert.deepStrictEqual(only(doc, 'table').rows, [['a | b', 'either']]);
    });

    test('pads a short row and warns', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', '| A | B | C |', '|---|---|---|', '| 1 | 2 |'));
      assert.deepStrictEqual(only(doc, 'table').rows, [['1', '2', '']]);
      assert.deepStrictEqual(codes(doc), ['table-column-mismatch']);
    });

    test('leaves cell markdown intact for the renderer to expand', () => {
      const doc = mdToDocBlocks(md('| **ID** | Note |', '|---|---|', '| **REQ-001** | `MUST` |'));
      const table = only(doc, 'table');
      assert.deepStrictEqual(table.header, ['**ID**', 'Note']);
      assert.deepStrictEqual(parseInline(table.rows[0][0]), [{ text: 'REQ-001', bold: true }]);
      assert.deepStrictEqual(parseInline(table.rows[0][1]), [{ text: 'MUST', code: true }]);
    });

    test('stops at the first non-table line', () => {
      const doc = mdToDocBlocks(md('| A | B |', '|---|---|', '| 1 | 2 |', '', 'Trailing paragraph.'));
      assert.deepStrictEqual(kinds(doc), ['table', 'paragraph']);
    });
  });

  suite('code fences', () => {
    test('parses a fenced block with its language', () => {
      const doc = mdToDocBlocks(md('```json', '{ "a": 1 }', '```'));
      const code = only(doc, 'code');
      assert.strictEqual(code.lang, 'json');
      assert.strictEqual(code.text, '{ "a": 1 }');
    });

    test('accepts tilde fences', () => {
      const doc = mdToDocBlocks(md('~~~bash', 'npm test', '~~~'));
      assert.deepStrictEqual(kinds(doc), ['code']);
    });

    test('consumes the rest of the file for an unclosed fence and warns', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', '```text', 'line one', 'line two'));
      assert.strictEqual(only(doc, 'code').text, 'line one\nline two');
      assert.deepStrictEqual(codes(doc), ['unclosed-fence']);
    });

    test('turns a mermaid fence into an unsupported block instead of code', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', '```mermaid', 'graph TD', 'A-->B', '```'));
      const unsupported = only(doc, 'unsupported');
      assert.strictEqual(unsupported.reason, 'mermaid');
      assert.strictEqual(unsupported.raw, 'graph TD\nA-->B');
      assert.deepStrictEqual(codes(doc), ['unsupported-mermaid']);
    });
  });

  suite('images and page breaks', () => {
    test('parses a standalone image reference', () => {
      const doc = mdToDocBlocks(md('![Login screen](assets/img/FIG-001-login.png)'));
      assert.deepStrictEqual(only(doc, 'image'), {
        kind: 'image',
        ref: 'assets/img/FIG-001-login.png',
        alt: 'Login screen',
      });
    });

    test('parses an explicit width hint', () => {
      const doc = mdToDocBlocks(md('![Diagram](diagrams/DIA-001.png){width=320px}'));
      assert.strictEqual(only(doc, 'image').widthPx, 320);
    });

    test('warns about an image embedded in a paragraph', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', 'See ![shot](assets/evidence/EVD-001.png) for the failure.'));
      assert.deepStrictEqual(kinds(doc), ['paragraph']);
      assert.deepStrictEqual(codes(doc), ['inline-image']);
    });

    test('recognises every page-break spelling', () => {
      for (const marker of [
        '<div class="pagebreak"></div>',
        "<!-- pagebreak -->",
        '\\pagebreak',
        '\\newpage',
        '---pagebreak---',
      ]) {
        const doc = mdToDocBlocks(md('Before.', marker, 'After.'));
        assert.deepStrictEqual(kinds(doc), ['paragraph', 'pagebreak', 'paragraph'], marker);
      }
    });

    test('parses a horizontal rule', () => {
      const doc = mdToDocBlocks(md('***'));
      assert.deepStrictEqual(kinds(doc), ['rule']);
    });
  });

  suite('docx-safety', () => {
    test('flags raw HTML', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', '<div class="note">handled</div>'));
      assert.strictEqual(only(doc, 'unsupported').reason, 'html');
      assert.deepStrictEqual(codes(doc), ['unsupported-html']);
    });

    test('flags a footnote definition', () => {
      const doc = mdToDocBlocks(md('[^1]: the note'));
      assert.strictEqual(only(doc, 'unsupported').reason, 'footnote');
    });

    test('warns about a footnote reference', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', 'Claim supported by evidence[^1].'));
      assert.deepStrictEqual(codes(doc), ['inline-footnote']);
    });

    test('flags a setext underline', () => {
      const doc = mdToDocBlocks(md(...FRONT, '', 'Title', '====='));
      assert.strictEqual(only(doc, 'unsupported').reason, 'setext');
      assert.deepStrictEqual(codes(doc), ['unsupported-setext']);
    });

    test('parses CRLF and LF identically', () => {
      const source = md(...FRONT, '', '## Scope', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '- one', '- two');
      assert.deepStrictEqual(mdToDocBlocks(source.replace(/\n/g, '\r\n')), mdToDocBlocks(source));
    });

    test('tolerates a byte-order mark', () => {
      const doc = mdToDocBlocks('\uFEFF' + md(...FRONT, '# Body'));
      assert.strictEqual(doc.meta.docId, 'DEMO-BA-FRS-001');
    });

    test('a govt-style document stays entirely inside the docx-safe subset', () => {
      const doc = mdToDocBlocks(
        md(
          ...FRONT,
          '',
          '# Functional Requirements Specification',
          '',
          '## 1. Scope',
          '',
          'This document specifies the **case management** functions of the system.',
          '',
          '### 1.1 Actors',
          '',
          '| Actor | Responsibility | Access |',
          '|---|---|---|',
          '| Registry Clerk | Files applications | `RW` |',
          '| Supervisor | Approves applications | `R` |',
          '',
          '## 2. Requirements',
          '',
          '| ID | Requirement | Priority |',
          '|---|---|---|',
          '| FR-001 | The system **shall** record an application. | Must |',
          '| FR-002 | The system shall notify the applicant. | Should |',
          '',
          '- [ ] FR-001 reviewed by the business owner',
          '- [x] FR-002 reviewed by the business owner',
          '',
          '![Case flow](diagrams/DIA-001-case-flow.png)',
          '',
          '<div class="pagebreak"></div>',
          '',
          '```json',
          '{ "status": "Draft" }',
          '```',
          '',
          '> Deviation approved by the change board.',
          ''
        )
      );
      assert.deepStrictEqual(doc.warnings, []);
      assert.deepStrictEqual(kinds(doc), [
        'heading',
        'heading',
        'paragraph',
        'heading',
        'table',
        'heading',
        'table',
        'list',
        'image',
        'pagebreak',
        'code',
        'paragraph',
      ]);
      assert.strictEqual(doc.meta.classification, 'TERHAD');
    });
  });
});

import * as assert from 'assert';
import { mdToDocBlocks } from '../../../shared/docBlocks';
import {
  DOC_PROJECT_SPECS,
  DocFileSpec,
  DocProjectSpec,
  renderDocBody,
  renderFrontMatter,
  selectDocFiles,
} from '../../../shared/documentation/docTemplates';
import { KRISA_ARTEFACTS, krisaArtefactsForRole } from '../../../shared/documentation/krisa';

const ROLE_FOLDERS: Record<string, string[]> = {
  'doc-ba': ['00-project-control', '01-business-analysis', '05-traceability'],
  'doc-writer': ['00-project-control', '01-design', '02-user-docs'],
  'doc-tester': ['00-project-control', '01-test-planning', '02-test-cases'],
};

function frontMatterFor(
  file: DocFileSpec,
  spec: DocProjectSpec,
  lang: 'en' | 'ms' | 'bilingual',
  titleOverride?: string
) {
  return renderFrontMatter(
    {
      docId: `DOCPROJ-${spec.roleCode}-${file.docType}-001`,
      title: titleOverride ?? (lang === 'ms' ? file.titleBm : file.titleEn),
      version: '0.1.0',
      status: 'Draft',
      owner: spec.templateName,
      approver: 'TBC',
      classification: 'INTERNAL',
      lang,
      project: 'DOCPROJ',
      date: '2026-01-05',
    },
    lang
  );
}

suite('documentation templates — registry', () => {
  test('three role templates are registered', () => {
    assert.deepStrictEqual(Object.keys(DOC_PROJECT_SPECS).sort(), [
      'doc-ba',
      'doc-tester',
      'doc-writer',
    ]);
  });

  test('each template keeps its role identity', () => {
    assert.strictEqual(DOC_PROJECT_SPECS['doc-ba'].role, 'BA');
    assert.strictEqual(DOC_PROJECT_SPECS['doc-writer'].role, 'Writer');
    assert.strictEqual(DOC_PROJECT_SPECS['doc-tester'].role, 'Tester');
  });

  test('document ids are unique inside a project', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      const paths = spec.docSet.map((f) => f.path);
      assert.strictEqual(new Set(paths).size, paths.length, `duplicate path in ${spec.templateId}`);
      const types = new Set<string>();
      for (const file of spec.docSet) {
        // Doc ids are <PROJ>-<ROLE>-<TYPE>-001, so the type must be unique per role.
        assert.ok(!types.has(file.docType), `duplicate docType ${file.docType} in ${spec.templateId}`);
        types.add(file.docType);
      }
    }
  });

  test('every file path is relative, forward-slashed and inside a role folder', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      for (const file of spec.docSet) {
        assert.ok(!file.path.startsWith('/'), file.path);
        assert.ok(!file.path.includes('..'), file.path);
        assert.ok(!file.path.includes('\\'), file.path);
        assert.ok(file.path.endsWith('.md'), file.path);
        assert.ok(file.path.includes('/'), file.path);
      }
    }
  });

  test('each role owns its expected folders by default', () => {
    for (const [templateId, folders] of Object.entries(ROLE_FOLDERS)) {
      const files = selectDocFiles(DOC_PROJECT_SPECS[templateId], {});
      for (const folder of folders) {
        assert.ok(
          files.some((f) => f.path.startsWith(`${folder}/`)),
          `${templateId} missing ${folder}`
        );
      }
    }
  });
});

suite('documentation templates — options', () => {
  test('KRiSA-only documents are absent under standard governance', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      const files = selectDocFiles(spec, { governance: 'Standard' });
      assert.ok(
        !files.some((f) => f.path.includes('krisa-compliance-matrix')),
        'compliance matrix leaked into a standard project'
      );
    }
  });

  test('KRiSA governance adds the compliance matrix to every role', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      const files = selectDocFiles(spec, { governance: 'KRiSA (Government)' });
      assert.ok(
        files.some((f) => f.path === '00-project-control/krisa-compliance-matrix.md'),
        `${spec.templateId} has no compliance matrix`
      );
    }
  });

  test('KRiSA adds role-specific artefacts', () => {
    const writer = selectDocFiles(DOC_PROJECT_SPECS['doc-writer'], {
      governance: 'KRiSA (Government)',
    }).map((f) => f.path);
    assert.ok(writer.includes('01-design/configuration-management.md'));

    const tester = selectDocFiles(DOC_PROJECT_SPECS['doc-tester'], {
      governance: 'KRiSA (Government)',
    }).map((f) => f.path);
    assert.ok(tester.includes('06-evidence/test-summary-report.md'));
  });

  test('role toggles remove their folder content', () => {
    const ba = selectDocFiles(DOC_PROJECT_SPECS['doc-ba'], { includeProcess: false });
    assert.ok(!ba.some((f) => f.path.startsWith('01-process/')));

    const baNoNfr = selectDocFiles(DOC_PROJECT_SPECS['doc-ba'], { includeNfr: false });
    assert.ok(!baNoNfr.some((f) => f.path.startsWith('02-requirements/')));

    const writer = selectDocFiles(DOC_PROJECT_SPECS['doc-writer'], {
      includeRunbooks: false,
      includeApiDocs: false,
    });
    assert.ok(!writer.some((f) => f.path.startsWith('03-operations/')));
    assert.ok(!writer.some((f) => f.path.startsWith('04-api/')));

    const tester = selectDocFiles(DOC_PROJECT_SPECS['doc-tester'], {
      includeTestCases: false,
      includeUat: false,
    });
    assert.ok(!tester.some((f) => f.path.startsWith('02-test-cases/')));
    assert.ok(!tester.some((f) => f.path.startsWith('03-uat/')));
  });

  test('document control Minimal removes the control documents', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      const files = selectDocFiles(spec, { docControl: 'Minimal' });
      assert.ok(!files.some((f) => f.path.startsWith('06-change-control/')));
      assert.ok(!files.some((f) => f.path === '00-project-control/document-control.md'));
    }
  });

  test('security report follows its toggle or KRiSA governance', () => {
    const off = selectDocFiles(DOC_PROJECT_SPECS['doc-tester'], { includeSecurity: false });
    assert.ok(!off.some((f) => f.path.includes('security-test-report')));

    const onToggle = selectDocFiles(DOC_PROJECT_SPECS['doc-tester'], { includeSecurity: true });
    assert.ok(onToggle.some((f) => f.path.includes('security-test-report')));

    const krisa = selectDocFiles(DOC_PROJECT_SPECS['doc-tester'], {
      governance: 'KRiSA (Government)',
      includeSecurity: false,
    });
    assert.ok(krisa.some((f) => f.path.includes('security-test-report')));
  });
});

suite('documentation templates — generated markdown', () => {
  test('every generated document parses with zero warnings (English)', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      for (const options of [{}, { governance: 'KRiSA (Government)' }]) {
        for (const file of selectDocFiles(spec, options)) {
          const markdown = `${frontMatterFor(file, spec, 'en')}\n\n${renderDocBody(file, file.titleEn)}\n`;
          const { meta, blocks, warnings } = mdToDocBlocks(markdown);
          assert.deepStrictEqual(
            warnings,
            [],
            `${spec.templateId}/${file.path}: ${warnings.map((w) => `${w.code}@${w.line} ${w.message}`).join(' | ')}`
          );
          assert.strictEqual(meta.docId, `DOCPROJ-${spec.roleCode}-${file.docType}-001`);
          assert.strictEqual(meta.title, file.titleEn);
          assert.strictEqual(meta.version, '0.1.0');
          assert.ok(blocks.length >= 3, `${file.path} generated a trivial document`);
          assert.strictEqual(blocks[0].kind, 'heading');
        }
      }
    }
  });

  test('Bahasa Malaysia documents use BM front-matter keys and still parse', () => {
    const spec = DOC_PROJECT_SPECS['doc-ba'];
    const file = spec.docSet[0];
    const markdown = `${frontMatterFor(file, spec, 'ms')}\n\n${renderDocBody(file, file.titleBm)}\n`;
    assert.ok(markdown.includes('id-dokumen:'));
    assert.ok(markdown.includes('tajuk:'));
    assert.ok(markdown.includes('pemilik-dokumen:'));
    const { meta, warnings } = mdToDocBlocks(markdown);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(meta.title, file.titleBm);
    assert.strictEqual(meta.lang, 'ms');
  });

  test('bilingual documents keep English keys and record the bilingual marker', () => {
    const spec = DOC_PROJECT_SPECS['doc-writer'];
    const file = spec.docSet[0];
    const title = `${file.titleEn} / ${file.titleBm}`;
    const markdown = `${frontMatterFor(file, spec, 'bilingual', title)}\n\n${renderDocBody(file, title)}\n`;
    assert.ok(markdown.includes('doc-id:'));
    const { meta, warnings } = mdToDocBlocks(markdown);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(meta.lang, 'bilingual');
    assert.strictEqual(meta.title, title);
    assert.ok(meta.title.includes(' / '));
  });

  test('every table in generated documents has a header row', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      for (const file of selectDocFiles(spec, {})) {
        const markdown = `${frontMatterFor(file, spec, 'en')}\n\n${renderDocBody(file, file.titleEn)}\n`;
        const { blocks } = mdToDocBlocks(markdown);
        for (const block of blocks) {
          if (block.kind === 'table') {
            assert.ok(block.header.length > 0, `${file.path} table without header`);
            for (const row of block.rows) {
              assert.strictEqual(
                row.length,
                block.header.length,
                `${file.path}: row has ${row.length} cells, header ${block.header.length}`
              );
            }
          }
        }
      }
    }
  });

  test('template bodies avoid constructs the DOCX path cannot render', () => {
    for (const spec of Object.values(DOC_PROJECT_SPECS)) {
      for (const file of selectDocFiles(spec, { governance: 'KRiSA (Government)' })) {
        const body = renderDocBody(file, file.titleEn);
        assert.ok(!body.includes('```mermaid'), `${file.path} uses a mermaid fence`);
        assert.ok(!body.includes('<!--'), `${file.path} uses an HTML comment`);
        assert.ok(!/^\s*\[[^\]]+\]:/m.test(body), `${file.path} uses a footnote/link reference`);
      }
    }
  });
});

suite('documentation templates — KRiSA catalogue', () => {
  test('the catalogue covers all three roles', () => {
    for (const role of ['BA', 'Writer', 'Tester'] as const) {
      assert.ok(krisaArtefactsForRole(role).length >= 5, `${role} has too few artefacts`);
    }
  });

  test('artefact ids are unique and prefixed per role', () => {
    const ids = KRISA_ARTEFACTS.map((a) => a.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const artefact of KRISA_ARTEFACTS) {
      const prefix = artefact.owner === 'BA' ? 'K-BA' : artefact.owner === 'Writer' ? 'K-WR' : 'K-TS';
      assert.ok(artefact.id.startsWith(`${prefix}-`), `${artefact.id} has the wrong role prefix`);
    }
  });

  test('every role row is a single role (no shared ownership)', () => {
    for (const artefact of KRISA_ARTEFACTS) {
      const owners = krisaArtefactsForRole(artefact.owner).filter((a) => a.id === artefact.id);
      assert.strictEqual(owners.length, 1);
    }
  });

  test('every artefact has a Bahasa Malaysia title', () => {
    for (const artefact of KRISA_ARTEFACTS) {
      assert.ok(artefact.titleBm.length > 3, `${artefact.id} has no BM title`);
      assert.notStrictEqual(artefact.titleBm, artefact.titleEn);
    }
  });

  test('no artefact is silently claimed as compliant', () => {
    for (const artefact of KRISA_ARTEFACTS) {
      assert.match(artefact.guidelineRef, /TODO/, `${artefact.id} must not claim a confirmed clause`);
    }
  });
});

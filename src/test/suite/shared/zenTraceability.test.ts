import * as assert from 'assert';
import {
  DOC_PROJECT_SPECS,
  DocFileSpec,
  renderDocBody,
} from '../../../shared/documentation/docTemplates';
import {
  ADR_DIR,
  ADR_ID_PREFIX,
  ADR_LOG_DOC_TYPE,
  ADR_SEEDED_DOC_TYPE,
  ADR_TEMPLATE_DOC_TYPE,
  ADR_TEMPLATE_PATH,
  ZEN_MATRIX_DOC_TYPE,
  adrId,
  adrPath,
  ciComplianceRows,
  citableClauseIds,
  clauseStatus,
  complianceDeviations,
  missingEvidenceIds,
  runtimeComplianceRows,
} from '../../../shared/documentation/zenTraceability';
import {
  CLAUSE_IDS,
  ciClauses,
  runtimeClauses,
} from '../../../shared/standardsArtifacts';

function writerSet(): DocFileSpec[] {
  return DOC_PROJECT_SPECS['doc-writer'].docSet;
}

function specByType(docType: string): DocFileSpec {
  const found = writerSet().filter((f) => f.docType === docType);
  assert.strictEqual(found.length, 1, `expected exactly one ${docType} spec`);
  return found[0];
}

function render(file: DocFileSpec): string {
  return renderDocBody(file, file.titleEn);
}

suite('zenTraceability — clause catalogue', () => {
  test('every catalogue clause has a named evidence artefact', () => {
    assert.deepStrictEqual(
      missingEvidenceIds(),
      [],
      'a clause without evidence renders a row that proves nothing',
    );
  });

  test('clause ids are unique and follow the ZEN-STD-* shape', () => {
    const ids = [...runtimeClauses('node'), ...ciClauses()].map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate clause id in the catalogue');
    for (const id of ids) {
      assert.match(id, /^ZEN-STD-(REPO|CON|CI)-\d{2}$/, `${id} is not a citable clause id`);
    }
    assert.ok(ids.includes(CLAUSE_IDS.resilience));
  });

  test('the evidence table covers the same ids the matrix prints', () => {
    const cited = [...runtimeComplianceRows('node'), ...ciComplianceRows()].map((r) => r[0]);
    for (const id of citableClauseIds()) {
      assert.ok(cited.includes(id), `${id} is citable but has no matrix row`);
    }
  });
});

suite('zenTraceability — status is honest per stack', () => {
  test('the node stack meets the clauses it actually ships', () => {
    assert.strictEqual(clauseStatus(CLAUSE_IDS.container, 'node'), 'Met');
    assert.strictEqual(clauseStatus(CLAUSE_IDS.contract, 'node'), 'Met');
    assert.strictEqual(clauseStatus(CLAUSE_IDS.lifecycle, 'node'), 'Met');
    assert.strictEqual(clauseStatus(CLAUSE_IDS.resilience, 'node'), 'Met');
  });

  test('a clause that ships in part is never reported as met', () => {
    assert.strictEqual(clauseStatus(CLAUSE_IDS.observability, 'node'), 'Partial');
    assert.strictEqual(clauseStatus(CLAUSE_IDS.security, 'node'), 'Partial');
  });

  test('stacks without the shared kit report the resilience clause as not scaffolded', () => {
    for (const family of ['python', 'dotnet', 'php'] as const) {
      assert.strictEqual(
        clauseStatus(CLAUSE_IDS.resilience, family),
        'Not scaffolded',
        `${family} has no packages/shared but claims CON-06`,
      );
    }
  });

  test('runtime rows carry five non-empty columns', () => {
    const rows = runtimeComplianceRows('node');
    assert.strictEqual(rows.length, runtimeClauses('node').length);
    for (const row of rows) {
      assert.strictEqual(row.length, 5, `${row[0]} must be CLAUSE/RULE/WHERE/STATUS/EVIDENCE`);
      for (const cell of row) {
        assert.ok(cell && cell.trim().length > 0, `${row[0]} has an empty cell`);
      }
    }
  });

  test('all seven delivery gates are reported met', () => {
    const rows = ciComplianceRows();
    assert.strictEqual(rows.length, 7);
    for (const row of rows) {
      assert.strictEqual(row[3], 'Met', `${row[0]} should be satisfied by the emitted workflow`);
    }
  });

  test('deviations are exactly the clauses that need an ADR', () => {
    const ids = complianceDeviations('node').map((c) => c.id);
    assert.deepStrictEqual(ids.sort(), [CLAUSE_IDS.observability, CLAUSE_IDS.security].sort());
    assert.ok(!ids.includes(CLAUSE_IDS.resilience), 'CON-06 ships for node');
    assert.ok(
      complianceDeviations('python').map((c) => c.id).includes(CLAUSE_IDS.resilience),
      'CON-06 must be a deviation outside the node stack',
    );
  });
});

suite('zenTraceability — ADR documents', () => {
  test('ids are zero padded and the path lives under the ADR folder', () => {
    assert.strictEqual(adrId(1), `${ADR_ID_PREFIX}001`);
    assert.strictEqual(adrId(42), `${ADR_ID_PREFIX}042`);
    assert.strictEqual(adrPath(1, 'monorepo'), `${ADR_DIR}/${ADR_ID_PREFIX}001-monorepo.md`);
  });

  test('the blank template does not squat on a decision number', () => {
    assert.strictEqual(ADR_TEMPLATE_PATH, `${ADR_DIR}/template.md`);
    assert.doesNotMatch(
      ADR_TEMPLATE_PATH,
      /ADR-\d{3}/,
      'a numbered template collides with the next real ADR',
    );
  });

  test('the writer set emits the log, the template, a seeded record and the matrix', () => {
    const paths = writerSet().map((f) => f.path);
    for (const p of [ADR_TEMPLATE_PATH, adrPath(1, 'monorepo-as-default')]) {
      assert.ok(paths.includes(p), `${p} is not emitted`);
    }
    assert.ok(paths.includes(`${ADR_DIR}/README.md`));
    assert.ok(paths.includes('05-traceability/zen-standards-compliance.md'));
  });

  test('document types are unique — the docId is <PROJECT>-<ROLE>-<TYPE>-001', () => {
    const types = writerSet().map((f) => f.docType);
    assert.strictEqual(
      new Set(types).size,
      types.length,
      'two files share a docType and would collide on docId',
    );
    for (const t of [ADR_LOG_DOC_TYPE, ADR_TEMPLATE_DOC_TYPE, ADR_SEEDED_DOC_TYPE, ZEN_MATRIX_DOC_TYPE]) {
      assert.ok(types.includes(t), `${t} missing from the writer set`);
    }
  });

  test('ADR documents are gated on the design option', () => {
    const log = writerSet().find((f) => f.docType === ADR_LOG_DOC_TYPE);
    assert.ok(log);
    const when = log.when as unknown as (o: Record<string, unknown>) => boolean;
    assert.strictEqual(when({ includeDesign: false }), false);
    assert.strictEqual(when({ includeDesign: true }), true);
    assert.strictEqual(when({}), true, 'design documents are on by default');
  });

  test('the seeded record decides the monorepo question it is named after', () => {
    const body = render(specByType(ADR_SEEDED_DOC_TYPE));
    assert.ok(body.includes(CLAUSE_IDS.repo), 'the seeded ADR must cite the repository clause');
    assert.match(body, /monorepo/i);
    assert.match(body, /Amends/, 'the handbook layout is amended, not silently ignored');
    assert.match(body, /Accepted/);
  });

  test('the template separates context, decision and consequences', () => {
    const body = render(specByType(ADR_TEMPLATE_DOC_TYPE));
    for (const heading of ['## Status', '## Context', '## Decision', '## Consequences', '## Clause mapping']) {
      assert.ok(body.includes(heading), `${heading} missing from the ADR template`);
    }
    assert.match(body, /Alternatives considered/);
  });
});

suite('zenTraceability — the rendered matrix', () => {
  test('it cites every clause id and nothing outside the catalogue', () => {
    const body = render(specByType(ZEN_MATRIX_DOC_TYPE));
    const cited: string[] = body.match(/ZEN-STD-[A-Z]+-\d{2}/g) ?? [];
    assert.ok(cited.length > 0);
    const known = new Set(citableClauseIds());
    for (const id of cited) {
      assert.ok(known.has(id), `${id} is cited but not in the clause catalogue`);
    }
    for (const id of citableClauseIds()) {
      assert.ok(cited.includes(id), `${id} is missing from the matrix`);
    }
  });

  test('it separates runtime clauses from delivery clauses', () => {
    const body = render(specByType(ZEN_MATRIX_DOC_TYPE));
    assert.match(body, /section 4\.2|4\.2/);
    assert.match(body, /4\.3/);
    assert.ok(body.includes(CLAUSE_IDS.ciStatic), 'the static-analysis gate is missing');
  });

  test('it names the deviations instead of hiding them', () => {
    const body = render(specByType(ZEN_MATRIX_DOC_TYPE));
    assert.ok(body.includes(CLAUSE_IDS.security), 'CON-05 is a deviation and must be listed');
    assert.ok(body.includes(CLAUSE_IDS.observability));
    assert.match(body, /ADR/, 'a deviation must point at the record that accepts it');
  });

  test('it points security evidence at the tester project report', () => {
    const body = render(specByType(ZEN_MATRIX_DOC_TYPE));
    assert.match(body, /security-test-report\.md/);
    assert.match(body, /EVD-STR/);
  });
});

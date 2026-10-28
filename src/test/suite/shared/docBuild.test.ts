import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DOC_TEMPLATE_IDS,
  buildDocumentationProject,
  describeDocTemplates,
} from '../../../shared/documentation/docBuild';
import { DOC_PROJECT_SPECS, selectDocFiles } from '../../../shared/documentation/docTemplates';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docbuild-'));
}

function removeRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Every file under `dir`, relative and posix-styled. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

suite('docBuild · template catalogue', () => {
  test('lists every template with a file count', () => {
    const catalog = describeDocTemplates();
    assert.ok(!('error' in catalog));
    if ('error' in catalog) {
      return;
    }
    assert.deepStrictEqual(
      catalog.templates.map(t => t.templateId),
      [...DOC_TEMPLATE_IDS]
    );
    for (const template of catalog.templates) {
      const spec = DOC_PROJECT_SPECS[template.templateId];
      assert.strictEqual(template.templateName, spec.templateName);
      assert.strictEqual(template.documentCount, selectDocFiles(spec, {}).length);
      // Files are the expensive part of the payload — only on request.
      assert.strictEqual(template.documents, undefined);
    }
    assert.ok(catalog.optionKeys.includes('governance'));
    assert.ok(catalog.optionKeys.includes('docLanguage'));
  });

  test('a templateId adds that template\'s file list', () => {
    const catalog = describeDocTemplates('doc-ba');
    assert.ok(!('error' in catalog));
    if ('error' in catalog) {
      return;
    }
    assert.strictEqual(catalog.templates.length, 1);
    const [template] = catalog.templates;
    assert.strictEqual(template.templateId, 'doc-ba');
    assert.ok(template.documents && template.documents.length > 0);
    const doc = template.documents![0];
    assert.ok(doc.path.length > 0);
    assert.ok(doc.docType.length > 0);
    assert.ok(doc.title.length > 0);
  });

  test('an unknown templateId is an error, not an empty list', () => {
    const catalog = describeDocTemplates('doc-nope');
    assert.ok('error' in catalog);
    if ('error' in catalog) {
      assert.ok(catalog.error.includes('doc-nope'));
      for (const id of DOC_TEMPLATE_IDS) {
        assert.ok(catalog.error.includes(id));
      }
    }
  });
});

suite('docBuild · buildDocumentationProject', () => {
  let root: string;

  setup(() => {
    root = makeRoot();
  });

  teardown(() => {
    removeRoot(root);
  });

  test('builds the document set into a subfolder of the project root', () => {
    const result = buildDocumentationProject({
      workspaceRoot: root,
      templateId: 'doc-ba',
      projectName: 'Acme Intranet',
      version: '1.2.0',
      description: 'Intranet refresh',
    });

    assert.ok(!('error' in result), 'error' in result ? result.error : '');
    if ('error' in result) {
      return;
    }
    // Default directory is the project name.
    assert.strictEqual(result.directory, 'Acme Intranet');
    assert.ok(result.created.length > 0);
    // Paths are workspace-relative and posix-styled; README.md is the root index.
    assert.ok(result.created.includes('README.md'), result.created.join(', '));
    assert.ok(result.created.some(p => p.includes('/')));
    assert.ok(fs.existsSync(path.join(root, 'Acme Intranet')), 'project folder created');

    // Same layout the New Project wizard produces: markdown sources, registers
    // as .md AND .csv, and project-control bookkeeping.
    const written = walk(path.join(root, 'Acme Intranet'));
    assert.ok(written.includes('00-project-control/document-control.md'), written.join(', '));
    assert.ok(written.some(f => f.endsWith('.csv')), 'registers are also written as CSV');
    assert.ok(written.some(f => f.endsWith('.md')), written.join(', '));
    assert.ok(fs.existsSync(path.join(root, 'Acme Intranet', '.ado-code', 'documentation.json')));
    assert.ok(result.warnings.every(w => typeof w === 'string'));
  });

  test('honours an explicit directory and template options', () => {
    const result = buildDocumentationProject({
      workspaceRoot: root,
      templateId: 'doc-tester',
      projectName: 'Payments UAT',
      directory: 'docs/uat',
      options: { docLanguage: 'Bahasa Malaysia' },
    });

    assert.ok(!('error' in result), 'error' in result ? result.error : '');
    if ('error' in result) {
      return;
    }
    assert.strictEqual(result.directory, 'docs/uat');
    assert.ok(fs.existsSync(path.join(root, 'docs', 'uat')));
  });

  test('refuses an unknown template', () => {
    const result = buildDocumentationProject({
      workspaceRoot: root,
      templateId: 'doc-nope',
      projectName: 'Whatever',
    });
    assert.ok('error' in result);
    if ('error' in result) {
      assert.ok(result.error.includes('doc-nope'));
    }
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });

  test('refuses an empty project name', () => {
    const result = buildDocumentationProject({
      workspaceRoot: root,
      templateId: 'doc-ba',
      projectName: '   ',
    });
    assert.ok('error' in result);
    if ('error' in result) {
      assert.ok(result.error.includes('projectName'));
    }
  });

  test('confines the target folder to the project root', () => {
    for (const directory of ['../escape', '..\\escape', root, 'C:\\windows\\temp']) {
      const result = buildDocumentationProject({
        workspaceRoot: root,
        templateId: 'doc-ba',
        projectName: 'Proj',
        directory,
        overwrite: true,
      });
      assert.ok('error' in result, `expected refusal for ${directory}`);
      if ('error' in result) {
        assert.ok(result.error.includes('outside the project root') || result.error.includes('relative'), result.error);
      }
    }
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });

  test('refuses a non-empty target folder unless overwrite is set', () => {
    const target = path.join(root, 'business-analysis');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'existing.md'), '# keep me\n');

    const refused = buildDocumentationProject({
      workspaceRoot: root,
      templateId: 'doc-ba',
      projectName: 'Proj',
      directory: 'business-analysis',
    });
    assert.ok('error' in refused);
    if ('error' in refused) {
      assert.ok(refused.error.includes('overwrite'));
    }
    // Nothing was written over the existing file.
    assert.deepStrictEqual(fs.readdirSync(target), ['existing.md']);

    const allowed = buildDocumentationProject({
      workspaceRoot: root,
      templateId: 'doc-ba',
      projectName: 'Proj',
      directory: 'business-analysis',
      overwrite: true,
    });
    assert.ok(!('error' in allowed), 'error' in allowed ? allowed.error : '');
    if (!('error' in allowed)) {
      assert.ok(allowed.created.length > 0);
      // The pre-existing file survives: the scaffolder adds, it does not wipe.
      assert.ok(fs.existsSync(path.join(target, 'existing.md')));
    }
  });
});

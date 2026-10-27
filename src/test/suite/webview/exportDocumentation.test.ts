import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  collectDocumentationExport,
  mermaidFences,
  resolveDocumentPath,
  ExportDeps,
} from '../../../webview/documentation/exportDocumentation';
import { mdToDocBlocks } from '../../../shared/docBlocks';

const readFile: ExportDeps['readFile'] = (uri) => fs.promises.readFile(uri.fsPath);
const deps: ExportDeps = { readFile };

const FRONT_MATTER = [
  '---',
  'doc-id: TEST-WR-DOC-001',
  'title: System Overview',
  'version: 0.1.0',
  'status: Draft',
  'owner: Documentation Writer',
  'classification: TERHAD',
  'lang: en',
  '---',
  '',
].join('\n');

const BODY = [
  '# System Overview',
  '',
  'Manuals carry screenshots:',
  '',
  '![Login screen](../assets/img/shot.png)',
  '',
  'And workflows:',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  'End of document.',
  '',
].join('\n');

// Derived from the concatenated text rather than assumed: the front matter
// block ends with a newline, so BODY's first line continues the same file.
const MERMAID_LINE =
  (FRONT_MATTER + BODY).split('\n').findIndex((l) => l.trim() === '```mermaid') + 1;

let root: string;
let projectPath: string;

function write(relativePath: string, content: string | Buffer): void {
  const full = path.join(projectPath, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

suiteSetup(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-docexport-'));
  projectPath = path.join(root, 'proj');

  write(
    '.ado-code/documentation.json',
    JSON.stringify(
      {
        kind: 'documentation',
        role: 'BA',
        projectName: 'Test Proj',
        framework: 'Standard',
        language: 'en',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
  write(
    '05-traceability/rtm.csv',
    'REQ-ID,TITLE,SOURCE,ADO-WORK-ITEM,DESIGN-REF,TEST-CASE,UAT-STATUS,STATUS\r\nREQ-001,Login,BRD-001,1001,SRS-2.1,TC-001,Pass,Approved\r\n',
  );
  write(
    '00-project-control/document-register.csv',
    'DOC-ID,TITLE,OWNER,ROLE,VERSION,STATUS,APPROVER,LINKED-REQ,FILE,CLASSIFICATION\r\nTEST-BA-BRS-001,BRS,BA,BA,0.1.0,Draft,,REQ-001,01-business-analysis/brs.md,INTERNAL\r\n',
  );

  write('04-user-docs/user-manual.md', FRONT_MATTER + BODY);

  // A real 256x256 PNG, copied from the extension's own icon.
  const iconPath = path.join(__dirname, '../../../../resources/icon.png');
  write('assets/img/shot.png', fs.readFileSync(iconPath));

  // Sits outside the project folder — must never be readable through an export.
  fs.writeFileSync(path.join(root, 'outside.md'), FRONT_MATTER + '# Outside\n');
});

suiteTeardown(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows sometimes keeps a handle; the temp dir is disposable. */
  }
});

suite('documentation export — document path resolution', () => {
  test('a project-relative path resolves inside the project', () => {
    const resolved = resolveDocumentPath(projectPath, '04-user-docs/user-manual.md');
    assert.ok(resolved);
    assert.strictEqual(resolved!.relativePath, '04-user-docs/user-manual.md');
    assert.ok(path.isAbsolute(resolved!.absolutePath));
  });

  test('an absolute path inside the project is accepted', () => {
    const absolute = path.join(projectPath, '04-user-docs/user-manual.md');
    const resolved = resolveDocumentPath(projectPath, absolute);
    assert.ok(resolved);
    assert.strictEqual(resolved!.relativePath, '04-user-docs/user-manual.md');
  });

  test('traversal and absolute paths outside the project are refused', () => {
    assert.strictEqual(resolveDocumentPath(projectPath, '../../outside.md'), null);
    assert.strictEqual(resolveDocumentPath(projectPath, '../outside.md'), null);
    assert.strictEqual(resolveDocumentPath(projectPath, path.join(root, 'outside.md')), null);
  });

  test('the project folder itself is not a document', () => {
    assert.strictEqual(resolveDocumentPath(projectPath, '.'), null);
    assert.strictEqual(resolveDocumentPath(projectPath, ''), null);
  });
});

suite('documentation export — mermaid fence extraction', () => {
  test('a fence is reported with its line, index and stripped source', () => {
    const parsed = mdToDocBlocks(FRONT_MATTER + BODY);
    const fences = mermaidFences(parsed.blocks);

    assert.strictEqual(fences.length, 1);
    assert.strictEqual(fences[0].line, MERMAID_LINE);
    assert.strictEqual(fences[0].index, 0);
    assert.strictEqual(fences[0].code, 'graph TD; A-->B;');
  });

  test('a document without diagrams reports none', () => {
    const parsed = mdToDocBlocks(FRONT_MATTER + '# Just text\n');
    assert.deepStrictEqual(mermaidFences(parsed.blocks), []);
  });
});

suite('documentation export — host payloads', () => {
  test('docx payload carries the Markdown, the image bytes and a file name', async () => {
    const payload = await collectDocumentationExport(
      { projectPath, format: 'docx', documentPath: '04-user-docs/user-manual.md' },
      deps,
    );

    assert.strictEqual(payload.ok, true, payload.ok ? '' : payload.error);
    if (!payload.ok || payload.format !== 'docx') return;

    assert.strictEqual(payload.relativePath, '04-user-docs/user-manual.md');
    assert.strictEqual(payload.suggestedFileName, 'user-manual.docx');
    assert.strictEqual(payload.defaultDir, 'export/out');
    assert.match(payload.markdown, /System Overview/);

    assert.strictEqual(payload.images.length, 1);
    const image = payload.images[0];
    assert.deepStrictEqual(image.refs, ['../assets/img/shot.png']);
    assert.strictEqual(image.mime, 'image/png');
    assert.strictEqual(image.originalWidth, 256);
    assert.strictEqual(image.originalHeight, 256);
    // never upscaled past the source size
    assert.strictEqual(image.width, 256);
    assert.ok(image.base64.length > 100);
    // the renderer decodes this straight into an ImageRun
    assert.strictEqual(
      Buffer.from(image.base64, 'base64').subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
    );

    // The mermaid fence is reported, not silently dropped.
    assert.ok(payload.warnings.some((w) => /mermaid/i.test(w)), payload.warnings.join(' | '));
  });

  test('a missing image is a warning, not a failed export', async () => {
    write('04-user-docs/broken.md', FRONT_MATTER + '![Gone](../assets/img/gone.png)\n');
    const payload = await collectDocumentationExport(
      { projectPath, format: 'docx', documentPath: '04-user-docs/broken.md' },
      deps,
    );

    assert.strictEqual(payload.ok, true);
    if (!payload.ok || payload.format !== 'docx') return;
    assert.strictEqual(payload.images.length, 0);
    assert.ok(payload.warnings.some((w) => /gone\.png/i.test(w)), payload.warnings.join(' | '));
  });

  test('a document outside the project is refused before any read', async () => {
    const payload = await collectDocumentationExport(
      { projectPath, format: 'docx', documentPath: '../outside.md' },
      deps,
    );
    assert.strictEqual(payload.ok, false);
    if (payload.ok) return;
    assert.strictEqual(payload.format, 'docx');
    assert.match(payload.error, /outside the project/i);
  });

  test('a missing document reports the path it could not read', async () => {
    const payload = await collectDocumentationExport(
      { projectPath, format: 'docx', documentPath: '04-user-docs/nope.md' },
      deps,
    );
    assert.strictEqual(payload.ok, false);
    if (payload.ok) return;
    assert.match(payload.error, /nope\.md/);
  });

  test('diagram payload carries the fence source and a PNG name', async () => {
    const payload = await collectDocumentationExport(
      {
        projectPath,
        format: 'diagram-png',
        documentPath: '04-user-docs/user-manual.md',
        diagramLine: MERMAID_LINE,
      },
      deps,
    );

    assert.strictEqual(payload.ok, true, payload.ok ? '' : payload.error);
    if (!payload.ok || payload.format !== 'diagram-png') return;

    assert.strictEqual(payload.code, 'graph TD; A-->B;');
    assert.strictEqual(payload.line, MERMAID_LINE);
    assert.strictEqual(payload.index, 0);
    assert.strictEqual(payload.suggestedFileName, 'user-manual-diagram-1.png');
    // title comes from the front matter, which is what a reader recognises
    assert.strictEqual(payload.title, 'System Overview');
  });

  test('a diagram line that holds no fence is refused by line number', async () => {
    const payload = await collectDocumentationExport(
      {
        projectPath,
        format: 'diagram-png',
        documentPath: '04-user-docs/user-manual.md',
        diagramLine: 3,
      },
      deps,
    );
    assert.strictEqual(payload.ok, false);
    if (payload.ok) return;
    assert.match(payload.error, /line 3/);
  });

  test('a document with no diagram says so instead of exporting nothing', async () => {
    write('04-user-docs/plain.md', FRONT_MATTER + '# Plain\n');
    const payload = await collectDocumentationExport(
      { projectPath, format: 'diagram-png', documentPath: '04-user-docs/plain.md', diagramLine: 9 },
      deps,
    );
    assert.strictEqual(payload.ok, false);
    if (payload.ok) return;
    assert.match(payload.error, /No diagram/);
  });

  test('xlsx payload carries the registers the role owns', async () => {
    const payload = await collectDocumentationExport({ projectPath, format: 'xlsx' }, deps);

    assert.strictEqual(payload.ok, true, payload.ok ? '' : payload.error);
    if (!payload.ok || payload.format !== 'xlsx') return;

    assert.strictEqual(payload.role, 'BA');
    assert.strictEqual(payload.defaultDir, 'export/out');
    assert.match(payload.suggestedFileName, /\.xlsx$/);

    const kinds = payload.sources.map((s) => s.kind);
    assert.ok(kinds.includes('rtm'), `expected an rtm source, got ${kinds.join(',')}`);
    assert.ok(kinds.includes('documents'), `expected a documents source, got ${kinds.join(',')}`);

    const rtm = payload.sources.find((s) => s.kind === 'rtm');
    assert.ok(rtm && typeof rtm.csv === 'string');
    assert.match(rtm!.csv!, /REQ-001/);
  });

  test('an invalid request never reaches the filesystem', async () => {
    const payload = await collectDocumentationExport({ projectPath, format: 'pdf' }, deps);
    assert.strictEqual(payload.ok, false);
    if (payload.ok) return;
    assert.strictEqual(payload.format, null);
    assert.match(payload.error, /Unsupported export format/);
  });

  test('a payload is JSON-safe for postMessage', async () => {
    const payload = await collectDocumentationExport(
      { projectPath, format: 'docx', documentPath: '04-user-docs/user-manual.md' },
      deps,
    );
    const roundTripped = JSON.parse(JSON.stringify(payload));
    assert.deepStrictEqual(roundTripped, payload);
  });

  test('the extension can resolve a project from a Uri', async () => {
    // Guards the contract the ChatViewProvider arm relies on.
    const uri = vscode.Uri.file(projectPath);
    assert.strictEqual(uri.fsPath, path.resolve(projectPath));
  });
});

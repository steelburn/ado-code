/**
 * Documentation project scaffolding.
 *
 * Deliberately vscode-free (plain `fs`/`path`) so it runs under mocha, exactly
 * like `ProjectCreationService` itself. It lives in `shared/` because TWO
 * callers build documentation projects: the New Project wizard
 * (`ProjectCreationService.scaffoldDocProject`) and the `build_documentation`
 * agent tool (`shared/documentation/docBuild.ts`). One scaffolding path, so the
 * wizard and the agent can never drift.
 *
 * Design rules enforced by this module:
 *  - Markdown is the source of truth; Word/XLSX/PDF are generated artefacts.
 *  - Every generated document carries YAML front matter with the doc id,
 *    version, owner, approver and classification, so the DOCX cover page and
 *    the pandoc metadata can both be derived from one place.
 *  - Registers exist as .md AND .csv from the same column contract, so they
 *    cannot drift.
 *  - KRiSA coercions return warnings rather than silently overruling the user.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DOC_PROJECT_SPECS,
  DocLang,
  DocOptions,
  DocProjectSpec,
  renderDocBody,
  renderFrontMatter,
  selectDocFiles,
} from './docTemplates';
import {
  DOCUMENT_COLUMNS,
  EVIDENCE_COLUMNS,
  MEDIA_COLUMNS,
  RTM_COLUMNS,
  markdownTableHeader,
  toCsv,
  INPUT_COLUMNS,
} from './columns';
import {
  INPUT_RECORDING_PATTERNS,
  INPUT_REGISTER_PATH,
  INPUTS_FOLDER,
  inputFolderSlug,
  inputFolders,
  inputRegisterExampleRow,
  isSourcedDocType,
  renderInputFolderReadme,
  renderInputsReadme,
  exampleInputFolder,
} from './docInputs';
import { KRISA_GUIDELINE_URL, krisaArtefactsForRole } from './krisa';

export interface DocScaffoldRequest {
  templateId: string;
  projectName: string;
  projectDescription: string;
  projectVersion: string;
  templateOptions: Record<string, any>;
  targetPath: string;
}

function docLang(value: unknown): DocLang {
  const text = String(value ?? 'English');
  if (text === 'Bahasa Malaysia') {
    return 'ms';
  }
  if (text === 'English + Bahasa Malaysia') {
    return 'bilingual';
  }
  return 'en';
}

/**
 * The media guide instructs the user to drop figures in `assets/img/`, evidence in
 * `assets/evidence/` and diagram sources in `diagrams/`, so those folders have to
 * exist — otherwise the first instruction in a brand-new project points at
 * nothing. Git cannot track an empty directory, hence the `.gitkeep` placeholder.
 */
function ensureMediaFolders(dir: string, spec: DocProjectSpec, options: DocOptions): void {
  const folders: string[] = [];
  if (options.screenshots !== false) {
    folders.push('assets/img');
  }

  if (spec.role === 'Tester' && options.evidenceCapture !== false) {
    folders.push('assets/evidence');
  }
  if ((options.diagramTool ?? 'mermaid') !== 'none') {
    folders.push('diagrams');
  }
  for (const folder of folders) {
    writeFile(dir, `${folder}/.gitkeep`, `# Placeholder so git tracks ${folder}/ — see assets/README.md\n`);
  }
}

function writeFile(root: string, relative: string, content: string): void {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

/** Resolve KRiSA-coerced options, collecting a warning per overruled choice. */
export function applyKrisaCoercions(
  options: DocOptions,
  spec: DocProjectSpec,
  warnings: string[]
): DocOptions {
  const resolved: DocOptions = { ...options };
  const krisa = (resolved.governance ?? 'Standard') === 'KRiSA (Government)';
  if (!krisa) {
    return resolved;
  }
  if (!resolved.krisaCompliance) {
    resolved.krisaCompliance = true;
    warnings.push(
      'KRiSA governance enables the compliance matrix automatically — every artefact needs a recorded clause reference.'
    );
  }
  const word = resolved.wordExport ?? 'Pandoc scripts';
  if (word === 'None') {
    resolved.wordExport = 'Both (recommended)';
    warnings.push(
      'KRiSA governance requires a document-controlled Word/PDF submission — Word export forced on.'
    );
  }
  if (spec.role === 'Tester') {
    const xlsx = resolved.xlsxExport ?? 'Registers + summary';
    if (xlsx === 'None') {
      resolved.xlsxExport = 'Registers + summary';
      warnings.push(
        'KRiSA governance expects the test evidence register in spreadsheet form — Excel registers forced on.'
      );
    }
    if (!resolved.includeSecurity) {
      resolved.includeSecurity = true;
      warnings.push('KRiSA governance adds the security test report to the test set.');
    }
  }
  return resolved;
}

export function scaffoldDocumentationProject(
  dir: string,
  request: DocScaffoldRequest,
  spec: DocProjectSpec,
  warnings: string[]
): string[] {
  const rawOptions: DocOptions = { ...(request.templateOptions || {}) };
  const options = applyKrisaCoercions(rawOptions, spec, warnings);

  const krisa = (options.governance ?? 'Standard') === 'KRiSA (Government)';
  const lang = docLang(options.docLanguage);
  const version = request.projectVersion || '0.1.0';
  const today = new Date().toISOString().slice(0, 10);
  const classification = krisa ? 'TERHAD' : 'INTERNAL';
  const files = selectDocFiles(spec, options);
  const captureInputs = options.captureInputs !== false;
  const docIds: Record<string, string> = {};
  const documents: string[] = [];

  // ── Documents ────────────────────────────────────────────────────────
  const rows: string[][] = [];
  for (const file of files) {
    const docId = `${request.projectName}-${spec.roleCode}-${file.docType}-001`;
    docIds[file.path] = docId;
    const title =
      lang === 'ms'
        ? file.titleBm
        : lang === 'bilingual'
          ? `${file.titleEn} / ${file.titleBm}`
          : file.titleEn;
    const frontMatter = renderFrontMatter(
      {
        docId,
        title,
        version,
        status: 'Draft',
        owner: spec.templateName,
        approver: 'TBC',
        classification,
        lang,
        project: request.projectName,
        date: today,
      },
      lang
    );
    const body = renderDocBody(file, title, inputFolderFor(file.docType, captureInputs));
    writeFile(dir, file.path, `${frontMatter}\n\n${body}\n`);
    documents.push(file.path);
    rows.push([
      docId,
      title,
      version,
      'Draft',
      spec.templateName,
      'TBC',
      classification,
      deliveryFormat(options),
    ]);
  }

  // ── KRiSA compliance matrix, filled from the catalogue ───────────────
  if (krisa) {
    const artefacts = krisaArtefactsForRole(spec.role);
    const matrixPath = '00-project-control/krisa-compliance-matrix.md';
    const lines: string[] = [];
    lines.push('# KRiSA Compliance Matrix', '');
    lines.push(
      `Artefacts this ${spec.templateName} project is accountable for. The other ` +
        `roles track their own rows in their own projects. Guideline: ${KRISA_GUIDELINE_URL}`,
      ''
    );
    lines.push('## Artefacts', '');
    for (const line of markdownTableHeader([
      'ARTEFACT-ID',
      'ARTEFACT',
      'PHASE',
      'STATUS',
      'SIGN-OFF DATE',
      'EVIDENCE LINK',
      'GUIDELINE REF',
    ])) {
      lines.push(line);
    }
    for (const artefact of artefacts) {
      lines.push(
        `| ${artefact.id} | ${artefact.titleEn} | ${artefact.phase} | Not Started |  | ${artefact.path} | ${artefact.guidelineRef} |`
      );
    }
    lines.push('');
    writeFile(dir, matrixPath, lines.join('\n'));
  }

  // ── Registers ────────────────────────────────────────────────────────
  if (options.traceability !== false && spec.role !== 'Writer') {
    writeFile(
      dir,
      '05-traceability/rtm.csv',
      toCsv(RTM_COLUMNS, [
        [
          'REQ-001',
          'Example requirement — replace',
          'STK-001',
          'TBC',
          'SRS 3.2',
          'TC-001',
          'Not Run',
          'Draft',
        ],
      ])
    );
  }

  if (options.screenshots !== false) {
    writeFile(
      dir,
      'assets/media-register.csv',
      toCsv(MEDIA_COLUMNS, [
        [
          `${request.projectName}-FIG-001`,
          'assets/img/FIG-001-example.png',
          'figure',
          today,
          '',
          classification,
          'BRD 2.1',
          'Example figure — replace',
          'Hash is filled in when the file is attached',
        ],
      ])
    );
    writeFile(dir, 'assets/README.md', mediaGuidance(request.projectName, spec, krisa, classification));
  }

  ensureMediaFolders(dir, spec, options);

  if (spec.role === 'Tester' && options.evidenceCapture !== false) {
    writeFile(
      dir,
      '04-defects/test-evidence-register.csv',
      toCsv(EVIDENCE_COLUMNS, [
        [
          'EX-0001',
          'TC-001',
          'REQ-001',
          'UAT-1',
          'Example execution — replace',
          version,
          'SIT',
          today,
          'TBC',
          'TBC',
          '',
          'Reference number issued',
          'Reference number issued',
          'Pass',
          '',
          '',
          '',
          `${request.projectName}-EVD-001`,
          '',
        ],
      ])
    );
  }

  // ── Document register + README doc map ───────────────────────────────
  if ((options.docControl ?? 'Full') === 'Full') {
    writeFile(dir, '00-project-control/document-register.csv', toCsv(DOCUMENT_COLUMNS, rows));
  }

  // The project map is a document too: a stakeholder may want a Word/PDF copy of it.
  writeFile(dir, 'README.md', renderProjectReadme(request, spec, options, rows, krisa, lang, version));
  documents.push('README.md');

  // ── Export pipeline (Word) ───────────────────────────────────────────
  const word = options.wordExport ?? 'Pandoc scripts';
  if (word !== 'None') {
    writeExportPipeline(dir, request, spec, lang, classification, version);
  }

  // ── Source inputs (the raw material the documents derive from) ──────
  const inputFolderList = captureInputs ? inputFolders(files, docIds) : [];
  if (captureInputs) {
    writeFile(
      dir,
      'inputs/README.md',
      renderInputsReadme({
        projectName: request.projectName,
        roleLabel: spec.templateName,
        lang,
        classification,
        folders: inputFolderList,
      })
    );
    writeFile(
      dir,
      INPUT_REGISTER_PATH,
      toCsv(INPUT_COLUMNS, [
        inputRegisterExampleRow({
          folder: exampleInputFolder(inputFolderList)!,
          classification,
        }),
      ])
    );
    for (const folder of inputFolderList) {
      writeFile(
        dir,
        `${folder.folder}/README.md`,
        renderInputFolderReadme({ projectName: request.projectName, folder, lang, classification })
      );
    }
  }

  // ── Machine-readable project record ──────────────────────────────────
  const record = {
    version: 1,
    template: spec.templateId,
    role: spec.role,
    project: request.projectName,
    description: request.projectDescription || '',
    framework: krisa ? 'KRiSA (Government)' : 'Standard',
    krisaGuideline: krisa ? KRISA_GUIDELINE_URL : null,
    language: lang,
    classification,
    documentVersion: version,
    naming: '<PROJ>-<ROLE>-<TYPE>-<NNN>',
    traceability: options.traceability !== false,
    wordExport: word,
    xlsxExport: options.xlsxExport ?? (spec.role === 'Tester' ? 'Registers + summary' : 'Registers only'),
    diagramTool: options.diagramTool ?? 'mermaid',
    documentCount: files.length,
    linkedProjects: [],
    inputs:
      captureInputs
        ? {
            folder: INPUTS_FOLDER,
            register: INPUT_REGISTER_PATH,
            folders: inputFolderList.map((folder) => folder.folder),
          }
        : null,
    createdAt: new Date().toISOString(),
  };
  writeFile(dir, '.ado-code/documentation.json', JSON.stringify(record, null, 2) + '\n');

  writeDocumentationGitignore(dir);

  return documents;
}

function deliveryFormat(options: DocOptions): string {
  const word = options.wordExport ?? 'Pandoc scripts';
  if (word === 'None') {
    return 'Markdown';
  }
  return 'Markdown + Word/PDF';
}

function mediaGuidance(
  projectName: string,
  spec: DocProjectSpec,
  krisa: boolean,
  classification: string
): string {
  const lines: string[] = [];
  lines.push('# Media and Evidence', '');
  lines.push(
    'Screenshots, figures and diagrams are deliverables, not decoration: each one ' +
      'is registered with an id, a capture timestamp and a hash, so a reviewer can ' +
      'confirm the image in the document is the image that was captured.',
    ''
  );
  lines.push('## Folders', '');
  lines.push('| FOLDER | CONTENTS | ID PREFIX |');
  lines.push('| --- | --- | --- |');
  lines.push('| assets/img/ | Illustrative figures for manuals and design docs | FIG-### |');
  if (spec.role === 'Tester') {
    lines.push('| assets/evidence/ | Test evidence screenshots | EVD-### |');
  }
  lines.push('| diagrams/ | Diagram SOURCE (.mmd) beside its .svg and .png | DIA-### |');
  lines.push('');
  lines.push('## Capture rules', '');
  lines.push('- Capture with the window title and (for evidence) the build version visible in frame.');
  lines.push('- One screenshot per assertion; a screenshot showing five results proves none of them.');
  lines.push('- Name the file `<MEDIA-ID>-<slug>.png` and add the register row in the same commit.');
  lines.push('- Record the SHA-256 of the file when it is attached — it is the only way to prove the signed-off image was not replaced.');
  if (krisa) {
    lines.push(
      `- KRiSA classification for this project is ${classification}. Redact personal data before capture; a screenshot of production data must be redacted and its register row marked TERHAD.`
    );
  }
  lines.push('');
  lines.push('## Diagrams', '');
  lines.push(
    'Write the diagram source in `diagrams/` and keep the rendered image beside it. ' +
      'The DOCX export embeds the PNG; a raw mermaid fence is reported as omitted, ' +
      'because Word cannot render it.'
  );
  lines.push('');
  lines.push(`Project: ${projectName}`);
  return lines.join('\n') + '\n';
}

function renderProjectReadme(
  request: DocScaffoldRequest,
  spec: DocProjectSpec,
  options: DocOptions,
  rows: string[][],
  krisa: boolean,
  lang: DocLang,
  version: string
): string {
  const lines: string[] = [];
  lines.push(`# ${request.projectName}`, '');
  lines.push(request.projectDescription || `${spec.templateName} documentation project.`, '');
  lines.push('## Project facts', '');
  lines.push('| FIELD | VALUE |');
  lines.push('| --- | --- |');
  lines.push(`| Role | ${spec.templateName} (${spec.role}) |`);
  lines.push(`| Governance | ${krisa ? 'KRiSA (Government)' : 'Standard'} |`);
  lines.push(`| Document language | ${lang} |`);
  lines.push(`| Document version | ${version} |`);
  lines.push(`| Naming | \`<PROJ>-<ROLE>-<TYPE>-<NNN>\` |`);
  lines.push('');
  lines.push('## Document map', '');
  lines.push('| DOC-ID | FILE | STATUS |');
  lines.push('| --- | --- | --- |');
  for (const row of rows) {
    const file = spec.docSet.find((f) => row[0].endsWith(`-${f.docType}-001`));
    lines.push(`| ${row[0]} | ${file ? file.path : ''} | ${row[3]} |`);
  }
  lines.push('');
  lines.push('## Source inputs', '');
  lines.push(
    'Raw material (meeting notes, transcripts, sketches, client documents) lives in `inputs/`, one folder per document. Every item is logged in `inputs/source-register.csv` with an `INPUT-ID` that the requirement it justified cites back to.'
  );
  lines.push('');
  lines.push('## How this project joins the others', '');
  lines.push(
    '- Requirement ids (`REQ-###`) originate in the Business Analysis project. Never invent one in another role.'
  );
  lines.push(
    '- Test cases (`TC-###`) live in the Test & UAT project; design documents cite the requirement they satisfy.'
  );
  lines.push(
    '- Registers use a shared column contract, so `rtm.csv` from two projects can be appended in Excel without realigning columns.'
  );
  lines.push('');
  lines.push('## Source of truth', '');
  lines.push(
    'The Markdown files are the source. Any Word, Excel or PDF output is regenerated ' +
      'from them — editing the generated file means the next export discards the edit.'
  );
  if ((options.wordExport ?? 'Pandoc scripts') !== 'None') {
    lines.push('');
    lines.push('```');
    lines.push('cd export && ./export.sh        # or: pwsh ./export.ps1');
    lines.push('```');
  }
  lines.push('');
  return lines.join('\n');
}

function writeExportPipeline(
  dir: string,
  request: DocScaffoldRequest,
  spec: DocProjectSpec,
  lang: DocLang,
  classification: string,
  version: string
): void {
  const pandocLang = lang === 'ms' ? 'ms' : 'en';
  const yaml: string[] = [];
  yaml.push('---');
  yaml.push(`title: "${request.projectName}"`);
  yaml.push(`subtitle: "${spec.templateName} documentation"`);
  yaml.push(`version: "${version}"`);
  yaml.push(`classification: "${classification}"`);
  yaml.push(`lang: ${pandocLang}`);
  yaml.push('toc: true');
  yaml.push('toc-depth: 2');
  yaml.push('numbersections: true');
  yaml.push('---');
  writeFile(dir, 'export/pandoc.yaml', yaml.join('\n') + '\n');

  writeFile(
    dir,
    'export/print.css',
    `/* Print/HTML stylesheet. System font stacks only: the webview has no font-src,
   so a web font would silently fall back anyway. */
@page {
  size: A4;
  margin: 20mm;
}
body {
  font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.45;
}
h1 { font-size: 20pt; page-break-before: auto; }
h2 { font-size: 14pt; page-break-after: avoid; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th, td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
th { background: #eee; text-align: left; }
img { max-width: 100%; height: auto; }
code, pre { font-family: Consolas, "Courier New", monospace; font-size: 9pt; }
.classification-banner {
  border: 2px solid #000;
  padding: 4px 8px;
  font-weight: bold;
  text-transform: uppercase;
}
@media print {
  .pagebreak { page-break-after: always; }
}
`
  );

  writeFile(
    dir,
    'export/export.ps1',
    `# Build Word documents (and PDFs when a PDF engine is installed) from the
# Markdown sources. Run from the export/ folder.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$reference = Join-Path $PSScriptRoot 'company-reference.docx'
$refArgs = @()
if (Test-Path $reference) {
  $refArgs = @('--reference-doc', $reference)
} else {
  Write-Host 'No company-reference.docx found: pandoc default styles will be used.'
}

$mdFiles = Get-ChildItem -Path $root -Recurse -Filter *.md |
  Where-Object { $_.FullName -notlike "*export*" -and $_.Name -ne "README.md" }

foreach ($md in $mdFiles) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($md.Name) + ".docx"
  Write-Host "pandoc -> $name"
  $pandocArgs = @($md.FullName, "-o", (Join-Path $out $name), "--from", "markdown", "--to", "docx", "--metadata-file", (Join-Path $PSScriptRoot "pandoc.yaml"), "--resource-path", $root)
  if (Test-Path $reference) { $pandocArgs += @("--reference-doc", $reference) }
  & pandoc @pandocArgs
}

Write-Host "Done. Output in $out"
`
  );

  writeFile(
    dir,
    'export/export.sh',
    `#!/usr/bin/env bash
# Build Word documents (and PDFs when a PDF engine is installed) from the
# Markdown sources. Run from the export/ folder.
set -euo pipefail

here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="$here/out"
mkdir -p "$out"

ref_args=()
if [ -f "$here/company-reference.docx" ]; then
  ref_args=(--reference-doc "$here/company-reference.docx")
else
  echo "No company-reference.docx found: pandoc default styles will be used."
fi

while IFS= read -r -d '' file; do
  name="$(basename "\${file%.md}").docx"
  echo "pandoc -> $name"
  pandoc "$file" -o "$out/$name" \\
    --from markdown --to docx \\
    --metadata-file "$here/pandoc.yaml" \\
    --resource-path "$root" "\${ref_args[@]}"
done < <(find "$root" -name '*.md' -not -path "*/export/*" -not -name 'README.md' -print0)
`
  );

  writeFile(
    dir,
    'export/README.md',
    `# Export pipeline

Markdown here is the source of truth. This folder generates the distributable
artefacts.

## Word (pandoc)

1. Install pandoc (\`pandoc --version\`).
2. Optional: drop your corporate template in as \`company-reference.docx\`. Its
   styles, heading numbering and cover layout are applied to every document.
3. Run one of:

\`\`\`
pwsh ./export.ps1
./export.sh
\`\`\`

Output lands in \`export/out/\`, which is gitignored.

## PDF

PDF is produced from the same pipeline by adding \`--pdf-engine\` (for example
\`--pdf-engine=xelatex\`) and an \`-o out/<name>.pdf\` target, or by printing the
HTML export. No PDF engine is bundled: it is a machine-level prerequisite.

## In-product export

When the project records \`wordExport\` as \`In-product (.docx)\` or \`Both\`, the
extension can write a .docx without pandoc installed. That path supports the
documented Markdown subset only — a raw mermaid fence is reported as omitted
rather than rendered, so export the diagram and reference the image instead.
`
  );

}

/** Minimal, safe .gitignore for a documentation project. */
/** The input folder a document owns, or undefined when it is derived or disabled. */
function inputFolderFor(docType: string, enabled: boolean): string | undefined {
  return enabled && isSourcedDocType(docType)
    ? `${INPUTS_FOLDER}/${inputFolderSlug(docType)}`
    : undefined;
}

function writeDocumentationGitignore(dir: string): void {
  const content = [
    '# Generated output — never the source of truth',
    'export/out/',
    '*.pdf',
    '',
    '# Office lock files',
    '~$*',
    '*.tmp',
    '',
    '# Assets ARE deliverables: do not ignore assets/ or diagrams/.',
    '# For large evidence sets, consider Git LFS:',
    '# assets/evidence/** filter=lfs diff=lfs merge=lfs -text',
    '',

    '# Source inputs: recordings are registered but not committed (too large).',
    ...INPUT_RECORDING_PATTERNS.map((pattern) => `inputs/**/${pattern}`),
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), content, 'utf8');
}

/** Template ids this module owns. */
export const DOC_TEMPLATE_IDS = Object.keys(DOC_PROJECT_SPECS);

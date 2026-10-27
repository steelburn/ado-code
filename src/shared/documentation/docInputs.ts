/**
 * Source inputs — the raw material a documentation project is built from.
 *
 * A requirements document is never written from thin air: it comes from a
 * workshop, a transcript, a scribbled whiteboard, a client-supplied policy PDF.
 * Those artefacts are the *provenance* of every requirement, and the one thing
 * an auditor asks for that teams routinely cannot produce. So they get a home
 * of their own — `inputs/` — one folder per document they feed, plus a
 * register (`inputs/source-register.csv`, `INPUT_COLUMNS`) row per item.
 *
 * The chain this closes:
 *
 *   inputs/IN-001  ->  REQ-014  ->  TC-014  ->  EX-0014  ->  EVD-014-01.png
 *   (where it came      (what        (how it     (that it      (proof it
 *    from)              was agreed)   is tested)  ran)          passed)
 *
 * Pure, dependency-free and vscode-free so it runs under mocha and can be
 * reused by the host, the scaffolder and (later) the export path.
 */

import type { DocLang } from './docTemplates';

/** Root folder for raw source material. */
export const INPUTS_FOLDER = 'inputs';

/** The register that makes an input folder auditable rather than a dumping ground. */
export const INPUT_REGISTER_PATH = `${INPUTS_FOLDER}/source-register.csv`;

/**
 * Documents that are DERIVED from the other documents rather than sourced, so a
 * per-document input folder would be noise: a traceability matrix is computed
 * from requirement and test ids, a compliance matrix from the KRiSA catalogue,
 * a glossary from terminology already introduced elsewhere.
 */
export const INPUT_EXCLUDED_DOC_TYPES = [
  'RTM',
  'RMAP',
  'TTC',
  'KCM',
  'CRL',
  'DCT',
  'GLS',
] as const;

/** Catch-all for material that supports the project without belonging to one document. */
export const GENERAL_INPUT_SLUG = '_general';

/** Extensions too large to version; listed in the register but kept out of git. */
export const INPUT_RECORDING_PATTERNS = [
  '*.mp3',
  '*.mp4',
  '*.wav',
  '*.m4a',
  '*.mov',
  '*.mkv',
  '*.webm',
] as const;

/** Structural subset of `DocFileSpec` — keeps this module independent of the specs. */
export interface InputDocRef {
  path: string;
  docType: string;
  titleEn: string;
  titleBm: string;
}

export interface InputFolderSpec {
  /** Folder name under `inputs/`. */
  slug: string;
  /** Project-relative folder path, e.g. `inputs/brd`. */
  folder: string;
  /** Document ids this folder feeds (one folder may serve several documents). */
  docIds: string[];
  /** Human titles, parallel to `docIds`. */
  titles: string[];
  /** Project-relative document paths, parallel to `docIds`. */
  docPaths: string[];
  /** What a person should actually drop in here. */
  hint: string;
}

/**
 * What belongs in each document's input folder. Keyed by doc type; the fallback
 * is generic on purpose — a missing entry must not stop the folder existing.
 */
const INPUT_HINTS: Record<string, string> = {
  CHT: 'sponsor brief, mandate or approval email, business case, funding note',
  BRD: 'scope workshop notes, objectives, problem statements, sponsor correspondence',
  FRS: 'SME interviews, requirement drafts, screen sketches, business rules (BR-###)',
  NFR: 'SLA / performance targets, security and compliance requirements, policy extracts',
  STR: 'organisation charts, contact lists, RACI drafts, attendee lists',
  PAS: 'current-state process walkthroughs, existing SOPs, work samples, pain-point notes',
  PTB: 'target-state workshops, process redesign notes, approval of the future flow',
  DPL: 'style guide, templates supplied by the client, editorial standards, branding rules',
  SRS: 'design walkthrough notes, client design feedback, interface samples',
  SDD: 'architecture notes, vendor documentation, platform constraints, review comments',
  DMD: 'source data dictionaries, schema dumps, sample data, data-owner interviews',
  IFS: 'interface samples, third-party API documentation, message traces, integration notes',
  CMP: 'configuration item lists, environment details, change procedures',
  USM: 'task walkthroughs with end users, annotated screenshots, user feedback, terminology',
  ADG: 'administrator interviews, operational procedures, escalation paths',
  TRG: 'training requests, curriculum notes, exercises, attendee feedback',
  FAQ: 'support tickets, recurring user questions, helpdesk transcripts',
  DPG: 'environment and infrastructure details, vendor install guides, cutover plans',
  RBK: 'operational procedures, monitoring runbooks, incident notes',
  RLN: 'release scope notes, change lists, defect closures, go-live decisions',
  API: 'API specifications, endpoint samples, payload examples, authentication notes',
  ITG: 'integration contracts, mapping spreadsheets, vendor interface specifications',
  TST: 'risk register, quality objectives, test policy, organisational standards',
  TPL: 'scope of testing, estimates, resource plan, entry/exit criteria discussion',
  RBT: 'risk assessment notes, impact analysis, historical defect data',
  TSC: 'requirement walkthroughs, user journeys, usage scenarios',
  TCS: 'requirement clarifications, expected-result confirmations, test data samples',
  UAP: 'UAT scope agreement, participant list, business acceptance criteria',
  UAS: 'business scripts supplied by users, sample data, signed expected results',
  UASO: 'sign-off correspondence, acceptance decisions, waiver emails',
  TSR: 'test execution metrics, incident summaries, closure decisions',
  SEC: 'security requirements, penetration test scope, threat model notes',
  PER: 'performance targets, load profiles, production volume estimates',
  CRT: 'change request evidence, impact assessments, approval trails',
};

const GENERAL_HINT = 'cross-cutting material: general meeting notes, correspondence, standards';

/** Lower-case, hyphenated folder name derived from a document type code. */
export function inputFolderSlug(docType: string): string {
  const slug = String(docType ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'doc';
}

/** True when a document warrants its own input folder. */
export function isSourcedDocType(docType: string): boolean {
  const code = String(docType ?? '').toUpperCase();
  if (!code) {
    return false;
  }
  return !(INPUT_EXCLUDED_DOC_TYPES as readonly string[]).includes(code);
}

function hintFor(docType: string): string {
  return INPUT_HINTS[String(docType ?? '').toUpperCase()] ?? 'raw material this document is derived from';
}

/**
 * Build the input folder list for a project: one folder per sourced document,
 * in document order, plus a catch-all. `docIds` maps document path -> doc id so
 * the doc-id formula stays in one place (the scaffolder).
 */
export function inputFolders(
  files: readonly InputDocRef[],
  docIds: Record<string, string> = {}
): InputFolderSpec[] {
  const bySlug = new Map<string, InputFolderSpec>();

  for (const file of files) {
    if (!isSourcedDocType(file.docType)) {
      continue;
    }
    const slug = inputFolderSlug(file.docType);
    const existing = bySlug.get(slug);
    const docId = docIds[file.path] ?? '';
    if (existing) {
      existing.docIds.push(docId);
      existing.titles.push(file.titleEn);
      existing.docPaths.push(file.path);
      continue;
    }
    bySlug.set(slug, {
      slug,
      folder: `${INPUTS_FOLDER}/${slug}`,
      docIds: [docId],
      titles: [file.titleEn],
      docPaths: [file.path],
      hint: hintFor(file.docType),
    });
  }

  const general = bySlug.get(GENERAL_INPUT_SLUG) ?? {
    slug: GENERAL_INPUT_SLUG,
    folder: `${INPUTS_FOLDER}/${GENERAL_INPUT_SLUG}`,
    docIds: [],
    titles: ['Whole project'],
    docPaths: [],
    hint: GENERAL_HINT,
  };
  bySlug.set(GENERAL_INPUT_SLUG, general);

  return [...bySlug.values()];
}

export interface InputsReadmeContext {
  projectName: string;
  roleLabel: string;
  lang: DocLang;
  classification: string;
  folders: readonly InputFolderSpec[];
}

function isBm(lang: DocLang): boolean {
  return lang === 'ms' || lang === 'bilingual';
}

/** `inputs/README.md` — the index, generated from the folders that actually exist. */
export function renderInputsReadme(ctx: InputsReadmeContext): string {
  const bm = isBm(ctx.lang);
  const lines: string[] = [];
  lines.push(`# ${ctx.projectName} — source inputs`, '');
  if (bm) {
    lines.push('> Input sumber — bahan mentah yang menjadi asas dokumentasi ini.', '');
  }
  lines.push(
    'Raw material this documentation is built from: meeting notes, transcripts, workshop',
    'output, whiteboard sketches, emails, survey results and client-supplied documents.',
    ''
  );

  lines.push('| FIELD | VALUE |');
  lines.push('| --- | --- |');
  lines.push(`| Role | ${ctx.roleLabel} |`);
  lines.push(`| Classification | ${ctx.classification} |`);
  lines.push('');

  lines.push('## Where things go', '');
  lines.push('| FOLDER | FEEDS DOCUMENT | DOC-ID | WHAT BELONGS THERE |');
  lines.push('| --- | --- | --- | --- |');
  for (const folder of ctx.folders) {
    const docId = folder.docIds.filter(Boolean).join('<br>') || '—';
    const docTitle = folder.titles.join('; ');
    lines.push(`| \`${folder.folder}/\` | ${docTitle} | ${docId} | ${folder.hint} |`);
  }
  lines.push('');

  lines.push('## Rules', '');
  lines.push(
    '1. **Copy the original in unmodified.** Never edit a source in place — a',
    '   transcription or summary is a new file beside it, suffixed `-notes.md`.',
    '2. **One INPUT-ID per item.** Name the file `<INPUT-ID>-<short-slug>.<ext>`',
    '   (for example `IN-001-scope-workshop-notes.md`) and add a row to',
    '   `source-register.csv`. A file with no row does not exist as far as an',
    '   audit is concerned.',
    '3. **Always set LINKED-DOC.** When a requirement comes out of the item, put',
    '   the `REQ-###` / `NFR-###` ids in LINKED-REQ. That is what lets a reviewer',
    '   walk from a signed requirement back to the meeting that produced it.',
    '4. **Status moves forward only.** `Received` -> `Triaged` (decided what it',
    '   affects) -> `Incorporated` (worked into a document). `Superseded` and',
    '   `Rejected` are recorded, never deleted.',
    `5. **Redact personal data.** Material containing personal or restricted data is`,
    `   classified \`TERHAD\` / \`RESTRICTED\` here and in the documents it feeds.`,
    '6. **Recordings stay out of git.** `mp3`, `mp4`, `wav`, `m4a`, `mov`, `mkv` and',
    '   `webm` files are listed in the register but not committed — keep the',
    '   transcript committed instead.'
  );
  lines.push('');
  lines.push(`Register: \`${INPUT_REGISTER_PATH}\` — columns \`INPUT_COLUMNS\`.`);
  lines.push('');
  return lines.join('\n');
}

export interface InputFolderReadmeContext {
  projectName: string;
  folder: InputFolderSpec;
  lang: DocLang;
  classification: string;
}

/** `inputs/<slug>/README.md` — short, because it doubles as the folder's git marker. */
export function renderInputFolderReadme(ctx: InputFolderReadmeContext): string {
  const bm = isBm(ctx.lang);
  const lines: string[] = [];
  const title = ctx.folder.titles.join(' / ');
  lines.push(`# ${ctx.folder.folder} — ${title}`, '');
  if (bm) {
    lines.push('> Folder ini menyimpan bahan mentah untuk dokumen di atas.', '');
  }
  if (ctx.folder.docIds.length > 0) {
    lines.push('| FEEDS | DOC-ID | FILE |');
    lines.push('| --- | --- | --- |');
    ctx.folder.titles.forEach((docTitle, index) => {
      lines.push(
        `| ${docTitle} | ${ctx.folder.docIds[index] || '—'} | \`${ctx.folder.docPaths[index] || '—'}\` |`
      );
    });
    lines.push('');
  }
  lines.push('## What belongs here', '', `- ${ctx.folder.hint}.`, '');
  lines.push('## Before you leave a file here', '');
  lines.push(
    '- [ ] the original is untouched (no in-place edits, no re-saving from Word)',
    '- [ ] an `INPUT-ID` was assigned and a row added to `../source-register.csv`',
    '- [ ] `LINKED-DOC` set, and `LINKED-REQ` filled once requirements are drawn from it',
    '- [ ] personal data redacted, `CLASSIFICATION` set to the stricter of the source',
    '- [ ] a summary or transcription was written as a separate `-notes.md` file'
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * The folder the example register row should point at: a requirements-shaped
 * document if the project has one, otherwise the first real folder. Logging the
 * example against a source document makes the LINKED-REQ cell meaningful.
 */
export function exampleInputFolder(folders: readonly InputFolderSpec[]): InputFolderSpec | undefined {
  const preferred = ['brd', 'frs', 'srs', 'tpl', 'tcs', 'usm', 'tst'];
  for (const slug of preferred) {
    const match = folders.find((folder) => folder.slug === slug);
    if (match) {
      return match;
    }
  }
  return folders.find((folder) => folder.docIds.length > 0) ?? folders[0];
}

export interface InputExampleRowContext {
  folder: InputFolderSpec;
  classification: string;
}

/** One illustrative register row, so the columns are demonstrated rather than described. */
export function inputRegisterExampleRow(ctx: InputExampleRowContext): string[] {
  const target = ctx.folder.docIds[0] || '';
  const filename = `IN-001-example-notes.md`;
  return [
    'IN-001',
    'meeting-notes',
    'TBC',
    'TBC',
    `${ctx.folder.folder}/${filename}`,
    'Example — replace this row',
    'Business owner',
    target,
    'REQ-001',
    'Received',
    ctx.classification,
    '',
    'Where the requirement came from and what it affected',
  ];
}

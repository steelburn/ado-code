/**
 * Documentation project specs — one per role.
 *
 * These are DATA, rendered by a single scaffolder path
 * (`ProjectCreationService.scaffoldDocProject`). Splitting BA / technical
 * writing / testing into three templates means three projects and therefore
 * three traceability matrices, so the mitigating rules are structural:
 *
 *  1. One ID vocabulary across all three: REQ-### / NFR-### / BR-### / TC-###
 *     / EX-#### / DEF-### / CR-### / EVD-### / DIA-### / FIG-###.
 *  2. One column contract (`columns.ts`) so the three registers join in Excel.
 *  3. Every project records its `role` and `linkedProjects` in
 *     `.ado-code/documentation.json`, so a later cross-project roll-up does
 *     not have to guess.
 *
 * Bodies are restricted to the pandoc- and docx-safe Markdown subset:
 * ATX headings, pipe tables, ordered/unordered lists, fenced code, and the one
 * page-break marker `<div class="pagebreak"></div>`. No footnotes, no raw HTML,
 * no setext underlines — `docBlocks.ts` reports those as `unsupported` and the
 * DOCX export would have to omit them.
 *
 * Deliberately vscode-free and DOM-free.
 */

import { DocRole } from './krisa';
import { markdownTableHeader } from './columns';

export interface DocOptions {
  governance?: string;
  docLanguage?: string;
  docControl?: string;
  traceability?: boolean;
  krisaCompliance?: boolean;
  wordExport?: string;
  xlsxExport?: string;
  screenshots?: boolean;
  diagramTool?: string;
  captureInputs?: boolean;
  includeStakeholders?: boolean;
  includeProcess?: boolean;
  includeNfr?: boolean;
  includeDesign?: boolean;
  includeUserDocs?: boolean;
  includeRunbooks?: boolean;
  includeApiDocs?: boolean;
  includeTestCases?: boolean;
  includeUat?: boolean;
  includeSecurity?: boolean;
  includePerformance?: boolean;
  defectManagement?: boolean;
  [key: string]: unknown;
}

export type DocLang = 'en' | 'ms' | 'bilingual';

export interface DocSection {
  heading: string;
  guidance?: string;
  bullets?: string[];
  numbered?: string[];
  table?: { header: string[]; rows: string[][] };
}

export interface DocFileSpec {
  /** Path relative to the project root, forward slashes. */
  path: string;
  /** Short type code used in the document id: <PROJ>-<ROLE>-<TYPE>-001. */
  docType: string;
  titleEn: string;
  titleBm: string;
  /** One-paragraph statement of what the document is for. */
  purpose: string;
  sections: DocSection[];
  /** Written only when KRiSA governance is selected. */
  krisaOnly?: boolean;
  /** Written only when the toggle returns true. */
  when?: (options: DocOptions) => boolean;
}

export interface DocProjectSpec {
  templateId: 'doc-ba' | 'doc-writer' | 'doc-tester';
  role: DocRole;
  /** Role code embedded in every document id. */
  roleCode: string;
  templateName: string;
  docSet: DocFileSpec[];
}

const isFull = (o: DocOptions) => (o.docControl ?? 'Full') === 'Full';
const on = (value: unknown, fallback = true) =>
  value === undefined ? fallback : Boolean(value);

/** Shared across all three roles. */
function commonDocs(): DocFileSpec[] {
  return [
    {
      path: '00-project-control/glossary.md',
      docType: 'GLS',
      titleEn: 'Glossary and Terminology',
      titleBm: 'Glosari dan Istilah',
      purpose:
        'One authoritative spelling and definition per business term, so the ' +
        'requirements, design and test documents cannot drift apart in wording.',
      sections: [
        {
          heading: 'How to use this glossary',
          bullets: [
            'Add a term the first time it appears in any project document.',
            'Record the Bahasa Malaysia equivalent even when the document is English — the signed submission is often bilingual.',
            'Keep one definition per term; if two teams disagree, that disagreement is a requirements defect, not a glossary entry.',
          ],
        },
        {
          heading: 'Terms',
          table: {
            header: ['TERM', 'BAHASA MALAYSIA', 'DEFINITION', 'USED IN'],
            rows: [
              [
                'Applicant',
                'Pemohon',
                'A person who submits an application through the system.',
                'BRD, SRS, TC',
              ],
              [
                'Approval Authority',
                'Pihak Berkuasa Kelulusan',
                'The role permitted to approve or reject an application.',
                'BRD, UAT',
              ],
            ],
          },
        },
      ],
    },
    {
      path: '00-project-control/document-control.md',
      docType: 'DCT',
      titleEn: 'Document Control',
      titleBm: 'Kawalan Dokumen',
      purpose:
        'The register that makes the submission auditable: which artefact, which ' +
        'version, who approved it, and in which format it was distributed.',
      sections: [
        {
          heading: 'Version history',
          table: {
            header: ['VERSION', 'DATE', 'AUTHOR', 'APPROVER', 'CHANGES'],
            rows: [['0.1', 'YYYY-MM-DD', 'role', 'TBC', 'Initial draft']],
          },
        },
        {
          heading: 'Deliverables',
          guidance:
            'Every artefact below exists as a Markdown source and as the stated ' +
            'delivery format. The Markdown is the source of truth; the delivery ' +
            'format is regenerated, never edited in place.',
          table: {
            header: ['DOC-ID', 'TITLE', 'DELIVERY FORMAT', 'STATUS', 'APPROVER'],
            rows: [
              [
                'TBC',
                'Generated from the project doc set',
                'Markdown + Word/PDF',
                'Draft',
                'TBC',
              ],
            ],
          },
        },
        {
          heading: 'Review and approval',
          numbered: [
            'Author updates the Markdown source and bumps the version.',
            'Reviewer records comments against the version, not the file name.',
            'Approver signs the exported PDF; the version and classification appear on the cover page.',
            'Only then does the status become Approved.',
          ],
        },
      ],
      when: isFull,
    },
    {
      path: '00-project-control/krisa-compliance-matrix.md',
      docType: 'KCM',
      titleEn: 'KRiSA Compliance Matrix',
      titleBm: 'Matriks Pematuhan KRiSA',
      purpose:
        'Maps each KRiSA artefact this role owns to its location in this project, ' +
        'its status and its sign-off evidence.',
      sections: [
        {
          heading: 'How to complete this matrix',
          bullets: [
            'One row per KRiSA artefact owned by this role; the other roles track their own rows in their own projects.',
            'The guideline reference column is pre-filled with "TODO — confirm clause" and MUST be corrected against the published guideline before the matrix is signed.',
            'Evidence links point at a document, a test execution id (EX-####) or an evidence id (EVD-###).',
          ],
        },
        {
          heading: 'Artefacts',
          guidance:
            'Rows are generated from the KRiSA artefact catalogue. Status vocabulary: ' +
            'Not Started / Draft / In Review / Approved / Not Applicable.',
          table: {
            header: [
              'ARTEFACT-ID',
              'ARTEFACT',
              'PHASE',
              'STATUS',
              'SIGN-OFF DATE',
              'EVIDENCE LINK',
              'GUIDELINE REF',
            ],
            rows: [
              [
                'K-XX-00',
                'Generated from the KRiSA catalogue',
                'Phase',
                'Not Started',
                '',
                '',
                'TODO — confirm clause',
              ],
            ],
          },
        },
      ],
      krisaOnly: true,
    },
    {
      path: '06-change-control/change-request-template.md',
      docType: 'CRT',
      titleEn: 'Change Request',
      titleBm: 'Permohonan Perubahan',
      purpose:
        'The form a change request is raised on, so scope changes are assessed ' +
        'rather than absorbed silently into a requirement document.',
      sections: [
        {
          heading: 'Request',
          table: {
            header: ['FIELD', 'VALUE'],
            rows: [
              ['Change id', 'CR-001'],
              ['Raised by', 'name, role'],
              ['Date raised', 'YYYY-MM-DD'],
              ['Affected requirement(s)', 'REQ-001'],
              ['Description', 'What must change'],
              ['Reason', 'Why it must change now'],
            ],
          },
        },
        {
          heading: 'Impact assessment',
          table: {
            header: ['AREA', 'IMPACT', 'EFFORT', 'ASSESSED BY'],
            rows: [
              ['Requirements', 'Which REQ ids are affected', 'TBC', 'BA'],
              ['Design', 'Which design sections are affected', 'TBC', 'Writer'],
              ['Test', 'Which TC ids must be re-run', 'TBC', 'Tester'],
            ],
          },
        },
        {
          heading: 'Decision',
          numbered: [
            'Approved — schedule the change and update the traceability matrix.',
            'Rejected — record the reason; the requirement stays unchanged.',
            'Deferred — record the target release.',
          ],
        },
      ],
      when: isFull,
    },
    {
      path: '06-change-control/change-request-log.md',
      docType: 'CRL',
      titleEn: 'Change Request Log',
      titleBm: 'Log Permohonan Perubahan',
      purpose:
        'The single list of every change request, its decision and the release it ' +
        'landed in.',
      sections: [
        {
          heading: 'Log',
          table: {
            header: ['CR-ID', 'DATE', 'TITLE', 'AFFECTS', 'DECISION', 'RELEASE'],
            rows: [['CR-001', 'YYYY-MM-DD', 'Short title', 'REQ-001', 'Approved', 'R1']],
          },
        },
      ],
      when: isFull,
    },
  ];
}

/** Business analysis role. */
function baDocs(): DocFileSpec[] {
  return [
    {
      path: '00-project-control/project-charter.md',
      docType: 'CHT',
      titleEn: 'Project Charter',
      titleBm: 'Piagam Projek',
      purpose:
        'Authorises the work: the problem, the outcome, the scope boundary and ' +
        'who decides. Everything later in the project is judged against this.',
      sections: [
        {
          heading: 'Background',
          guidance:
            'State the current situation and why it is unsatisfactory. Avoid ' +
            'solution language here — the solution belongs in the requirements.',
        },
        {
          heading: 'Objectives',
          numbered: [
            'Objective stated as an outcome, not an activity.',
            'Each objective must be measurable or verifiable at acceptance.',
          ],
        },
        {
          heading: 'Scope',
          table: {
            header: ['IN SCOPE', 'OUT OF SCOPE', 'ASSUMPTION'],
            rows: [
              ['Process area covered', 'Adjacent process not touched', 'Assumed available: source data'],
            ],
          },
        },
        {
          heading: 'Governance',
          table: {
            header: ['ROLE', 'NAME', 'RESPONSIBILITY'],
            rows: [
              ['Project sponsor', 'TBC', 'Approves scope and budget'],
              ['Business analyst', 'TBC', 'Owns requirements and traceability'],
              ['Technical writer', 'TBC', 'Owns design and user documentation'],
              ['Tester', 'TBC', 'Owns test evidence and UAT sign-off'],
            ],
          },
        },
      ],
    },
    {
      path: '01-business-analysis/brs.md',
      docType: 'BRD',
      titleEn: 'Business Requirements Specification',
      titleBm: 'Spesifikasi Keperluan Bisnes',
      purpose:
        'States the business need and the rules the business imposes, independent ' +
        'of any implementation. This is the document the business signs.',
      sections: [
        {
          heading: 'Business context',
          guidance:
            'Who performs the process today, with which forms or systems, and where ' +
            'it breaks down.',
        },
        {
          heading: 'Business requirements',
          guidance:
            'One row per requirement. Use MoSCoW for priority and name the ' +
            'stakeholder who asked for it — an unexplained requirement is the first ' +
            'thing an auditor queries.',
          table: {
            header: ['REQ-ID', 'REQUIREMENT', 'PRIORITY', 'SOURCE', 'ADO-WORK-ITEM', 'STATUS'],
            rows: [
              [
                'REQ-001',
                'The system shall allow an applicant to submit an application online.',
                'Must',
                'Stakeholder register #1',
                'TBC',
                'Draft',
              ],
              [
                'REQ-002',
                'The system shall notify the applicant by email when a decision is recorded.',
                'Should',
                'Operations',
                'TBC',
                'Draft',
              ],
            ],
          },
        },
        {
          heading: 'Business rules',
          table: {
            header: ['BR-ID', 'RULE', 'ENFORCED BY', 'RELATED REQ'],
            rows: [
              [
                'BR-001',
                'An application cannot be approved by the person who submitted it.',
                'System',
                'REQ-001',
              ],
            ],
          },
        },
        {
          heading: 'Assumptions and constraints',
          bullets: [
            'Constraint: the submission must run on the department network.',
            'Assumption: existing identity provider remains in service.',
          ],
        },
      ],
    },
    {
      path: '01-business-analysis/functional-requirements.md',
      docType: 'FRS',
      titleEn: 'Functional Requirements Specification',
      titleBm: 'Spesifikasi Keperluan Fungsian',
      purpose:
        'Decomposes the business requirements into functions a developer can build ' +
        'and a tester can verify, each with acceptance criteria.',
      sections: [
        {
          heading: 'How to read this document',
          bullets: [
            'Every function traces up to a REQ-id in the BRS and down to a TC-id in the tester project.',
            'Acceptance criteria use Given/When/Then so the tester can copy them into a test case unchanged.',
            'Number new functions sequentially; never renumber an approved one.',
          ],
        },
        {
          heading: 'Functions',
          table: {
            header: [
              'FR-ID',
              'FUNCTION',
              'TRACES TO',
              'PRECONDITION',
              'ACCEPTANCE CRITERIA',
            ],
            rows: [
              [
                'FR-001',
                'Submit application',
                'REQ-001',
                'Applicant is authenticated',
                'Given a valid form, when submitted, then a reference number is issued.',
              ],
            ],
          },
        },
        {
          heading: 'Validation rules',
          table: {
            header: ['FIELD', 'RULE', 'MESSAGE SHOWN', 'RELATED FR'],
            rows: [
              ['Applicant name', 'Mandatory, 2-120 characters', 'Name is required', 'FR-001'],
            ],
          },
        },
        {
          heading: 'Screen inventory',
          table: {
            header: ['SCREEN', 'PURPOSE', 'FIGURE', 'RELATED FR'],
            rows: [
              ['Application form', 'Capture applicant details', 'FIG-001', 'FR-001'],
            ],
          },
        },
      ],
    },
    {
      path: '01-business-analysis/stakeholder-register.md',
      docType: 'STR',
      titleEn: 'Stakeholder Register',
      titleBm: 'Daftar Pemegang Taruh',
      purpose:
        'Who cares about this system, what they need from it, and who signs off ' +
        'their part of the requirements.',
      sections: [
        {
          heading: 'Register',
          table: {
            header: ['STAKEHOLDER-ID', 'NAME / UNIT', 'ROLE', 'INTEREST', 'SIGN-OFF REQUIRED'],
            rows: [
              ['STK-001', 'Operations division', 'Business owner', 'Faster processing', 'Yes'],
              ['STK-002', 'ICT security', 'Reviewer', 'Data protection', 'Yes'],
            ],
          },
        },
      ],
    },
    {
      path: '01-process/process-as-is.md',
      docType: 'PAS',
      titleEn: 'Business Process — As-Is',
      titleBm: 'Proses Bisnes — As-Is',
      purpose:
        'The process as it actually runs today, so the change is measured against ' +
        'reality rather than against a procedure manual.',
      sections: [
        {
          heading: 'Process summary',
          table: {
            header: ['STEP', 'ACTOR', 'ACTION', 'SYSTEM / FORM', 'PAIN POINT'],
            rows: [
              ['1', 'Applicant', 'Submits paper form at counter', 'Form A', 'Only during office hours'],
            ],
          },
        },
        {
          heading: 'Diagram',
          guidance:
            'Keep the diagram source beside the rendered image so it can be ' +
            'regenerated: diagrams/DIA-001-as-is.mmd, .svg, .png.',
          table: {
            header: ['DIAGRAM-ID', 'FILE', 'PURPOSE'],
            rows: [['DIA-001', 'diagrams/DIA-001-as-is.png', 'As-is process flow']],
          },
        },
      ],
      when: (o) => on(o.includeProcess),
    },
    {
      path: '01-process/process-to-be.md',
      docType: 'PTB',
      titleEn: 'Business Process — To-Be',
      titleBm: 'Proses Bisnes — To-Be',
      purpose:
        'The future process the system must support, with the improvements stated ' +
        'so they can be verified after go-live.',
      sections: [
        {
          heading: 'Process summary',
          table: {
            header: ['STEP', 'ACTOR', 'ACTION', 'SYSTEM', 'IMPROVEMENT'],
            rows: [
              ['1', 'Applicant', 'Submits application online', 'New system', 'Available 24x7'],
            ],
          },
        },
        {
          heading: 'Changes from the current process',
          table: {
            header: ['CHANGE', 'AFFECTED STEP', 'RELATED REQ', 'AFFECTED USERS'],
            rows: [['Online submission replaces counter form', '1', 'REQ-001', 'Applicants']],
          },
        },
      ],
      when: (o) => on(o.includeProcess),
    },
    {
      path: '02-requirements/non-functional-requirements.md',
      docType: 'NFR',
      titleEn: 'Non-Functional Requirements',
      titleBm: 'Keperluan Bukan Fungsian',
      purpose:
        'Quality attributes with a number attached. A non-functional requirement ' +
        'without a measurable target cannot be tested and will not survive review.',
      sections: [
        {
          heading: 'Requirements',
          table: {
            header: ['NFR-ID', 'CATEGORY', 'REQUIREMENT', 'MEASURE', 'TARGET', 'VERIFIED BY'],
            rows: [
              ['NFR-001', 'Performance', 'Application form responds quickly', 'p95 response time', '< 2 s', 'TC-NFR-001'],
              ['NFR-002', 'Availability', 'Service available in office hours', 'Uptime', '99.5% monthly', 'Operational report'],
              ['NFR-003', 'Security', 'Only authorised roles approve', 'Role matrix test', 'All cases pass', 'TC-SEC-001'],
            ],
          },
        },
        {
          heading: 'Categories in use',
          bullets: [
            'Performance, Availability, Security, Usability, Compatibility, Maintainability, Data retention.',
            'Every NFR gets a VERIFIED-BY value: a test case id, or the operational report that proves it.',
          ],
        },
      ],
      when: (o) => on(o.includeNfr),
    },
    {
      path: '05-traceability/rtm.md',
      docType: 'RTM',
      titleEn: 'Requirements Traceability Matrix',
      titleBm: 'Matriks Kebolehkesanan Keperluan',
      purpose:
        'One row per requirement, tracing it from source through design to test ' +
        'and UAT. The join key against the tester project is the requirement id.',
      sections: [
        {
          heading: 'How the three projects join',
          bullets: [
            'The BA project owns REQ-ids; the writer project cites them in DESIGN-REF; the tester project cites them per test case.',
            'rtm.csv in this folder uses the same column contract as the tester project, so the two files can be appended in Excel.',
            'A requirement with an empty TEST-CASE cell is untested — that is a finding, not a formatting issue.',
          ],
        },
        {
          heading: 'Matrix',
          table: {
            header: [
              'REQ-ID',
              'TITLE',
              'SOURCE',
              'ADO-WORK-ITEM',
              'DESIGN-REF',
              'TEST-CASE',
              'UAT-STATUS',
              'STATUS',
            ],
            rows: [
              [
                'REQ-001',
                'Submit application online',
                'STK-001',
                'TBC',
                'SRS 3.2',
                'TC-001',
                'Not Run',
                'Draft',
              ],
            ],
          },
        },
      ],
      when: (o) => on(o.traceability),
    },
    ...commonDocs(),
  ];
}

/** Technical writing role. */
function writerDocs(): DocFileSpec[] {
  return [
    {
      path: '00-project-control/document-plan.md',
      docType: 'DPL',
      titleEn: 'Documentation Plan',
      titleBm: 'Pelan Dokumentasi',
      purpose:
        'Which documents this project produces, for which audience, in which ' +
        'format, and who reviews each one.',
      sections: [
        {
          heading: 'Audience and formats',
          table: {
            header: ['DOCUMENT', 'AUDIENCE', 'FORMAT', 'REVIEWER', 'FREQUENCY'],
            rows: [
              ['System design', 'Developers, architects', 'Markdown + Word', 'Technical lead', 'Per release'],
              ['User manual', 'End users', 'PDF', 'Business owner', 'Per release'],
            ],
          },
        },
        {
          heading: 'Writing conventions',
          bullets: [
            'Second person, active voice, one instruction per numbered step.',
            'Screenshots carry a FIG-id and are listed in assets/media-register.csv.',
            'Bahasa Malaysia documents keep the same section order and numbering as the English source.',
          ],
        },
      ],
    },
    {
      path: '01-design/srs.md',
      docType: 'SRS',
      titleEn: 'System Requirements Specification',
      titleBm: 'Spesifikasi Keperluan Sistem',
      purpose:
        'The bridge between business requirements and design: what the system must ' +
        'do, stated precisely enough to build and to test.',
      sections: [
        {
          heading: 'System functions',
          table: {
            header: ['SRS-ID', 'FUNCTION', 'TRACES TO', 'INPUT', 'OUTPUT'],
            rows: [['SRS-001', 'Record application', 'FR-001', 'Application form data', 'Application record + reference number']],
          },
        },
        {
          heading: 'Interfaces',
          table: {
            header: ['INTERFACE', 'TYPE', 'PROTOCOL', 'RELATED SRS'],
            rows: [['Identity provider', 'Outbound', 'OIDC', 'SRS-001']],
          },
        },
      ],
      when: (o) => on(o.includeDesign),
    },
    {
      path: '01-design/system-design.md',
      docType: 'SDD',
      titleEn: 'System Design Document',
      titleBm: 'Dokumen Reka Bentuk Sistem',
      purpose:
        'How the system is built: components, their responsibilities, and the ' +
        'decisions that constrain later change.',
      sections: [
        {
          heading: 'Architecture overview',
          guidance:
            'Show the components and their interactions as a diagram; keep the ' +
            'diagram source in diagrams/ beside the image.',
          table: {
            header: ['COMPONENT', 'RESPONSIBILITY', 'DEPENDS ON', 'DIAGRAM'],
            rows: [['Web front end', 'Capture and validate input', 'API', 'DIA-002']],
          },
        },
        {
          heading: 'Design decisions',
          table: {
            header: ['DECISION-ID', 'DECISION', 'RATIONALE', 'ALTERNATIVES REJECTED'],
            rows: [['DD-001', 'Stateless API', 'Horizontal scaling', 'Server sessions in memory']],
          },
        },
        {
          heading: 'Non-functional design targets',
          guidance:
            'Repeat the NFR ids this design is expected to satisfy, so a design ' +
            'change can be checked against them.',
          table: {
            header: ['NFR-ID', 'TARGET', 'HOW THE DESIGN MEETS IT'],
            rows: [['NFR-001', 'p95 < 2 s', 'Caching of reference data']],
          },
        },
      ],
      when: (o) => on(o.includeDesign),
    },
    {
      path: '01-design/data-model.md',
      docType: 'DMD',
      titleEn: 'Data Model and Data Dictionary',
      titleBm: 'Model Data dan Kamus Data',
      purpose:
        'Entities, relationships and every field with its type, length, nullability ' +
        'and validation rule — the reference a developer and a tester both work from.',
      sections: [
        {
          heading: 'Entities',
          table: {
            header: ['ENTITY', 'DESCRIPTION', 'KEY', 'RELATED SRS'],
            rows: [['Application', 'One submitted application', 'application_id', 'SRS-001']],
          },
        },
        {
          heading: 'Data dictionary',
          table: {
            header: ['TABLE', 'FIELD', 'TYPE', 'LENGTH', 'NULL', 'RULE'],
            rows: [['application', 'applicant_name', 'varchar', '120', 'No', 'Mandatory, trimmed']],
          },
        },
      ],
      when: (o) => on(o.includeDesign),
    },
    {
      path: '01-design/interface-specification.md',
      docType: 'IFS',
      titleEn: 'Interface Specification',
      titleBm: 'Spesifikasi Antara Muka',
      purpose:
        'Every integration point, its contract and its failure behaviour. An ' +
        'interface without a stated failure mode is an untested interface.',
      sections: [
        {
          heading: 'Interfaces',
          table: {
            header: ['IF-ID', 'SOURCE', 'TARGET', 'PROTOCOL', 'FREQUENCY', 'FAILURE BEHAVIOUR'],
            rows: [['IF-001', 'New system', 'Identity provider', 'OIDC', 'Per login', 'Deny access, log incident']],
          },
        },
        {
          heading: 'Message contracts',
          table: {
            header: ['IF-ID', 'FIELD', 'TYPE', 'MANDATORY', 'VALIDATION'],
            rows: [['IF-001', 'subject_id', 'string', 'Yes', 'Non-empty, max 128 chars']],
          },
        },
      ],
      when: (o) => on(o.includeDesign),
    },
    {
      path: '01-design/configuration-management.md',
      docType: 'CMP',
      titleEn: 'Configuration Management Plan',
      titleBm: 'Pelan Pengurusan Konfigurasi',
      purpose:
        'How versions, environments and releases are identified and controlled, so ' +
        'the artefact tested is the artefact deployed.',
      sections: [
        {
          heading: 'Configuration items',
          table: {
            header: ['CI', 'IDENTIFIER', 'STORED IN', 'VERSIONING'],
            rows: [['Source code', 'repository + commit sha', 'Git', 'Git tags per release']],
          },
        },
        {
          heading: 'Environments',
          table: {
            header: ['ENVIRONMENT', 'CODE', 'PURPOSE', 'REFRESH POLICY'],
            rows: [
              ['System integration test', 'SIT', 'Integration verification', 'Weekly from production-like data'],
              ['User acceptance test', 'UAT', 'Business acceptance', 'Per test cycle'],
            ],
          },
        },
      ],
      krisaOnly: true,
    },
    {
      path: '02-user-docs/user-manual.md',
      docType: 'USM',
      titleEn: 'User Manual',
      titleBm: 'Manual Pengguna',
      purpose:
        'Task-based instructions for the end user. Every task starts from what the ' +
        'user is trying to achieve, not from the menu structure.',
      sections: [
        {
          heading: 'Before you begin',
          bullets: [
            'Prerequisites: access rights, browser requirements, any data the user must have ready.',
            'Screenshots in this manual are registered in assets/media-register.csv with a FIG-id.',
          ],
        },
        {
          heading: 'Task: submit an application',
          numbered: [
            'Open the application form from the main menu.',
            'Complete all mandatory fields; mandatory fields are marked with an asterisk.',
            'Attach supporting documents, if required.',
            'Select Submit. A reference number is displayed — record it for follow-up.',
          ],
        },
        {
          heading: 'Figures',
          table: {
            header: ['FIGURE-ID', 'FILE', 'SHOWS'],
            rows: [['FIG-001', 'assets/img/FIG-001-application-form.png', 'Application form with mandatory fields']],
          },
        },
        {
          heading: 'Troubleshooting',
          table: {
            header: ['MESSAGE', 'MEANING', 'WHAT TO DO'],
            rows: [['Application already submitted', 'Duplicate submission attempt', 'Check the reference number before retrying']],
          },
        },
      ],
      when: (o) => on(o.includeUserDocs),
    },
    {
      path: '02-user-docs/administrator-guide.md',
      docType: 'ADG',
      titleEn: 'Administrator Guide',
      titleBm: 'Panduan Pentadbir Sistem',
      purpose:
        'The operational tasks an administrator performs: accounts, roles, ' +
        'reference data and periodic maintenance.',
      sections: [
        {
          heading: 'Roles and permissions',
          table: {
            header: ['ROLE', 'CAN DO', 'CANNOT DO'],
            rows: [['Administrator', 'Create users, assign roles', 'Approve applications']],
          },
        },
        {
          heading: 'Routine tasks',
          numbered: [
            'Create a user account and assign the minimum role required.',
            'Deactivate an account when a user leaves; never delete it.',
            'Review the audit log at the stated frequency.',
          ],
        },
      ],
      when: (o) => on(o.includeUserDocs),
    },
    {
      path: '02-user-docs/training-guide.md',
      docType: 'TRG',
      titleEn: 'Training Guide',
      titleBm: 'Panduan Latihan',
      purpose:
        'What each user group must be taught, in what order, with the exercise that ' +
        'proves the training worked.',
      sections: [
        {
          heading: 'Training plan',
          table: {
            header: ['GROUP', 'TOPICS', 'DURATION', 'EXERCISE'],
            rows: [['Applicants', 'Submit, track, withdraw', '1 hour', 'Submit a practice application']],
          },
        },
      ],
      when: (o) => on(o.includeUserDocs),
    },
    {
      path: '02-user-docs/faq.md',
      docType: 'FAQ',
      titleEn: 'Frequently Asked Questions',
      titleBm: 'Soalan Lazim',
      purpose:
        'Questions raised during UAT and training, answered once so support does ' +
        'not answer them repeatedly.',
      sections: [
        {
          heading: 'Questions',
          table: {
            header: ['QUESTION', 'ANSWER', 'RELATED DOCUMENT'],
            rows: [['How long is a decision valid?', 'State the rule', 'BRD 3.2']],
          },
        },
      ],
      when: (o) => on(o.includeUserDocs),
    },
    {
      path: '03-operations/deployment-guide.md',
      docType: 'DPG',
      titleEn: 'Deployment Guide',
      titleBm: 'Panduan Penggunaan (Deployment)',
      purpose:
        'How to install and deploy the release, with the checks that prove it worked ' +
        'and the steps that undo it.',
      sections: [
        {
          heading: 'Pre-deployment checks',
          bullets: [
            'The build artefact matches the version recorded in the test summary report.',
            'Database backup completed and verified.',
            'Change window approved and recorded in the change request log.',
          ],
        },
        {
          heading: 'Deployment steps',
          numbered: [
            'Deploy the artefact to the target environment.',
            'Run the database migration script.',
            'Verify the health endpoint returns success.',
            'Run the smoke test list below.',
          ],
        },
        {
          heading: 'Smoke tests',
          table: {
            header: ['CHECK', 'EXPECTED', 'EVIDENCE'],
            rows: [['Login as each role', 'Login succeeds', 'EVD-001']],
          },
        },
        {
          heading: 'Rollback',
          numbered: [
            'Stop the service.',
            'Restore the previous artefact version.',
            'Restore the database from the verified backup if the migration ran.',
            'Record the rollback in the change request log.',
          ],
        },
      ],
      when: (o) => on(o.includeRunbooks),
    },
    {
      path: '03-operations/ops-runbook.md',
      docType: 'RBK',
      titleEn: 'Operations Runbook',
      titleBm: 'Buku Panduan Operasi',
      purpose:
        'What to do when something is wrong at 2am: how to tell, who to call, and ' +
        'what to check first.',
      sections: [
        {
          heading: 'Alarms and responses',
          table: {
            header: ['ALARM', 'LIKELY CAUSE', 'FIRST CHECK', 'ESCALATE TO'],
            rows: [['Service unavailable', 'Process stopped', 'Health endpoint, service log', 'On-call lead']],
          },
        },
        {
          heading: 'Routine maintenance',
          table: {
            header: ['TASK', 'FREQUENCY', 'COMMAND / LOCATION', 'OWNER'],
            rows: [['Review logs for errors', 'Daily', 'Log location per environment', 'Operations']],
          },
        },
      ],
      when: (o) => on(o.includeRunbooks),
    },
    {
      path: '03-operations/release-notes.md',
      docType: 'RLN',
      titleEn: 'Release Notes',
      titleBm: 'Nota Keluaran',
      purpose:
        'What changed in each release, for whom, and what the user must do ' +
        'differently.',
      sections: [
        {
          heading: 'Releases',
          table: {
            header: ['VERSION', 'DATE', 'CHANGES', 'AFFECTED USERS', 'ACTION REQUIRED'],
            rows: [['1.0.0', 'YYYY-MM-DD', 'Initial release', 'All', 'None']],
          },
        },
      ],
      when: (o) => on(o.includeRunbooks),
    },
    {
      path: '04-api/api-reference.md',
      docType: 'API',
      titleEn: 'API Reference',
      titleBm: 'Rujukan API',
      purpose:
        'Every endpoint with its request, response, error codes and one worked ' +
        'example the integrator can paste.',
      sections: [
        {
          heading: 'Authentication',
          bullets: [
            'State the mechanism, the token lifetime and how a failure is reported.',
            'Never put a real credential in an example.',
          ],
        },
        {
          heading: 'Endpoints',
          table: {
            header: ['METHOD', 'PATH', 'PURPOSE', 'AUTH', 'RELATED IF-ID'],
            rows: [['POST', '/applications', 'Submit an application', 'Bearer', 'IF-001']],
          },
        },
        {
          heading: 'Error codes',
          table: {
            header: ['CODE', 'MEANING', 'CLIENT ACTION'],
            rows: [['400', 'Validation failure', 'Correct the payload and retry']],
          },
        },
      ],
      when: (o) => on(o.includeApiDocs),
    },
    {
      path: '04-api/integration-spec.md',
      docType: 'ITG',
      titleEn: 'Integration Specification',
      titleBm: 'Spesifikasi Integrasi',
      purpose:
        'How this system and the systems around it exchange data, including the ' +
        'failure and retry behaviour of each exchange.',
      sections: [
        {
          heading: 'Integrations',
          table: {
            header: ['IF-ID', 'PARTNER SYSTEM', 'DIRECTION', 'DATA', 'FAILURE HANDLING'],
            rows: [['IF-001', 'Identity provider', 'Outbound', 'Principal claims', 'Deny access and log']],
          },
        },
      ],
      when: (o) => on(o.includeApiDocs),
    },
    {
      path: '05-traceability/requirements-mapping.md',
      docType: 'RMAP',
      titleEn: 'Requirements to Documentation Mapping',
      titleBm: 'Pemetaan Keperluan kepada Dokumentasi',
      purpose:
        'Which requirement is described in which document section, so a change to ' +
        'a requirement leads straight to the pages that must be updated.',
      sections: [
        {
          heading: 'Mapping',
          table: {
            header: ['REQ-ID', 'DOCUMENT', 'SECTION', 'COVERED BY DIAGRAM'],
            rows: [['REQ-001', 'SRS', '3.2', 'DIA-002']],
          },
        },
      ],
      when: (o) => on(o.traceability),
    },
    ...commonDocs(),
  ];
}

/** Testing role. */
function testerDocs(): DocFileSpec[] {
  return [
    {
      path: '00-project-control/test-strategy.md',
      docType: 'TST',
      titleEn: 'Test Strategy',
      titleBm: 'Strategi Pengujian',
      purpose:
        'The testing approach for this project: what levels are tested, how, by ' +
        'whom, and what counts as enough evidence to sign off.',
      sections: [
        {
          heading: 'Test levels',
          table: {
            header: ['LEVEL', 'SCOPE', 'RESPONSIBLE', 'ENTRY CRITERIA', 'EXIT CRITERIA'],
            rows: [
              ['System test', 'End-to-end functions', 'Tester', 'Build deployed to SIT', 'No open critical defects'],
              ['UAT', 'Business acceptance', 'Business user', 'System test exit met', 'Signed UAT script'],
            ],
          },
        },
        {
          heading: 'Evidence standard',
          bullets: [
            'Every executed test case row carries a BUILD-VERSION, an ENVIRONMENT and an EXEC-ID.',
            'Each screenshot is a registered evidence file (EVD-###) with a SHA-256 hash recorded at capture time.',
            'A failed step records EXPECTED and ACTUAL; a screenshot alone is not a defect report.',
          ],
        },
        {
          heading: 'Environment codes',
          table: {
            header: ['CODE', 'ENVIRONMENT', 'USE'],
            rows: [
              ['SIT', 'System integration test', 'System testing'],
              ['UAT', 'User acceptance test', 'Business acceptance'],
            ],
          },
        },
      ],
    },
    {
      path: '01-test-planning/test-plan.md',
      docType: 'TPL',
      titleEn: 'Test Plan',
      titleBm: 'Pelan Pengujian',
      purpose:
        'Schedule, scope, resources and risks for the test cycle. The document the ' +
        'project manager tracks against.',
      sections: [
        {
          heading: 'Scope',
          table: {
            header: ['IN SCOPE', 'OUT OF SCOPE', 'RATIONALE'],
            rows: [['All functions in the FRS', 'Third-party provider outage handling', 'Verified by provider SLA']],
          },
        },
        {
          heading: 'Schedule',
          table: {
            header: ['PHASE', 'START', 'END', 'DEPENDENCY', 'OWNER'],
            rows: [['System test', 'YYYY-MM-DD', 'YYYY-MM-DD', 'SIT build', 'Tester']],
          },
        },
        {
          heading: 'Risks',
          table: {
            header: ['RISK', 'LIKELIHOOD', 'IMPACT', 'MITIGATION'],
            rows: [['Test data not representative', 'Medium', 'High', 'Anonymised production extract']],
          },
        },
      ],
    },
    {
      path: '01-test-planning/risk-based-test-approach.md',
      docType: 'RBT',
      titleEn: 'Risk-Based Test Approach',
      titleBm: 'Pendekatan Pengujian Berasaskan Risiko',
      purpose:
        'Where testing effort goes first, and why. Ties test depth to business risk ' +
        'rather than to module count.',
      sections: [
        {
          heading: 'Risk assessment',
          table: {
            header: ['AREA', 'LIKELIHOOD', 'IMPACT', 'SCORE', 'TEST DEPTH'],
            rows: [['Payment calculation', 'High', 'High', 'Critical', 'Exhaustive, boundary + negative']],
          },
        },
      ],
    },
    {
      path: '02-test-cases/test-scenarios.md',
      docType: 'TSC',
      titleEn: 'Test Scenarios',
      titleBm: 'Senario Ujian',
      purpose:
        'The scenarios to be covered at one line each, before they are broken into ' +
        'detailed test cases.',
      sections: [
        {
          heading: 'Scenarios',
          table: {
            header: ['SCENARIO-ID', 'SCENARIO', 'TRACES TO', 'PRIORITY'],
            rows: [['SCN-001', 'Submit a valid application', 'REQ-001', 'High']],
          },
        },
      ],
      when: (o) => on(o.includeTestCases),
    },
    {
      path: '02-test-cases/test-cases.md',
      docType: 'TCS',
      titleEn: 'Test Cases',
      titleBm: 'Kes Ujian',
      purpose:
        'Detailed executable steps with expected results, so two testers running ' +
        'the same case from the same build get the same verdict.',
      sections: [
        {
          heading: 'How to write a case here',
          bullets: [
            'One case per verifiable outcome; split a case that checks two things.',
            'Preconditions are what must already be true — never a step.',
            'Expected result is observable from the screen or the log; "works correctly" is not a result.',
            'Negative and boundary cases are first-class: a case that only proves the happy path proves little.',
          ],
        },
        {
          heading: 'Test cases',
          table: {
            header: [
              'TC-ID',
              'TITLE',
              'TRACES TO',
              'PRECONDITION',
              'STEPS',
              'EXPECTED RESULT',
              'PRIORITY',
            ],
            rows: [
              [
                'TC-001',
                'Submit a valid application',
                'REQ-001',
                'Applicant authenticated',
                '1. Open form. 2. Complete mandatory fields. 3. Submit.',
                'Reference number issued and displayed',
                'High',
              ],
              [
                'TC-002',
                'Submit with a missing mandatory field',
                'FR-001',
                'Applicant authenticated',
                '1. Open form. 2. Leave name empty. 3. Submit.',
                'Field-level error shown; application not saved',
                'High',
              ],
            ],
          },
        },
        {
          heading: 'Test data',
          table: {
            header: ['DATA-SET', 'DESCRIPTION', 'USED BY', 'LOCATION'],
            rows: [['TD-001', 'Valid applicant profile', 'TC-001', 'assets/test-data/td-001.md']],
          },
        },
      ],
      when: (o) => on(o.includeTestCases),
    },
    {
      path: '02-test-cases/traceability-test-cases.md',
      docType: 'TTC',
      titleEn: 'Requirement to Test Case Coverage',
      titleBm: 'Liputan Keperluan kepada Kes Ujian',
      purpose:
        'Proves every requirement has at least one test case, and names the ' +
        'requirements that do not.',
      sections: [
        {
          heading: 'Coverage',
          table: {
            header: ['REQ-ID', 'REQUIREMENT SUMMARY', 'TEST CASE(S)', 'COVERAGE STATUS'],
            rows: [['REQ-001', 'Submit application online', 'TC-001, TC-002', 'Covered']],
          },
        },
      ],
      when: (o) => on(o.includeTestCases),
    },
    {
      path: '03-uat/uat-plan.md',
      docType: 'UAP',
      titleEn: 'User Acceptance Test Plan',
      titleBm: 'Pelan Ujian Penerimaan Pengguna',
      purpose:
        'Who accepts the system, against which business scenarios, with what ' +
        'evidence, and on what date.',
      sections: [
        {
          heading: 'Participants',
          table: {
            header: ['NAME', 'UNIT', 'ROLE IN UAT', 'SCENARIOS'],
            rows: [['TBC', 'Operations', 'Business tester', 'UAT-001']],
          },
        },
        {
          heading: 'Entry and exit criteria',
          table: {
            header: ['CRITERIA TYPE', 'CRITERIA'],
            rows: [
              ['Entry', 'System test exit met; no open critical defects'],
              ['Exit', 'All UAT scenarios executed; no open critical or high defects; sign-off signed'],
            ],
          },
        },
      ],
      when: (o) => on(o.includeUat),
    },
    {
      path: '03-uat/uat-script.md',
      docType: 'UAS',
      titleEn: 'UAT Script',
      titleBm: 'Skrip UAT',
      purpose:
        'The script the business user follows, written in business language and ' +
        'traceable to a requirement.',
      sections: [
        {
          heading: 'Script',
          table: {
            header: ['UAT-ID', 'BUSINESS SCENARIO', 'TRACES TO', 'STEPS', 'EXPECTED', 'RESULT'],
            rows: [
              [
                'UAT-001',
                'Applicant submits and receives a reference number',
                'REQ-001',
                '1. Log in. 2. Submit a complete application.',
                'Reference number displayed',
                'Not Run',
              ],
            ],
          },
        },
      ],
      when: (o) => on(o.includeUat),
    },
    {
      path: '03-uat/uat-signoff.md',
      docType: 'UASO',
      titleEn: 'UAT Sign-off',
      titleBm: 'Pengesahan UAT',
      purpose:
        'The acceptance record: what was executed, what remains open, and who ' +
        'accepted the system.',
      sections: [
        {
          heading: 'Summary',
          table: {
            header: ['METRIC', 'VALUE'],
            rows: [
              ['Scenarios planned', '0'],
              ['Scenarios executed', '0'],
              ['Passed', '0'],
              ['Open defects (critical / high)', '0 / 0'],
            ],
          },
        },
        {
          heading: 'Declarations',
          table: {
            header: ['NAME', 'ROLE', 'DECISION', 'DATE', 'SIGNATURE'],
            rows: [['TBC', 'Business owner', 'Accepted / Accepted with conditions / Rejected', 'YYYY-MM-DD', '']],
          },
        },
        {
          heading: 'Conditions and open items',
          bullets: [
            'List every condition attached to acceptance, each with an owner and a date.',
            'An open defect accepted into production is recorded here, not only in the defect log.',
          ],
        },
      ],
      when: (o) => on(o.includeUat),
    },
    {
      path: '04-defects/defect-log.md',
      docType: 'DFL',
      titleEn: 'Defect Log',
      titleBm: 'Log Kecacatan',
      purpose:
        'Every defect found, its severity, its link back to the failing execution, ' +
        'and its resolution.',
      sections: [
        {
          heading: 'Severity definitions',
          table: {
            header: ['SEVERITY', 'MEANING', 'RESPONSE'],
            rows: [
              ['Critical', 'Business cannot proceed; no workaround', 'Fix before any further testing'],
              ['High', 'Major function fails; workaround exists', 'Fix before UAT exit'],
              ['Medium', 'Function impaired but usable', 'Fix before release or accept with condition'],
              ['Low', 'Cosmetic or minor', 'Schedule at convenience'],
            ],
          },
        },
        {
          heading: 'Defects',
          table: {
            header: [
              'DEF-ID',
              'TITLE',
              'SEVERITY',
              'FOUND IN EXEC',
              'TRACES TO',
              'STATUS',
              'FIXED IN VERSION',
            ],
            rows: [
              [
                'DEF-001',
                'Reference number not displayed after submit',
                'High',
                'EX-0004',
                'TC-001',
                'Open',
                '',
              ],
            ],
          },
        },
      ],
      when: (o) => on(o.defectManagement),
    },
    {
      path: '04-defects/defect-triage.md',
      docType: 'DTR',
      titleEn: 'Defect Triage Process',
      titleBm: 'Proses Triaj Kecacatan',
      purpose:
        'How a defect is classified, prioritised and decided on, so severity is not ' +
        'negotiated case by case.',
      sections: [
        {
          heading: 'Triage steps',
          numbered: [
            'Confirm the defect is reproducible and record the execution id.',
            'Assign severity using the definitions in the defect log.',
            'Decide: fix now, fix later, or accept with a recorded condition.',
            'Record the decision and the owner in the defect log.',
          ],
        },
        {
          heading: 'Decision vocabulary',
          table: {
            header: ['DECISION', 'MEANING', 'RECORDED WHERE'],
            rows: [['Accept', 'Known limitation released with the business aware', 'Defect log + UAT sign-off conditions']],
          },
        },
      ],
      when: (o) => on(o.defectManagement),
    },
    {
      path: '05-traceability/rtm.md',
      docType: 'RTM',
      titleEn: 'Requirements Traceability Matrix',
      titleBm: 'Matriks Kebolehkesanan Keperluan',
      purpose:
        'One row per requirement with the test cases that cover it and the current ' +
        'UAT verdict — the tester half of the join with the BA project.',
      sections: [
        {
          heading: 'How this joins the other projects',
          bullets: [
            'Requirement ids come from the BA project; never invent a new one here.',
            'rtm.csv uses the shared column contract, so appending the BA file below this one stays aligned.',
            'UAT-STATUS uses the same vocabulary as RESULT in the evidence register.',
          ],
        },
        {
          heading: 'Matrix',
          table: {
            header: [
              'REQ-ID',
              'TITLE',
              'SOURCE',
              'ADO-WORK-ITEM',
              'DESIGN-REF',
              'TEST-CASE',
              'UAT-STATUS',
              'STATUS',
            ],
            rows: [
              [
                'REQ-001',
                'Submit application online',
                'BA project',
                'TBC',
                'SRS 3.2',
                'TC-001',
                'Not Run',
                'Draft',
              ],
            ],
          },
        },
      ],
      when: (o) => on(o.traceability),
    },
    {
      path: '06-evidence/test-summary-report.md',
      docType: 'TSR',
      titleEn: 'Test Summary Report',
      titleBm: 'Laporan Ringkasan Pengujian',
      purpose:
        'The closure report: what was executed, what passed, what remains open, and ' +
        'the quality statement the sign-off relies on.',
      sections: [
        {
          heading: 'Execution summary',
          guidance:
            'Populate from the evidence register; do not retype counts by hand. ' +
            'Every number here must be reproducible from the register.',
          table: {
            header: ['METRIC', 'PLANNED', 'EXECUTED', 'PASSED', 'FAILED', 'BLOCKED'],
            rows: [['System test cases', '0', '0', '0', '0', '0']],
          },
        },
        {
          heading: 'Defect summary',
          table: {
            header: ['SEVERITY', 'RAISED', 'CLOSED', 'OPEN'],
            rows: [['Critical', '0', '0', '0']],
          },
        },
        {
          heading: 'Deviations from plan',
          bullets: [
            'Every skipped test case is listed with a reason — an unexplained gap is a finding.',
            'Every accepted defect is referenced by DEF-id.',
          ],
        },
        {
          heading: 'Conclusion',
          guidance:
            'State whether the exit criteria were met, and if not, exactly which ' +
            'criterion is outstanding.',
        },
      ],
      krisaOnly: true,
    },
    {
      path: '06-evidence/security-test-report.md',
      docType: 'SEC',
      titleEn: 'Security Test Report',
      titleBm: 'Laporan Ujian Keselamatan',
      purpose:
        'Evidence that access control, input handling and audit logging were ' +
        'actually tested, not assumed.',
      sections: [
        {
          heading: 'Checks performed',
          table: {
            header: ['SEC-ID', 'CHECK', 'METHOD', 'EXPECTED', 'RESULT', 'EVIDENCE'],
            rows: [
              [
                'SEC-001',
                'Role cannot access another role function',
                'Direct URL attempt with lower-privilege account',
                'Access denied and attempt logged',
                'Not Run',
                'EVD-000',
              ],
            ],
          },
        },
        {
          heading: 'Findings',
          table: {
            header: ['FINDING-ID', 'DESCRIPTION', 'SEVERITY', 'STATUS', 'DEFECT'],
            rows: [['SECF-001', 'Describe the finding', 'High', 'Open', 'DEF-000']],
          },
        },
      ],
      when: (o) => on(o.includeSecurity, false) || (o.governance ?? '') === 'KRiSA (Government)',
    },
    ...(function performanceDocs(): DocFileSpec[] {
      return [
        {
          path: '06-evidence/performance-test-report.md',
          docType: 'PER',
          titleEn: 'Performance Test Report',
          titleBm: 'Laporan Ujian Prestasi',
          purpose:
            'Measured performance against the non-functional targets, with the ' +
            'conditions the measurement was taken under.',
          sections: [
            {
              heading: 'Results',
              table: {
                header: ['NFR-ID', 'TARGET', 'MEASURED', 'CONDITION', 'VERDICT'],
                rows: [['NFR-001', 'p95 < 2 s', 'TBC', '50 concurrent users', 'Not Run']],
              },
            },
          ],
          when: (o) => on(o.includePerformance, false),
        },
      ];
    })(),
    ...commonDocs(),
  ];
}

export const DOC_PROJECT_SPECS: Record<string, DocProjectSpec> = {
  'doc-ba': {
    templateId: 'doc-ba',
    role: 'BA',
    roleCode: 'BA',
    templateName: 'Business Analysis',
    docSet: baDocs(),
  },
  'doc-writer': {
    templateId: 'doc-writer',
    role: 'Writer',
    roleCode: 'TW',
    templateName: 'IT Documentation',
    docSet: writerDocs(),
  },
  'doc-tester': {
    templateId: 'doc-tester',
    role: 'Tester',
    roleCode: 'TS',
    templateName: 'Test & UAT',
    docSet: testerDocs(),
  },
};

/** Files actually written for a given option set. */
export function selectDocFiles(
  spec: DocProjectSpec,
  options: DocOptions
): DocFileSpec[] {
  const krisa = (options.governance ?? 'Standard') === 'KRiSA (Government)';
  return spec.docSet.filter((file) => {
    if (file.krisaOnly && !krisa) {
      return false;
    }
    return file.when ? file.when(options) : true;
  });
}

export interface FrontMatterContext {
  docId: string;
  title: string;
  version: string;
  status: string;
  owner: string;
  approver: string;
  classification: string;
  lang: DocLang;
  project: string;
  date: string;
}

/**
 * YAML front matter in the exact key vocabulary `docBlocks.ts` accepts.
 * English keys are the default; Bahasa Malaysia documents use the BM aliases so
 * a BM-only project reads correctly to its own reviewers.
 */
export function renderFrontMatter(
  ctx: FrontMatterContext,
  language: DocLang
): string {
  const bm = language === 'ms';
  const key = {
    docId: bm ? 'id-dokumen' : 'doc-id',
    title: bm ? 'tajuk' : 'title',
    version: bm ? 'versi' : 'version',
    status: bm ? 'status' : 'status',
    owner: bm ? 'pemilik-dokumen' : 'owner',
    approver: bm ? 'pelulus' : 'approver',
    classification: bm ? 'klasifikasi' : 'classification',
    lang: bm ? 'bahasa' : 'lang',
    project: 'project',
    date: 'date',
  };
  const quote = (value: string) =>
    /[:#]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  return [
    '---',
    `${key.docId}: ${quote(ctx.docId)}`,
    `${key.title}: ${quote(ctx.title)}`,
    `${key.version}: ${quote(ctx.version)}`,
    `${key.status}: ${quote(ctx.status)}`,
    `${key.owner}: ${quote(ctx.owner)}`,
    `${key.approver}: ${quote(ctx.approver)}`,
    `${key.classification}: ${quote(ctx.classification)}`,
    `${key.lang}: ${quote(ctx.lang)}`,
    `${key.project}: ${quote(ctx.project)}`,
    `${key.date}: ${quote(ctx.date)}`,
    '---',
  ].join('\n');
}

/** Body of one generated document (no front matter). */
export function renderDocBody(spec: DocFileSpec, title: string, inputsFolder?: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}`, '');
  lines.push(spec.purpose, '');
  for (const section of spec.sections) {
    lines.push(`## ${section.heading}`, '');
    if (section.guidance) {
      lines.push(section.guidance, '');
    }
    if (section.bullets?.length) {
      for (const bullet of section.bullets) {
        lines.push(`- ${bullet}`);
      }
      lines.push('');
    }
    if (section.numbered?.length) {
      section.numbered.forEach((step, index) => {
        lines.push(`${index + 1}. ${step}`);
      });
      lines.push('');
    }
    if (section.table) {
      for (const line of markdownTableHeader(section.table.header)) {
        lines.push(line);
      }
      for (const row of section.table.rows) {
        lines.push(`| ${row.join(' | ')} |`);
      }
      lines.push('');
    }
  }
  if (inputsFolder) {
    lines.push('## Source inputs', '');
    lines.push(
      `Raw material for this document lives in \`${inputsFolder}/\`. Log every item in \`inputs/source-register.csv\` and cite its INPUT-ID on the requirement or finding it justifies.`
    );
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * KRiSA artefact catalogue.
 *
 * Kept as DATA, not prose, for one reason: every `guidelineRef` below ships as
 * "TODO — confirm clause" because this project has no network access to read
 * the guideline itself. Nothing generated from this file may be labelled
 * "KRiSA-compliant" until those references are filled in against the real
 * document at KRISA_GUIDELINE_URL. Correcting them is a single-file edit.
 *
 * Each role project renders only its OWN rows into its compliance matrix, so a
 * BA project tracks BA artefacts and the tester project tracks test artefacts —
 * collectively the full set, without three projects each claiming to own
 * everything.
 */

export const KRISA_GUIDELINE_URL =
  'https://sqa.jdn.gov.my/index.php/ms/garis-panduan/garis-panduan-pembangunan-aplikasi-krisa-versi-beta-2026';

export type DocRole = 'BA' | 'Writer' | 'Tester';

export type KrisaPhase =
  | 'Initiation'
  | 'Requirements'
  | 'Design'
  | 'Development'
  | 'Test'
  | 'Security'
  | 'UAT'
  | 'Deployment'
  | 'Post-Implementation';

export interface KrisaArtefact {
  /** Stable id, e.g. K-BA-03. */
  id: string;
  titleEn: string;
  titleBm: string;
  phase: KrisaPhase;
  owner: DocRole;
  /** Where the artefact lives, relative to the project root. */
  path: string;
  /** Clause / section of the guideline. Always TODO until confirmed. */
  guidelineRef: string;
}

export const KRISA_REF_PENDING = 'TODO — confirm clause';

function artefact(
  id: string,
  titleEn: string,
  titleBm: string,
  phase: KrisaPhase,
  owner: DocRole,
  path: string
): KrisaArtefact {
  return { id, titleEn, titleBm, phase, owner, path, guidelineRef: KRISA_REF_PENDING };
}

export const KRISA_ARTEFACTS: KrisaArtefact[] = [
  // ── Business analysis ────────────────────────────────────────────────
  artefact('K-BA-01', 'Project Charter', 'Piagam Projek', 'Initiation', 'BA', '00-project-control/project-charter.md'),
  artefact('K-BA-02', 'Stakeholder Register', 'Daftar Pemegang Taruh', 'Requirements', 'BA', '01-business-analysis/stakeholder-register.md'),
  artefact('K-BA-03', 'Business Requirements Specification', 'Spesifikasi Keperluan Bisnes', 'Requirements', 'BA', '01-business-analysis/brs.md'),
  artefact('K-BA-04', 'Business Process Model (As-Is)', 'Model Proses Bisnes (As-Is)', 'Requirements', 'BA', '01-process/process-as-is.md'),
  artefact('K-BA-05', 'Business Process Model (To-Be)', 'Model Proses Bisnes (To-Be)', 'Requirements', 'BA', '01-process/process-to-be.md'),
  artefact('K-BA-06', 'Functional Requirements Specification', 'Spesifikasi Keperluan Fungsian', 'Requirements', 'BA', '01-business-analysis/functional-requirements.md'),
  artefact('K-BA-07', 'Non-Functional Requirements Catalogue', 'Katalog Keperluan Bukan Fungsian', 'Requirements', 'BA', '02-requirements/non-functional-requirements.md'),
  artefact('K-BA-08', 'Requirements Traceability Matrix', 'Matriks Kebolehkesanan Keperluan', 'Requirements', 'BA', '05-traceability/rtm.md'),
  artefact('K-BA-09', 'Change Request Register', 'Daftar Permohonan Perubahan', 'Post-Implementation', 'BA', '06-change-control/change-request-log.md'),

  // ── Technical writing ───────────────────────────────────────────────
  artefact('K-WR-01', 'System Requirements Specification', 'Spesifikasi Keperluan Sistem', 'Design', 'Writer', '01-design/srs.md'),
  artefact('K-WR-02', 'System Design Document', 'Dokumen Reka Bentuk Sistem', 'Design', 'Writer', '01-design/system-design.md'),
  artefact('K-WR-03', 'Data Model and Data Dictionary', 'Model Data dan Kamus Data', 'Design', 'Writer', '01-design/data-model.md'),
  artefact('K-WR-04', 'Interface Specification', 'Spesifikasi Antara Muka', 'Design', 'Writer', '01-design/interface-specification.md'),
  artefact('K-WR-05', 'Configuration Management Plan', 'Pelan Pengurusan Konfigurasi', 'Development', 'Writer', '01-design/configuration-management.md'),
  artefact('K-WR-06', 'User Manual', 'Manual Pengguna', 'Deployment', 'Writer', '02-user-docs/user-manual.md'),
  artefact('K-WR-07', 'Administrator Guide', 'Panduan Pentadbir Sistem', 'Deployment', 'Writer', '02-user-docs/administrator-guide.md'),
  artefact('K-WR-08', 'Training Guide', 'Panduan Latihan', 'Deployment', 'Writer', '02-user-docs/training-guide.md'),

  // ── Testing ─────────────────────────────────────────────────────────
  artefact('K-TS-01', 'Test Strategy', 'Strategi Pengujian', 'Test', 'Tester', '00-project-control/test-strategy.md'),
  artefact('K-TS-02', 'Test Plan', 'Pelan Pengujian', 'Test', 'Tester', '01-test-planning/test-plan.md'),
  artefact('K-TS-03', 'Test Cases', 'Kes Ujian', 'Test', 'Tester', '02-test-cases/test-cases.md'),
  artefact('K-TS-04', 'Test Evidence Register', 'Daftar Bukti Ujian', 'Test', 'Tester', '04-defects/test-evidence-register.csv'),
  artefact('K-TS-05', 'Defect Log', 'Log Kecacatan', 'Test', 'Tester', '04-defects/defect-log.md'),
  artefact('K-TS-06', 'Security Test Report', 'Laporan Ujian Keselamatan', 'Security', 'Tester', '06-evidence/security-test-report.md'),
  artefact('K-TS-07', 'User Acceptance Test Plan', 'Pelan Ujian Penerimaan Pengguna', 'UAT', 'Tester', '03-uat/uat-plan.md'),
  artefact('K-TS-08', 'UAT Sign-off', 'Pengesahan UAT', 'UAT', 'Tester', '03-uat/uat-signoff.md'),
  artefact('K-TS-09', 'Test Summary Report', 'Laporan Ringkasan Pengujian', 'Deployment', 'Tester', '06-evidence/test-summary-report.md'),
];

/** The rows a given role project is accountable for. */
export function krisaArtefactsForRole(role: DocRole): KrisaArtefact[] {
  return KRISA_ARTEFACTS.filter((a) => a.owner === role);
}

/** Artefacts whose owning file lives under a KRiSA-only path. */
export function isKrisaOnlyPath(relativePath: string): boolean {
  return KRISA_ARTEFACTS.some(
    (a) => a.path === relativePath && a.phase === 'Security'
  );
}

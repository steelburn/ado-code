/**
 * DocumentationExportBar — the export action for a documentation project.
 *
 * Shown right after the wizard creates a `doc-*` project, because that is the
 * only moment the webview knows which project (and which documents) the user
 * cares about without a second browsing UI. Rendering happens here in the
 * webview (docx / fflate / canvas); the host only supplies bytes and saves.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { runDocumentationExport, type ExportOutcome } from '../export/documentationExport';
import type { DocumentationExportFormat } from '../../../shared/documentation/exportPayload';

export interface DocumentationExportBarProps {
  projectName: string;
  projectPath: string;
  documents: string[];
  onDismiss(): void;
}

/** Prefer the first real document; README only as a last resort. */
function defaultDocument(documents: readonly string[]): string {
  const markdown = documents.filter((doc) => /\.md$/i.test(doc));
  return markdown.find((doc) => !/(^|\/)readme\.md$/i.test(doc)) ?? markdown[0] ?? '';
}

const FORMAT_LABELS: Record<DocumentationExportFormat, string> = {
  docx: 'Word (.docx)…',
  xlsx: 'Registers (.xlsx)…',
  'diagram-png': 'Diagram (.png)…',
};

export function DocumentationExportBar({
  projectName,
  projectPath,
  documents,
  onDismiss,
}: DocumentationExportBarProps): JSX.Element {
  const markdown = useMemo(() => documents.filter((doc) => /\.md$/i.test(doc)), [documents]);
  const [selected, setSelected] = useState(() => defaultDocument(documents));
  const [busy, setBusy] = useState<DocumentationExportFormat | null>(null);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);

  const run = useCallback(
    async (format: DocumentationExportFormat) => {
      setBusy(format);
      setOutcome(null);
      try {
        const result = await runDocumentationExport({
          projectPath,
          documentPath: format === 'xlsx' ? undefined : selected,
          format,
        });
        setOutcome(result);
      } finally {
        setBusy(null);
      }
    },
    [projectPath, selected],
  );

  const needsDocument = markdown.length > 0;

  return (
    <div className="doc-export">
      <div className="doc-export__head">
        <span className="doc-export__title" title={projectPath}>
          📘 {projectName} — documentation
        </span>
        <button type="button" className="doc-export__close" title="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>

      <div className="doc-export__row">
        {needsDocument && (
          <>
            <label className="doc-export__label" htmlFor="doc-export-document">
              Document
            </label>
            <select
              id="doc-export-document"
              className="doc-export__select"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {markdown.map((doc) => (
                <option key={doc} value={doc}>
                  {doc}
                </option>
              ))}
            </select>
          </>
        )}
        {(['docx', 'xlsx', 'diagram-png'] as DocumentationExportFormat[]).map((format) => {
          const needsTarget = format !== 'xlsx';
          return (
            <button
              key={format}
              type="button"
              className="doc-export__action"
              disabled={busy !== null || (needsTarget && !selected)}
              title={
                format === 'diagram-png'
                  ? 'Rasterises the first mermaid diagram in the selected document'
                  : undefined
              }
              onClick={() => void run(format)}
            >
              {busy === format ? 'Working…' : FORMAT_LABELS[format]}
            </button>
          );
        })}
      </div>

      {outcome && (
        <div className={`doc-export__outcome ${outcome.ok ? 'is-ok' : 'is-error'}`}>
          <span>{outcome.message}</span>
          {outcome.warnings.length > 0 && (
            <ul className="doc-export__warnings">
              {outcome.warnings.slice(0, 4).map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
              {outcome.warnings.length > 4 && (
                <li>…and {outcome.warnings.length - 4} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pure helpers for the chat-area declutter strategy — item 3
 * ("Show a message's attachments as chips instead of re-serializing the file
 * bodies into the bubble").
 *
 * The host still receives every file body (they are prepended to the message the
 * model sees, as `[File: name] … [/file]` blocks). This only compresses what the
 * *user* sees: live sends carry compact `[Attached: name]` markers (mirroring
 * the existing `[Image: name]` display markers), while older sessions persisted
 * the heavier `[File: …]` blocks — so both forms are recognized and folded to a
 * plain list of names.
 *
 * Framework-free so it can be unit-tested from the host test suite; the webview
 * imports it across the build-root boundary (see src/webview-ui/tsconfig.json).
 */

/** `[Attached: name]` — the compact marker the webview now writes for display. */
const ATTACHED_MARKER = /\[Attached:\s*([^\]]+?)\s*\]/g;
/** Legacy `[File: name]\n<body>\n[/file]` block persisted in older sessions. */
const FILE_BLOCK = /\[File:\s*([^\n\]]+)\]\s*\n[\s\S]*?\[\/file\][^\S\n]*/g;

export interface SplitAttachments {
  /** Attachment file names, in the order they appeared. */
  names: string[];
  /** The display content with every attachment marker/block removed. */
  body: string;
}

/**
 * Pull attachment names out of a user message and return the remaining body.
 * Recognizes both `[Attached: name]` markers and legacy `[File: name]` blocks.
 * Content with no recognizable attachment is returned verbatim.
 */
export function splitAttachments(content: string): SplitAttachments {
  if (!content) {
    return { names: [], body: '' };
  }

  const seen: string[] = [];
  let body = content
    .replace(FILE_BLOCK, (_match, name: string) => {
      seen.push(String(name).trim());
      return '';
    })
    .replace(ATTACHED_MARKER, (_match, name: string) => {
      seen.push(String(name).trim());
      return '';
    });

  const names = seen.filter(Boolean);
  if (names.length === 0) {
    return { names: [], body: content };
  }

  // Collapse the whitespace gap left behind where a block/marker sat.
  body = body
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { names, body };
}

/** Chip noun phrase for a set of attachments, e.g. "3 files" / "1 file". */
export function attachmentChipLabel(names: string[]): string {
  const count = names.length;
  if (count <= 0) {
    return '';
  }
  return count === 1 ? '1 file' : `${count} files`;
}

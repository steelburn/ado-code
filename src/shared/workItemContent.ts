/**
 * Work item content helpers — two papercuts that both poisoned freshly created
 * items:
 *
 * 1. Agents like to "record" a work item's detail a second time as a discussion
 *    comment, so brand-new items carried a comment that merely restated their
 *    own description. `isWorkItemEchoComment` detects that echo so the
 *    `add_comment` tool can drop it instead of writing it.
 * 2. A description frequently arrives with its own "Acceptance Criteria"
 *    section even though ADO has a dedicated field for it. That section ended up
 *    duplicated (field + description) or was silently truncated away by the
 *    draft parser. `splitAcceptanceCriteria` moves it into the field.
 */

const ECHO_MIN_CHARS = 120;
const ECHO_MIN_EXACT_CHARS = 20;
const ECHO_MIN_RATIO = 0.8;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Collapse markdown/HTML rich text to a comparable token stream: tags and
 * entities removed, case folded, punctuation and whitespace normalised.
 */
export function normalizeRichText(text: string): string {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/gi, entity => ENTITIES[entity.toLowerCase()] ?? ' ')
    .toLowerCase()
    .replace(/(^|\s)[-*+•]\s+/g, '$1')
    .replace(/[`*_>#|[\]()~"'’]/g, ' ')
    .replace(/[.,;:!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `commentText` only restates one of `bodies` (a work item's
 * description and/or acceptance criteria). Deliberately conservative: short
 * comments never qualify, and containment only counts when the shorter text is
 * at least 80% of the longer one.
 */
export function isWorkItemBodyEcho(
  commentText: string,
  ...bodies: Array<string | undefined | null>
): boolean {
  const comment = normalizeRichText(commentText);
  if (comment.length < ECHO_MIN_EXACT_CHARS) return false;

  return bodies.some(body => {
    const target = normalizeRichText(String(body ?? ''));
    if (!target) return false;
    // Verbatim repeat of the body — no length heuristic needed beyond keeping
    // one-word comments ("thanks") out of it.
    if (comment === target) return true;
    if (comment.length < ECHO_MIN_CHARS || target.length < ECHO_MIN_CHARS) return false;
    const shorter = Math.min(comment.length, target.length);
    const longer = Math.max(comment.length, target.length);
    if (shorter / longer < ECHO_MIN_RATIO) return false;
    return comment.includes(target) || target.includes(comment);
  });
}

/** Convenience wrapper over an ADO field pair. */
export function isWorkItemEchoComment(
  commentText: string,
  workItem: { description?: string; acceptanceCriteria?: string } | null | undefined,
): boolean {
  if (!workItem) return false;
  const combined = [workItem.description, workItem.acceptanceCriteria]
    .filter(part => !!part && String(part).trim().length > 0)
    .join('\n');
  return isWorkItemBodyEcho(commentText, workItem.description, workItem.acceptanceCriteria, combined);
}

/** Strips a checkbox/bold/colon decoration and compares against AC labels. */
function isAcceptanceLabel(text: string): boolean {
  const cleaned = String(text ?? '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/[:_\s\-–—]+$/, '')
    .trim()
    .toLowerCase();
  return cleaned === 'acceptance criteria'
    || cleaned === 'acceptance criterion'
    || cleaned === 'acceptance criterias'
    || cleaned === 'ac';
}

/**
 * Level of an "Acceptance Criteria" heading, or null when the line is not one.
 * A markdown heading keeps its own level; a bold-only or plain label behaves
 * like level 0 (it runs until the next heading of any level).
 */
function acceptanceHeadingLevel(line: string): number | null {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || trimmed.length > 80) return null;
  const hash = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (hash) return isAcceptanceLabel(hash[2]) ? hash[1].length : null;
  const bold = /^\*\*([^*]+)\*\*\s*:?$/.exec(trimmed);
  if (bold) return isAcceptanceLabel(bold[1]) ? 0 : null;
  if (/^\[[ xX]\]/.test(trimmed)) {
    return isAcceptanceLabel(trimmed.replace(/^\[[ xX]\]/, '')) ? 0 : null;
  }
  return isAcceptanceLabel(trimmed) ? 0 : null;
}

/** Level of any section break, or null for ordinary body lines. */
function headingLevelOf(line: string): number | null {
  const trimmed = String(line ?? '').trim();
  const hash = /^(#{1,6})\s+\S/.exec(trimmed);
  if (hash) return hash[1].length;
  if (/^\*\*[^*]+\*\*\s*:?$/.test(trimmed)) return 0;
  return null;
}

export interface WorkItemContent {
  description: string;
  acceptanceCriteria: string;
}

/**
 * Move an "Acceptance Criteria" section out of a description body and into the
 * acceptance-criteria field. Idempotent: a description without such a section
 * comes back trimmed and unchanged.
 *
 * When both a provided AC value and an embedded section exist and they differ,
 * the provided value wins and the section body is appended so nothing is lost.
 */
export function splitAcceptanceCriteria(
  description?: string,
  acceptanceCriteria?: string,
): WorkItemContent {
  const desc = String(description ?? '');
  const provided = String(acceptanceCriteria ?? '').trim();
  const lines = desc.split(/\r?\n/);

  const start = lines.findIndex(line => acceptanceHeadingLevel(line) !== null);
  if (start < 0) {
    return { description: desc.trim(), acceptanceCriteria: provided };
  }

  const level = acceptanceHeadingLevel(lines[start]) ?? 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const lineLevel = headingLevelOf(lines[i]);
    if (lineLevel !== null && (level === 0 || lineLevel <= level)) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start + 1, end).join('\n').trim();
  const rest = [...lines.slice(0, start), ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let merged = provided;
  if (section) {
    if (!merged) {
      merged = section;
    } else if (normalizeRichText(merged) !== normalizeRichText(section)) {
      merged = `${merged}\n\n${section}`;
    }
  }

  return { description: rest, acceptanceCriteria: merged };
}

/**
 * Field-level wrapper used by the create-work-item paths. A field that was
 * absent stays absent (an empty description is not written at all), so the
 * caller's create semantics are untouched when no AC section is present.
 */
export function normalizeWorkItemContent<T extends { description?: string; acceptanceCriteria?: string }>(
  fields: T,
): T {
  if (!fields.description || !fields.description.trim()) return fields;
  const moved = splitAcceptanceCriteria(fields.description, fields.acceptanceCriteria);
  return {
    ...fields,
    description: moved.description,
    acceptanceCriteria: moved.acceptanceCriteria || fields.acceptanceCriteria,
  };
}

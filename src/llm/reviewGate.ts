// Review gate (AI-engineering roadmap #3).
//
// Roadmap #2 (reflection.ts) taught the loop to recover from a halt it can SEE:
// a repetitive-call heuristic tripped, or the iteration budget ran out. The
// failure that remains is the mirror image — the loop stops CLEANLY. The model
// returns text with no tool calls, the harness has nothing left to run, and the
// turn is reported as finished. Nothing in the loop ever looked at what the turn
// produced, so "the turn ended" was silently treated as "the work is right":
//
//   - a half-applied multi-file edit (one file updated, its callers not),
//   - a stub or TODO left behind and then summarized as done,
//   - a rename that never reached the type declarations,
//   - a claim in the final message that the diff does not actually contain.
//
// All of those finish cleanly. No heuristic can catch them, because the trace
// looks perfect — the defect is in the ARTEFACT.
//
// So this gate spends exactly ONE round-trip on the artefact instead of the
// trace. The conversation tells the model what it meant to do; only the diff
// tells it what it actually did. Everything here is pure (no vscode, no fs): the
// host supplies the diff text and the verdict is parsed back into a decision the
// loop can act on.
//
// Two invariants, both inherited from the reflection turn and both worth more
// than any tuning of the prompt:
//
//  1. THE GATE CAN NEVER MAKE A TURN WORSE. No diff, an aborted run, a provider
//     error, an unparseable reply — every one of those means "accept the finish",
//     which is exactly the behaviour that existed before this file. Only an
//     explicit, actionable `revise` changes anything.
//  2. A REVISE MUST NAME ITS FIX. Asking to revise without a next step just
//     resumes the same strategy that produced the diff, burns the bonus budget
//     and finishes in the same place. A plan-less revise is downgraded to a ship.

/** Extra iterations unlocked by an actionable revise — bounded, like reflection. */
export const REVIEW_BONUS_ITERATIONS = 6;

/** Cap on the diff handed to the review turn (≈3k tokens). */
export const MAX_REVIEW_DIFF_CHARS = 12_000;

export interface ReviewInput {
  diff: string;
  files: readonly string[];
  /** True when the diff was too large and only head + tail are shown. */
  truncated: boolean;
}

export type ReviewDecision = 'ship' | 'revise' | 'unknown';

export interface ReviewVerdict {
  verdict: ReviewDecision;
  /** The single concrete defect the reviewer named. */
  issue?: string;
  /** The fix that makes the verdict actionable. */
  nextStep?: string;
}

/** Verdict words that accept the change. */
const SHIP_WORDS = ['ship', 'accept', 'accepted', 'ok', 'okay', 'lgtm', 'pass', 'passes', 'approve', 'approved', 'good', 'fine', 'correct', 'complete', 'completed'];

/** Verdict words that reject it. */
const REVISE_WORDS = ['revise', 'rework', 'reject', 'rejected', 'fix', 'fail', 'fails', 'failed', 'broken', 'incomplete', 'block', 'blocked', 'stub', 'needs work', 'not ready'];

/**
 * Cut an oversized diff from the middle, keeping head and tail.
 *
 * Same 60/40 split as the tool-result cap (see `capToolResult`) and for the same
 * reason: the head carries the file list and the first hunks, where a broken
 * edit usually is, and the tail carries the last hunks of a multi-file change.
 * A middle cut on a diff is honest — the marker says so — because a review is
 * still possible from both ends of the change.
 */
export function truncateDiff(diff: string, max = MAX_REVIEW_DIFF_CHARS): { diff: string; truncated: boolean } {
  if (diff.length <= max) {
    return { diff, truncated: false };
  }
  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  const omitted = diff.length - max;
  const marker = `\n…[review diff truncated: kept ${max} of ${diff.length} chars, ${omitted} omitted]…\n`;
  return {
    diff: `${diff.slice(0, headLen)}${marker}${diff.slice(diff.length - tailLen)}`,
    truncated: true,
  };
}

/**
 * The user-turn appended for the review round-trip.
 *
 * Deliberately narrow: it names the classes of defect that a diff can PROVE and
 * tells the reviewer not to manufacture findings. An LLM judge asked to "review
 * this" reliably invents something, and every false revise costs the user a
 * whole extra round of work — far more than a missed nit.
 */
export function buildReviewInstruction(input: ReviewInput): string {
  const files = input.files.length > 0 ? input.files : ['(unknown)'];
  const lines = [
    'REVIEW TURN — not a new task and not a continuation of the old one. Do not call tools.',
    '',
    'You have just declared this turn finished. Before that result is accepted, review what you actually changed: the diff below is the real state of the files, not a summary of what you intended. Your previous message is not evidence — the diff is.',
    '',
    `Files changed (${files.length}):`,
    ...files.slice(0, 40).map((f) => `- ${f}`),
  ];
  if (input.truncated) {
    lines.push('', 'The change was too large to include in full — its head and tail are shown below.');
  }
  lines.push(
    '',
    '```diff',
    input.diff.trimEnd(),
    '```',
    '',
    'Report ONLY a defect this diff proves:',
    '- code that cannot work as written (syntax, unbalanced structure, a reference to something that does not exist);',
    '- work left incomplete: stubs, placeholders, TODO/FIXME you introduced, an edit that stops mid-change;',
    '- a change only partly applied: a file updated while its callers, tests or types were not;',
    '- a claim in your last message that this diff does not contain.',
    '',
    'If none of those apply the change is fine — say ship. Do not invent issues to look thorough, and do not re-open the task to add polish.',
    '',
    'Answer with exactly these three lines and nothing else:',
    'VERDICT: ship | revise',
    'ISSUE: <the one concrete defect, or "none">',
    'NEXT: <the exact next action, or "none" when the verdict is ship>',
  );
  return lines.join('\n');
}

/** Pull ONE named field (`ISSUE:` / `NEXT:`) out of a reply, however it is dressed. */
function parseField(text: string, name: 'issue' | 'next'): string | undefined {
  // Tolerates fenced, bulleted, bolded, quoted and backticked renderings:
  // "**NEXT:** …", "- NEXT: …", "> NEXT — …", "`NEXT`: …"
  const re = new RegExp(`^[\\s>*_\`-]*(?:\\*\\*|__)?\\s*${name}\\s*(?:\\*\\*|__)?\\s*[:\\-–]\\s*(.+)$`, 'im');
  const match = re.exec(text);
  if (!match) {
    return undefined;
  }
  const value = match[1]
    .replace(/^\s*(?:\*\*|__|`|"|'|>|\*)+/, '')
    .replace(/(?:\*\*|__|`|"|'|\*)+\s*$/, '')
    .replace(/[.;,\s]+$/, '')
    .trim();
  if (value.length === 0) {
    return undefined;
  }
  // A placeholder is not an answer: "none", "n/a", "-" all mean "no such thing".
  if (/^(?:none|n\/?a|no(?:ne)? needed|nothing|nil|null|-+|\.+)$/i.test(value)) {
    return undefined;
  }
  return value;
}

/** Map a verdict VALUE ("Revise — the caller is not updated") onto a decision. */
function classifyVerdictValue(value: string): ReviewDecision {
  const lower = value.toLowerCase();
  const ship = SHIP_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  const revise = REVISE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (ship && !revise) {
    return 'ship';
  }
  if (revise && !ship) {
    return 'revise';
  }
  // Ambiguous ("revise, not ship") or empty → unknown, which the loop treats as
  // a ship. Guessing revise here would break invariant 1 for a coin flip.
  return 'unknown';
}

/**
 * Parse the review verdict block.
 *
 * Tolerant by design, like `parseReflectionVerdict`: an explicit
 * `VERDICT:` line anywhere in the reply wins; a reply with no verdict line but
 * exactly one verdict family in it is accepted; anything else is `unknown`.
 * Malformed output must degrade to the pre-existing behaviour (accept the
 * finish), never to an error.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  if (!text || text.trim().length === 0) {
    return { verdict: 'unknown' };
  }
  const explicit = /^[\s>*_`-]*(?:\*\*|__)?\s*verdict\s*(?:\*\*|__)?\s*[:\-–]\s*(.+)$/im.exec(text);
  let verdict: ReviewDecision = explicit ? classifyVerdictValue(explicit[1]) : 'unknown';

  if (verdict === 'unknown' && !explicit) {
    // No verdict line at all: only accept an unambiguous word in the whole reply.
    verdict = classifyVerdictValue(text);
  }

  const issue = parseField(text, 'issue');
  const nextStep = parseField(text, 'next');

  if (verdict === 'ship') {
    // A ship does not need a fix; drop whatever fields came along.
    return { verdict };
  }
  if (verdict === 'revise' && !nextStep) {
    // Inverse of invariant 2: a revise nobody can act on is not a revise.
    return { verdict: 'unknown', issue };
  }
  return { verdict, issue, nextStep };
}

/** True only when the review demanded a fix AND said what the fix is. */
export function isActionableRevise(verdict: ReviewVerdict | undefined): boolean {
  return !!verdict && verdict.verdict === 'revise' && !!verdict.nextStep;
}

/**
 * The user-turn that resumes the loop after an actionable revise.
 *
 * The review exchange itself (instruction + diff + verdict) is NOT appended to
 * the conversation: the diff is large, the model wrote it, and the two lines
 * below carry everything the resumed turn needs. Same economics as the
 * reflection resume.
 */
export function formatReviewResume(verdict: ReviewVerdict): string {
  const parts = ['Your change failed an automated review of the diff, so the turn was not accepted as finished.'];
  if (verdict.issue) {
    parts.push(`Defect: ${verdict.issue}`);
  }
  parts.push(`Fix it now: ${verdict.nextStep}`);
  parts.push('Do not redo the parts of the diff that are already correct, and do not restart the task. When the fix is in, finish normally.');
  return parts.join('\n\n');
}

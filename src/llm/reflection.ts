// Reflection turn (AI-engineering roadmap #2).
//
// The agentic loop already halts itself: a repetitive-call heuristic trips and
// the turn wraps up mid-work, or the iteration budget runs out. Those heuristics
// fire LATE and blindly -- they know the shape of the failure (repeated calls,
// too many round-trips) but not its cause, so the wrap-up the user gets is a
// confession ("I ran out of iterations") rather than a plan.
//
// A reflection turn inserts ONE self-review round-trip at the distress point.
// It is not an agent and not a second agent: it is the same model, given a
// factual digest of what the turn actually did, asked to name the gap and pick
// between continuing (with a bounded budget) and concluding.
//
// Everything here is pure: no vscode, no fs, no network. The loop owns the
// round-trip; this module owns the wording and the parsing.

/**
 * Extra iterations granted when a reflection verdict is `continue`.
 *
 * Small on purpose: the point is to unstick a wrong strategy, not to double the
 * budget. The heuristic halt is recoverable; the user's `maxIterations` is not,
 * so this bonus is only ever granted on the loop-halt path.
 */
export const REFLECTION_BONUS_ITERATIONS = 4;

/** Why the loop asked for a reflection turn. */
export type ReflectionTrigger = 'loop';

/** A tool the turn executed, with how many times. */
export interface ReflectionToolUse {
  name: string;
  count: number;
  /** Calls of this tool that came back as a tool error. */
  errors: number;
}

/** Facts about the turn so far -- counters only, nothing inferred. */
export interface ReflectionDigest {
  iterations: number;
  maxIterations: number;
  toolUses: readonly ReflectionToolUse[];
  /** Distinct file paths touched by edits/writes, in first-touch order. */
  filesTouched: readonly string[];
  toolErrors: number;
  blockedCalls: number;
  readIterations: number;
  steeringMessages: number;
}

/** What the model decided to do next. */
export interface ReflectionVerdict {
  verdict: 'continue' | 'conclude' | 'unknown';
  /** The gap the model named, when it named one. */
  gap?: string;
  /** The concrete next step, required for `continue` to be honoured. */
  nextStep?: string;
}

/**
 * Render the digest as compact facts. Kept terse and tabular: this text is
 * appended to a conversation that is by definition already long, and every
 * token spent restating history is a token not spent on the decision.
 */
export function formatDigest(digest: ReflectionDigest): string {
  const lines: string[] = [
    `Iterations used: ${digest.iterations} of ${digest.maxIterations}.`,
  ];

  const tools = [...digest.toolUses]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((t) => `${t.name} x${t.count}${t.errors > 0 ? ` (${t.errors} failed)` : ''}`);
  lines.push(`Tool calls: ${tools.length > 0 ? tools.join(', ') : '(none)'}.`);

  if (digest.filesTouched.length > 0) {
    const shown = digest.filesTouched.slice(0, 12);
    const rest = digest.filesTouched.length - shown.length;
    lines.push(`Files changed: ${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}.`);
  } else {
    lines.push('Files changed: (none).');
  }

  lines.push(`Failed tool calls: ${digest.toolErrors}.`);
  if (digest.blockedCalls > 0) {
    lines.push(`Calls blocked as exact repeats: ${digest.blockedCalls}.`);
  }
  if (digest.readIterations > 0) {
    lines.push(`Consecutive read-only iterations before the halt: ${digest.readIterations}.`);
  }
  if (digest.steeringMessages > 0) {
    lines.push(`Messages the user queued mid-run: ${digest.steeringMessages}.`);
  }

  return lines.join('\n');
}

/**
 * The reflection instruction: a user turn that carries the digest and demands a
 * machine-readable decision.
 *
 * The verdict block is deliberately tiny and line-oriented -- three labeled
 * lines beat a JSON schema here because it survives models that wrap things in
 * prose or fences, and because a malformed answer degrades to `unknown`, which
 * is the same behaviour as not reflecting at all.
 */
export function buildReflectionInstruction(digest: ReflectionDigest): string {
  return [
    '[reflection checkpoint] The loop halted you for repeating itself, so before I close this out, review your own work in this turn.',
    '',
    formatDigest(digest),
    '',
    'Answer in three parts, nothing else:',
    '1. What the user asked for versus what you actually completed. Be specific about what is still missing.',
    '2. The single most likely reason you got stuck (wrong file, wrong approach, missing information, a failing tool, an ambiguous request).',
    '3. Your decision: `continue` with ONE concrete next step that is different from what you were repeating, or `conclude` because the work is done or genuinely blocked.',
    '',
    'End your reply with exactly these three lines:',
    'VERDICT: continue|conclude',
    'GAP: <what is still missing, or "none">',
    'NEXT: <the one next step you will take, or "none">',
  ].join('\n');
}

/** Strip a leading/trailing fence and common list markers from a labeled value. */
function cleanValue(raw: string): string {
  return raw
    .replace(/^[\s`*_~-]+/, '')
    .replace(/[\s`*_~]+$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function firstLabeled(text: string, label: string): string | undefined {
  // Matches `LABEL: value` at the start of a line, optionally fenced, bulleted
  // or bolded, e.g. `- **VERDICT:** continue`.
  const re = new RegExp(`^[\\s>*\\-\`]*${label}\\s*[:\\-]\\s*(.+)$`, 'im');
  const match = re.exec(text);
  return match ? cleanValue(match[1]) : undefined;
}

/**
 * Parse the model's reflection reply.
 *
 * Tolerant by design: the labeled block is preferred, then a bare
 * `VERDICT: ...` line anywhere, then keyword inference over the whole reply.
 * `continue` requires a usable `NEXT:` step -- a verdict without a plan would
 * just restart the loop that tripped the heuristic, so it degrades to
 * `conclude` at the call site rather than here (the parser reports what the
 * model said; the loop decides what it is allowed to do).
 */
export function parseReflectionVerdict(text: string): ReflectionVerdict {
  const body = typeof text === 'string' ? text : '';
  const gap = firstLabeled(body, 'GAP');
  const nextStep = firstLabeled(body, 'NEXT');
  const labeled = firstLabeled(body, 'VERDICT')?.toLowerCase() ?? '';

  const isNone = (value: string | undefined): boolean =>
    !value || /^(none|n\/a|nothing|-)$/i.test(value);

  let verdict: ReflectionVerdict['verdict'] = 'unknown';
  if (/\bcontinue\b/.test(labeled)) {
    verdict = 'continue';
  } else if (/\bconclude\b/.test(labeled)) {
    verdict = 'conclude';
  } else if (labeled.length === 0) {
    // No labeled verdict at all -- fall back to the shape of the reply.
    if (/\b(cannot|can't|unable|blocked|done|finished|complete)\b/i.test(body)) {
      verdict = 'conclude';
    } else if (/\b(next|instead|retry|try again)\b/i.test(body)) {
      verdict = 'continue';
    }
  }

  return {
    verdict,
    gap: !isNone(gap) ? gap : undefined,
    nextStep: !isNone(nextStep) ? nextStep : undefined,
  };
}

/**
 * A reflection verdict is only actionable when it says `continue` AND names a
 * step. A plan-less `continue` would send the loop straight back into the
 * repeated call the heuristic just caught.
 */
export function isActionableContinue(verdict: ReflectionVerdict): boolean {
  return verdict.verdict === 'continue' && typeof verdict.nextStep === 'string' && verdict.nextStep.trim().length > 0;
}

/** Turn the accepted verdict into the user turn that resumes the loop. */
export function buildContinuationInstruction(verdict: ReflectionVerdict, bonusIterations: number): string {
  const gap = verdict.gap ? `Remaining gap: ${verdict.gap}.` : 'Remaining gap: not stated.';
  return [
    '[reflection accepted] Switching strategy. Do NOT repeat the calls that triggered the halt.',
    gap,
    `Next step: ${verdict.nextStep ?? '(none)'}`,
    `You have ${bonusIterations} extra iteration(s). Take the next step, then finish and report what changed.`,
  ].join('\n');
}

/** The wrap-up addendum when reflection ran but the budget cannot be extended. */
export function buildWrapUpAddendum(verdict: ReflectionVerdict): string | undefined {
  if (!verdict.gap && !verdict.nextStep) {
    return undefined;
  }
  const parts = ['Your own review at the checkpoint named:'];
  if (verdict.gap) {
    parts.push(`- Still missing: ${verdict.gap}`);
  }
  if (verdict.nextStep) {
    parts.push(`- What you would do next: ${verdict.nextStep}`);
  }
  parts.push('State this plainly in the final answer so the next turn can pick it up.');
  return parts.join('\n');
}

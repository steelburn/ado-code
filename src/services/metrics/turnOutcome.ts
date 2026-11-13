// Per-turn outcome counters (AI-engineering roadmap #1, stage 1).
//
// The other AI-engineering documents describe ADO Code's loop and harness as
// well engineered but unmeasured: thousands of unit tests prove the CODE works,
// and nothing at all proves a TURN works. This module is the smallest thing that
// closes that gap — it aggregates the signals the loop already emits into one
// question: *did this turn succeed, and which signals fired on the way?*
//
// Deliberately NOT a benchmark and NOT an LLM grader:
//   - no golden set yet (that is stage 2 of the roadmap),
//   - no model judging model (that is a liability before it is a measurement),
//   - no prose comparison (too brittle to gate on).
// Only counts of events the harness observes for free. That is why it can ship
// in an afternoon and still be the foundation the other three stages sit on.
//
// Pure functions over plain data: no `vscode`, no `fs`. Persistence lives in
// TurnOutcomeStore, editor glue in turnOutcomeCommand, and both are thin.

import {
  TURN_SIGNAL_KEYS,
  TurnSignals,
  addTurnSignals,
  emptyTurnSignals,
} from '../../shared/turnSignals';

/**
 * How a turn ended. `completed` is the only one that counts as success — the
 * point of the counter is a completion rate that must not be talked up.
 */
export type TurnOutcomeKind =
  | 'completed'
  | 'iterationLimit'
  | 'loopDetected'
  | 'aborted'
  | 'error';

export const TURN_OUTCOME_KINDS: readonly TurnOutcomeKind[] = [
  'completed',
  'iterationLimit',
  'loopDetected',
  'aborted',
  'error',
];

export const OUTCOME_LABELS: Record<TurnOutcomeKind, string> = {
  completed: 'Completed',
  iterationLimit: 'Iteration limit',
  loopDetected: 'Loop detected',
  aborted: 'Aborted by user',
  error: 'Error',
};

/** One finished turn. Small on purpose: the recent ring is stored verbatim. */
export interface TurnRecord {
  /** ISO timestamp of when the turn was recorded. */
  at: string;
  /** Agent mode the turn ran in (chat / plan / act / yolo / inline …). */
  mode: string;
  outcome: TurnOutcomeKind;
  signals: TurnSignals;
}

/** The persisted aggregate. `signals` is the lifetime sum, `recent` the tail. */
export interface OutcomeCounters {
  version: 1;
  firstAt?: string;
  updatedAt?: string;
  turns: number;
  byOutcome: Record<TurnOutcomeKind, number>;
  signals: TurnSignals;
  /** Newest last, capped at RECENT_TURNS_CAP. */
  recent: TurnRecord[];
}

/** Enough to see a trend without letting the file grow without bound. */
export const RECENT_TURNS_CAP = 200;

export function emptyOutcomeCounters(): OutcomeCounters {
  return {
    version: 1,
    turns: 0,
    byOutcome: {
      completed: 0,
      iterationLimit: 0,
      loopDetected: 0,
      aborted: 0,
      error: 0,
    },
    signals: emptyTurnSignals(),
    recent: [],
  };
}

/**
 * Fold one finished turn into the aggregate. Pure: returns a new object so the
 * caller can decide when (and whether) to persist.
 */
export function recordTurn(counters: OutcomeCounters, record: TurnRecord): OutcomeCounters {
  const next: OutcomeCounters = {
    version: 1,
    firstAt: counters.firstAt ?? record.at,
    updatedAt: record.at,
    turns: counters.turns + 1,
    byOutcome: { ...counters.byOutcome, [record.outcome]: counters.byOutcome[record.outcome] + 1 },
    signals: addTurnSignals(counters.signals, record.signals),
    recent: [...counters.recent, record].slice(-RECENT_TURNS_CAP),
  };
  return next;
}

/**
 * Map the loop's flags onto the one outcome we record. Precedence matters: an
 * aborted or errored turn is not "completed" even if the model also hit a limit,
 * because the user's intent, not the budget, ended it.
 */
export function classifyTurnOutcome(flags: {
  error?: boolean;
  aborted?: boolean;
  loopDetected?: boolean;
  reachedIterationLimit?: boolean;
}): TurnOutcomeKind {
  if (flags.error) return 'error';
  if (flags.aborted) return 'aborted';
  if (flags.loopDetected) return 'loopDetected';
  if (flags.reachedIterationLimit) return 'iterationLimit';
  return 'completed';
}

export interface TurnOutcomeSummary {
  turns: number;
  completed: number;
  /** 0..1. Zero when nothing has been recorded yet. */
  completionRate: number;
  byOutcome: Record<TurnOutcomeKind, number>;
  signals: TurnSignals;
  /** Lifetime signals normalised to a per-100-turns rate (comparable over time). */
  perHundred: TurnSignals;
  averages: {
    iterations: number;
    toolCalls: number;
    /** tool errors / tool results, 0..1. */
    toolErrorRate: number;
  };
  /** Tail window, so a trend is visible in a capped file. */
  window: {
    size: number;
    turns: number;
    completionRate: number;
    avgIterations: number;
  };
  firstAt?: string;
  updatedAt?: string;
}

export function summarizeOutcomeCounters(
  counters: OutcomeCounters,
  windowSize: number = 50
): TurnOutcomeSummary {
  const turns = counters.turns;
  const completed = counters.byOutcome.completed;
  const perHundred = emptyTurnSignals();
  for (const key of TURN_SIGNAL_KEYS) {
    perHundred[key] = turns > 0 ? round1((counters.signals[key] / turns) * 100) : 0;
  }
  const tail = windowSize > 0 ? counters.recent.slice(-windowSize) : [];
  const tailCompleted = tail.filter((r) => r.outcome === 'completed').length;
  const tailSignals = tail.reduce(
    (acc, r) => addTurnSignals(acc, r.signals),
    emptyTurnSignals()
  );

  return {
    turns,
    completed,
    completionRate: turns > 0 ? fraction(completed / turns) : 0,
    byOutcome: { ...counters.byOutcome },
    signals: { ...counters.signals },
    perHundred,
    averages: {
      iterations: turns > 0 ? round1(counters.signals.iterations / turns) : 0,
      toolCalls: turns > 0 ? round1(counters.signals.toolCalls / turns) : 0,
      toolErrorRate:
        counters.signals.toolResults > 0
          ? fraction(counters.signals.toolErrors / counters.signals.toolResults)
          : 0,
    },
    window: {
      size: windowSize,
      turns: tail.length,
      completionRate:
        tail.length > 0 ? fraction(tailCompleted / tail.length) : 0,
      avgIterations: tail.length > 0 ? round1(tailSignals.iterations / tail.length) : 0,
    },
    firstAt: counters.firstAt,
    updatedAt: counters.updatedAt,
  };
}

/** Markdown report for the editor. Mirrors the tone of the context-cost report. */
export function formatOutcomeReport(
  summary: TurnOutcomeSummary,
  options: { file?: string } = {}
): string {
  const lines: string[] = [];
  lines.push('# Turn outcome counters');
  lines.push('');
  lines.push(
    'Counts of what the agentic loop already reports: did the turn finish, and which'
  );
  lines.push(
    'corrective signals fired on the way. Nothing here is generated by a model — it is'
  );
  lines.push('the harness counting its own events.');
  lines.push('');

  if (options.file) {
    lines.push(`- **Counters file:** \`${options.file}\``);
  }
  lines.push(`- **Turns recorded:** ${summary.turns}`);
  if (summary.firstAt) lines.push(`- **First turn:** ${summary.firstAt}`);
  if (summary.updatedAt) lines.push(`- **Last turn:** ${summary.updatedAt}`);
  lines.push(
    `- **Completion rate:** ${pct(summary.completionRate)} (${summary.completed}/${summary.turns})`
  );
  lines.push('');

  if (summary.turns === 0) {
    lines.push('_No turns recorded yet — run a chat turn and reload this report._');
    lines.push('');
    lines.push(CAVEATS);
    return lines.join('\n');
  }

  lines.push('## Outcomes');
  lines.push('');
  lines.push('| Outcome | Turns | Share |');
  lines.push('| --- | ---: | ---: |');
  for (const kind of TURN_OUTCOME_KINDS) {
    const count = summary.byOutcome[kind];
    const share = summary.turns > 0 ? pct(count / summary.turns) : pct(0);
    lines.push(`| ${OUTCOME_LABELS[kind]} | ${count} | ${share} |`);
  }
  lines.push('');

  lines.push('## Signals');
  lines.push('');
  lines.push('Lifetime totals, plus a per-100-turns rate so turns of different volumes compare.');
  lines.push('');
  lines.push('| Signal | Total | Per 100 turns |');
  lines.push('| --- | ---: | ---: |');
  for (const key of TURN_SIGNAL_KEYS) {
    lines.push(`| ${SIGNAL_LABELS[key]} | ${summary.signals[key]} | ${summary.perHundred[key]} |`);
  }
  lines.push('');

  lines.push('## Averages');
  lines.push('');
  lines.push(`- **Iterations per turn:** ${summary.averages.iterations}`);
  lines.push(`- **Tool calls per turn:** ${summary.averages.toolCalls}`);
  lines.push(`- **Tool failure rate:** ${pct(summary.averages.toolErrorRate)} of results`);
  lines.push('');

  if (summary.window.turns > 0) {
    lines.push(`## Last ${summary.window.turns} turns`);
    lines.push('');
    lines.push(
      `- Completion rate ${pct(summary.window.completionRate)} · iterations/turn ${summary.window.avgIterations}`
    );
    lines.push('');
  }

  lines.push(CAVEATS);
  return lines.join('\n');
}

const SIGNAL_LABELS: Record<keyof TurnSignals, string> = {
  iterations: 'Model round-trips',
  toolCalls: 'Tool calls requested',
  toolResults: 'Tool results returned',
  toolErrors: 'Failed tools (`{ error }`)',
  truncatedResults: 'Truncated results',
  loopBlocks: 'Repeat calls blocked',
  readSynthesisNudges: 'Read-synthesis nudges',
  steeringMessages: 'Mid-run steering messages',
  reflectionTurns: 'Reflection turns',
  reviewTurns: 'Diff reviews run',
  reviewRevisions: 'Revisions caught by review',
};

const CAVEATS = [
  '## What this does not tell you',
  '',
  '- **Whether the answer was any good.** `completed` means the loop ended without',
  '  hitting a limit, a loop halt or an error — not that the work was correct.',
  '  Quality needs the golden set (roadmap stage 2); do not read this report as one.',
  '- **Why a rate moved.** The counters observe, they do not attribute. Change one',
  '  thing at a time — prompt, loop budget, model — and compare like windows.',
  '- **Whether a review was right.** `reviewRevisions` counts gates that demanded a',
  '  fix — and a reviewer can be wrong, so read it only next to completion rate.',
  '- **Anything about a single turn.** One turn is noise; watch the last-50 window.',
  '',
  'Direction of travel: completion rate **up**, nudges / loop blocks / iteration',
  'limits **down** — a prompt change that lowers completion rate is a regression',
  'even when the transcript reads better.',
].join('\n');

/**
 * Parse a persisted counters file. Tolerant by design: a hand-edited or partly
 * written file degrades to empty counters instead of throwing, because metrics
 * must never be able to break a turn.
 */
export function parseOutcomeCounters(raw: string | undefined | null): OutcomeCounters {
  if (!raw || !raw.trim()) return emptyOutcomeCounters();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyOutcomeCounters();
  }
  if (!parsed || typeof parsed !== 'object') return emptyOutcomeCounters();
  const src = parsed as Record<string, unknown>;

  const counters = emptyOutcomeCounters();
  counters.firstAt = typeof src.firstAt === 'string' ? src.firstAt : undefined;
  counters.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : undefined;
  counters.turns = count(src.turns);

  const byOutcome = src.byOutcome;
  if (byOutcome && typeof byOutcome === 'object') {
    for (const kind of TURN_OUTCOME_KINDS) {
      counters.byOutcome[kind] = count((byOutcome as Record<string, unknown>)[kind]);
    }
  } else {
    // Salvage: the turn total is known but the split is not — keep it as completed
    // so the completion rate stays honest rather than becoming 0%.
    counters.byOutcome.completed = counters.turns;
  }

  const signals = src.signals;
  if (signals && typeof signals === 'object') {
    for (const key of TURN_SIGNAL_KEYS) {
      counters.signals[key] = count((signals as Record<string, unknown>)[key]);
    }
  }

  if (Array.isArray(src.recent)) {
    for (const entry of src.recent) {
      const record = parseTurnRecord(entry);
      if (record) counters.recent.push(record);
    }
    counters.recent = counters.recent.slice(-RECENT_TURNS_CAP);
  }

  // A file whose turn total disagrees with its split cannot be trusted for
  // rates; the recorded total wins and the split is rebuilt from the tail.
  const splitTotal = TURN_OUTCOME_KINDS.reduce((sum, k) => sum + counters.byOutcome[k], 0);
  if (counters.turns > 0 && splitTotal === 0) {
    counters.byOutcome.completed = counters.turns;
  }
  return counters;
}

function parseTurnRecord(entry: unknown): TurnRecord | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const src = entry as Record<string, unknown>;
  const outcome = src.outcome;
  if (typeof outcome !== 'string' || !TURN_OUTCOME_KINDS.includes(outcome as TurnOutcomeKind)) {
    return undefined;
  }
  const signals = emptyTurnSignals();
  const rawSignals = src.signals;
  if (rawSignals && typeof rawSignals === 'object') {
    for (const key of TURN_SIGNAL_KEYS) {
      signals[key] = count((rawSignals as Record<string, unknown>)[key]);
    }
  }
  return {
    at: typeof src.at === 'string' ? src.at : new Date(0).toISOString(),
    mode: typeof src.mode === 'string' ? src.mode : 'unknown',
    outcome: outcome as TurnOutcomeKind,
    signals,
  };
}

export function serializeOutcomeCounters(counters: OutcomeCounters): string {
  return `${JSON.stringify(counters, null, 2)}\n`;
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 0..1 rounded to 3 decimals — enough to compare rates without float noise. */
function fraction(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pct(fraction: number): string {
  return `${round1(fraction * 100)}%`;
}

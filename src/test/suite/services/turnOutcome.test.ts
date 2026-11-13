// Turn outcome counters (AI-engineering roadmap #1, stage 1).
//
// The point of these tests is the counting RULES — precedence, rates, tolerance
// to a hand-edited file — not the plumbing. If the rules drift, every completion
// rate ever quoted from this report becomes incomparable, so they are pinned.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  OUTCOME_FILE_NAME,
  OUTCOME_DIR,
  TurnOutcomeStore,
} from '../../../services/metrics/TurnOutcomeStore';
import {
  RECENT_TURNS_CAP,
  classifyTurnOutcome,
  emptyOutcomeCounters,
  formatOutcomeReport,
  parseOutcomeCounters,
  recordTurn,
  serializeOutcomeCounters,
  summarizeOutcomeCounters,
} from '../../../services/metrics/turnOutcome';
import type { TurnOutcomeKind, TurnRecord } from '../../../services/metrics/turnOutcome';
import {
  emptyTurnSignals,
  isToolErrorResult,
  isTruncatedResult,
} from '../../../shared/turnSignals';
import type { TurnSignals } from '../../../shared/turnSignals';
import { makeScratchDir } from '../utils/scratchDir';

function signals(overrides: Partial<TurnSignals> = {}): TurnSignals {
  return { ...emptyTurnSignals(), ...overrides };
}

function turn(
  outcome: TurnOutcomeKind,
  overrides: Partial<TurnSignals> = {},
  mode = 'act',
  at = '2024-05-01T10:00:00.000Z'
): TurnRecord {
  return { at, mode, outcome, signals: signals(overrides) };
}

suite('Turn outcome counters — outcome classification', () => {
  test('a clean loop return counts as completed', () => {
    assert.strictEqual(classifyTurnOutcome({}), 'completed');
  });

  test('iteration limit and loop halt are distinct, non-success outcomes', () => {
    assert.strictEqual(classifyTurnOutcome({ reachedIterationLimit: true }), 'iterationLimit');
    assert.strictEqual(classifyTurnOutcome({ loopDetected: true }), 'loopDetected');
  });

  test('user intent outranks the budget: aborted beats limit, error beats both', () => {
    assert.strictEqual(
      classifyTurnOutcome({ aborted: true, reachedIterationLimit: true }),
      'aborted'
    );
    assert.strictEqual(classifyTurnOutcome({ aborted: true, loopDetected: true }), 'aborted');
    assert.strictEqual(
      classifyTurnOutcome({ error: true, aborted: true, loopDetected: true }),
      'error'
    );
  });
});

suite('Turn outcome counters — aggregation', () => {
  test('recordTurn folds one turn into totals without mutating the input', () => {
    const before = emptyOutcomeCounters();
    const after = recordTurn(
      before,
      turn('completed', { iterations: 3, toolCalls: 4, toolResults: 4, toolErrors: 1 })
    );

    assert.strictEqual(before.turns, 0, 'input counters must stay untouched');
    assert.strictEqual(after.turns, 1);
    assert.strictEqual(after.byOutcome.completed, 1);
    assert.strictEqual(after.signals.iterations, 3);
    assert.strictEqual(after.signals.toolErrors, 1);
    assert.strictEqual(after.firstAt, '2024-05-01T10:00:00.000Z');
    assert.strictEqual(after.recent.length, 1);
  });

  test('firstAt is stamped once, updatedAt follows the last turn', () => {
    let counters = recordTurn(emptyOutcomeCounters(), turn('completed', {}, 'act', '2024-01-01T00:00:00.000Z'));
    counters = recordTurn(counters, turn('error', {}, 'act', '2024-02-02T00:00:00.000Z'));
    assert.strictEqual(counters.firstAt, '2024-01-01T00:00:00.000Z');
    assert.strictEqual(counters.updatedAt, '2024-02-02T00:00:00.000Z');
  });

  test('the recent ring is capped but the lifetime totals keep growing', () => {
    let counters = emptyOutcomeCounters();
    for (let i = 0; i < RECENT_TURNS_CAP + 25; i++) {
      counters = recordTurn(counters, turn('completed'));
    }
    assert.strictEqual(counters.turns, RECENT_TURNS_CAP + 25);
    assert.strictEqual(counters.recent.length, RECENT_TURNS_CAP);
  });

  test('completion rate counts only completed turns', () => {
    let counters = emptyOutcomeCounters();
    counters = recordTurn(counters, turn('completed'));
    counters = recordTurn(counters, turn('completed'));
    counters = recordTurn(counters, turn('iterationLimit'));
    counters = recordTurn(counters, turn('loopDetected'));

    const summary = summarizeOutcomeCounters(counters);
    assert.strictEqual(summary.turns, 4);
    assert.strictEqual(summary.completed, 2);
    assert.strictEqual(summary.completionRate, 0.5);
    assert.strictEqual(summary.byOutcome.iterationLimit, 1);
    assert.strictEqual(summary.byOutcome.loopDetected, 1);
  });

  test('rates are normalised per 100 turns and per tool result', () => {
    let counters = emptyOutcomeCounters();
    // Two turns, 8 iterations in total, 4 results of which 1 failed.
    counters = recordTurn(
      counters,
      turn('completed', { iterations: 4, toolCalls: 5, toolResults: 4, toolErrors: 1 })
    );
    counters = recordTurn(counters, turn('iterationLimit', { iterations: 4, toolCalls: 5, toolResults: 4 }));

    const summary = summarizeOutcomeCounters(counters);
    assert.strictEqual(summary.perHundred.iterations, 400);
    assert.strictEqual(summary.averages.iterations, 4);
    assert.strictEqual(summary.averages.toolCalls, 5);
    assert.strictEqual(summary.averages.toolErrorRate, 0.125, '1 of 8 results');
  });

  test('the window tracks only the last N turns, so a trend stays visible', () => {
    let counters = emptyOutcomeCounters();
    for (let i = 0; i < 10; i++) counters = recordTurn(counters, turn('error'));
    for (let i = 0; i < 5; i++) counters = recordTurn(counters, turn('completed'));

    const summary = summarizeOutcomeCounters(counters, 5);
    assert.strictEqual(summary.turns, 15);
    assert.strictEqual(summary.window.turns, 5);
    assert.strictEqual(summary.window.completionRate, 1);
    assert.strictEqual(summary.completionRate, Math.round((5 / 15) * 1000) / 1000);
  });

  test('an empty counter set reports 0% rather than NaN', () => {
    const summary = summarizeOutcomeCounters(emptyOutcomeCounters());
    assert.strictEqual(summary.turns, 0);
    assert.strictEqual(summary.completionRate, 0);
    assert.strictEqual(summary.averages.toolErrorRate, 0);
    assert.strictEqual(summary.window.avgIterations, 0);
  });
});

suite('Turn outcome counters — report', () => {
  test('renders outcomes, signals, averages and the caveats', () => {
    let counters = emptyOutcomeCounters();
    counters = recordTurn(counters, turn('completed', { iterations: 2, toolResults: 2 }));
    counters = recordTurn(
      counters,
      turn('iterationLimit', { iterations: 6, truncatedResults: 1, readSynthesisNudges: 2 })
    );
    counters = recordTurn(counters, turn('loopDetected', { loopBlocks: 3 }));

    const report = formatOutcomeReport(summarizeOutcomeCounters(counters), { file: '/tmp/x.json' });

    assert.ok(report.includes('# Turn outcome counters'));
    assert.ok(report.includes('`/tmp/x.json`'), 'shows where the counts live');
    assert.ok(report.includes('| Completed | 1 |'), 'outcome table');
    assert.ok(report.includes('| Repeat calls blocked | 3 | 100 |'), 'per-100 signal rate');
    assert.ok(report.includes('**Completion rate:** 33.3%'), 'headline rate');
    assert.ok(report.includes('## What this does not tell you'), 'honesty section');
    assert.ok(report.includes('Whether the answer was any good'), 'quality caveat');
  });

  test('an empty store renders an invitation, not a broken table', () => {
    const report = formatOutcomeReport(summarizeOutcomeCounters(emptyOutcomeCounters()));
    assert.ok(report.includes('No turns recorded yet'));
    assert.ok(!report.includes('| Completed |'), 'no zero table');
    assert.ok(report.includes('## What this does not tell you'));
  });
});

suite('Turn outcome counters — tolerant parsing', () => {
  test('garbage, blank and non-object payloads degrade to empty counters', () => {
    for (const raw of ['', '   ', '{not json', '[]', 'null', '42']) {
      const counters = parseOutcomeCounters(raw);
      assert.strictEqual(counters.turns, 0, `payload ${JSON.stringify(raw)}`);
      assert.deepStrictEqual(counters.recent, []);
    }
  });

  test('unknown outcomes and negative or non-numeric counts are dropped', () => {
    const counters = parseOutcomeCounters(
      JSON.stringify({
        turns: '7',
        byOutcome: { completed: 3, bogus: 99, error: -4 },
        signals: { iterations: 10, toolCalls: 'oops', toolErrors: -2 },
      })
    );
    assert.strictEqual(counters.turns, 7);
    assert.strictEqual(counters.byOutcome.completed, 3);
    assert.strictEqual(counters.byOutcome.error, 0);
    assert.strictEqual(counters.signals.iterations, 10);
    assert.strictEqual(counters.signals.toolCalls, 0);
    assert.strictEqual(counters.signals.toolErrors, 0);
    assert.ok(!('bogus' in counters.byOutcome));
  });

  test('a file with a turn total but no split keeps the rate honest', () => {
    const counters = parseOutcomeCounters(JSON.stringify({ turns: 5 }));
    assert.strictEqual(counters.turns, 5);
    assert.strictEqual(counters.byOutcome.completed, 5);
    assert.strictEqual(summarizeOutcomeCounters(counters).completionRate, 1);
  });

  test('malformed recent entries are skipped, valid ones survive', () => {
    const counters = parseOutcomeCounters(
      JSON.stringify({
        turns: 2,
        byOutcome: { completed: 2 },
        recent: [
          { at: '2024-01-01T00:00:00.000Z', mode: 'act', outcome: 'completed', signals: { iterations: 2 } },
          { outcome: 'not-a-kind' },
          'nonsense',
          { outcome: 'error' },
        ],
      })
    );
    assert.strictEqual(counters.recent.length, 2);
    assert.strictEqual(counters.recent[0].signals.iterations, 2);
    assert.strictEqual(counters.recent[1].outcome, 'error');
    assert.strictEqual(counters.recent[1].mode, 'unknown');
  });

  test('serialize → parse round-trips the aggregate', () => {
    let counters = emptyOutcomeCounters();
    counters = recordTurn(counters, turn('completed', { iterations: 3, steeringMessages: 1 }));
    const restored = parseOutcomeCounters(serializeOutcomeCounters(counters));
    assert.deepStrictEqual(restored, counters);
  });
});

suite('Turn signals — tool result classification', () => {
  test('a { error } result is a failed tool; success payloads are not', () => {
    assert.strictEqual(isToolErrorResult('{"error":"ENOENT: no such file"}'), true);
    assert.strictEqual(isToolErrorResult('  { "error" : "boom" }'), true);
    assert.strictEqual(isToolErrorResult('{"ok":true}'), false);
    assert.strictEqual(isToolErrorResult('plain text result'), false);
  });

  test('every size-cap marker counts as truncation, ordinary text does not', () => {
    assert.strictEqual(isTruncatedResult('head\n\n…[result truncated: 9,000 chars / ~2,250 tokens]…\ntail'), true);
    assert.strictEqual(isTruncatedResult('head\n…[truncated; omitted 42 chars]…\ntail'), true);
    assert.strictEqual(isTruncatedResult('…[read_file truncated: showing first 400 of 649 lines]'), true);
    assert.strictEqual(isTruncatedResult('a normal tool result with no marker'), false);
  });
});

suite('TurnOutcomeStore — persistence', () => {
  test('records survive a restart and land under .ado-code/metrics', async () => {
    const dir = makeScratchDir('outcomes-');
    try {
      const store = new TurnOutcomeStore(() => dir);
      await store.record(turn('completed', { iterations: 2 }));
      await store.record(turn('iterationLimit', { iterations: 9 }));

      const file = path.join(dir, OUTCOME_DIR, OUTCOME_FILE_NAME);
      assert.ok(fs.existsSync(file), `expected ${file}`);
      assert.strictEqual(store.filePath(), file);

      const reloaded = await new TurnOutcomeStore(() => dir).read();
      assert.strictEqual(reloaded.turns, 2);
      assert.strictEqual(reloaded.byOutcome.completed, 1);
      assert.strictEqual(reloaded.byOutcome.iterationLimit, 1);
      assert.strictEqual(reloaded.signals.iterations, 11);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('concurrent turns cannot lose each other’s counts', async () => {
    const dir = makeScratchDir('outcomes-race-');
    try {
      const store = new TurnOutcomeStore(() => dir);
      await Promise.all(
        Array.from({ length: 25 }, () => store.record(turn('completed', { iterations: 1 })))
      );
      const reloaded = await new TurnOutcomeStore(() => dir).read();
      assert.strictEqual(reloaded.turns, 25);
      assert.strictEqual(reloaded.signals.iterations, 25);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt file resets to empty instead of throwing, and keeps counting', async () => {
    const dir = makeScratchDir('outcomes-corrupt-');
    try {
      const file = path.join(dir, OUTCOME_DIR, OUTCOME_FILE_NAME);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{ half-written', 'utf8');

      const store = new TurnOutcomeStore(() => dir);
      assert.strictEqual((await store.read()).turns, 0);
      await store.record(turn('completed'));

      const reloaded = await new TurnOutcomeStore(() => dir).read();
      assert.strictEqual(reloaded.turns, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing workspace folder is a no-op, never an error', async () => {
    const store = new TurnOutcomeStore(() => undefined);
    assert.strictEqual(store.filePath(), undefined);
    await store.record(turn('completed'));
    assert.strictEqual((await store.read()).turns, 0);
  });

  test('clear() drops the file and the in-memory aggregate', async () => {
    const dir = makeScratchDir('outcomes-clear-');
    try {
      const store = new TurnOutcomeStore(() => dir);
      await store.record(turn('completed'));
      await store.clear();
      assert.strictEqual((await store.read()).turns, 0);
      assert.strictEqual(fs.existsSync(path.join(dir, OUTCOME_DIR, OUTCOME_FILE_NAME)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

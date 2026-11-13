// Reflection turn (AI-engineering roadmap #2).
//
// The loop's halts are heuristics: they see the SHAPE of a failure, not its
// cause. A reflection turn costs one round-trip and asks the model to name the
// cause. These tests pin the parts that decide whether that round-trip was
// worth anything — the digest facts, the verdict parsing, and the rule that a
// `continue` without a plan is not actionable — rather than the loop plumbing.

import * as assert from 'assert';

import {
  REFLECTION_BONUS_ITERATIONS,
  buildContinuationInstruction,
  buildReflectionInstruction,
  buildWrapUpAddendum,
  formatDigest,
  isActionableContinue,
  parseReflectionVerdict,
} from '../../../llm/reflection';
import type { ReflectionDigest } from '../../../llm/reflection';
import {
  emptyOutcomeCounters,
  formatOutcomeReport,
  recordTurn,
  summarizeOutcomeCounters,
} from '../../../services/metrics/turnOutcome';
import type { TurnRecord } from '../../../services/metrics/turnOutcome';
import { addTurnSignals, emptyTurnSignals } from '../../../shared/turnSignals';

function digest(overrides: Partial<ReflectionDigest> = {}): ReflectionDigest {
  return {
    iterations: 12,
    maxIterations: 100,
    toolUses: [],
    filesTouched: [],
    toolErrors: 0,
    blockedCalls: 0,
    readIterations: 0,
    steeringMessages: 0,
    ...overrides,
  };
}

suite('llm/reflection: digest', () => {
  test('reports iterations against the budget', () => {
    const text = formatDigest(digest({ iterations: 12, maxIterations: 100 }));
    assert.ok(text.includes('Iterations used: 12 of 100.'));
  });

  test('lists tools by descending call count, with failures annotated', () => {
    const text = formatDigest(digest({
      toolUses: [
        { name: 'read_file', count: 9, errors: 0 },
        { name: 'edit_file', count: 2, errors: 1 },
      ],
    }));
    assert.ok(text.includes('Tool calls: read_file x9, edit_file x2 (1 failed).'));
  });

  test('says (none) rather than omitting empty facts', () => {
    const text = formatDigest(digest());
    assert.ok(text.includes('Tool calls: (none).'));
    assert.ok(text.includes('Files changed: (none).'));
    assert.ok(text.includes('Failed tool calls: 0.'));
  });

  test('truncates the file list after twelve entries', () => {
    const files = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
    const text = formatDigest(digest({ filesTouched: files }));
    assert.ok(text.includes('src/file0.ts'));
    assert.ok(text.includes('src/file11.ts'));
    assert.ok(!text.includes('src/file12.ts'));
    assert.ok(text.includes('(+3 more)'));
  });

  test('omits distress lines that would only restate a zero', () => {
    const calm = formatDigest(digest());
    assert.ok(!calm.includes('blocked as exact repeats'));
    assert.ok(!calm.includes('read-only iterations'));
    assert.ok(!calm.includes('queued mid-run'));
  });

  test('includes distress lines once they are non-zero', () => {
    const text = formatDigest(digest({ blockedCalls: 3, readIterations: 6, steeringMessages: 1 }));
    assert.ok(text.includes('Calls blocked as exact repeats: 3.'));
    assert.ok(text.includes('Consecutive read-only iterations before the halt: 6.'));
    assert.ok(text.includes('Messages the user queued mid-run: 1.'));
  });
});

suite('llm/reflection: instruction', () => {
  test('carries the digest and demands the three-line verdict block', () => {
    const text = buildReflectionInstruction(digest({ toolErrors: 2 }));
    assert.ok(text.includes('Iterations used: 12 of 100.'));
    assert.ok(text.includes('Failed tool calls: 2.'));
    assert.ok(text.includes('VERDICT: continue|conclude'));
    assert.ok(text.includes('GAP:'));
    assert.ok(text.includes('NEXT:'));
  });

  test('asks for a next step that differs from the repeated call', () => {
    const text = buildReflectionInstruction(digest());
    assert.ok(text.toLowerCase().includes('different from what you were repeating'));
  });
});

suite('llm/reflection: verdict parsing', () => {
  test('parses the canonical three-line block', () => {
    const verdict = parseReflectionVerdict(
      'I fixed the import but the test still fails.\n\nVERDICT: continue\nGAP: the failing assertion\nNEXT: run the test and read the stack trace',
    );
    assert.strictEqual(verdict.verdict, 'continue');
    assert.strictEqual(verdict.gap, 'the failing assertion');
    assert.strictEqual(verdict.nextStep, 'run the test and read the stack trace');
  });

  test('parses inside a fenced block with bold labels', () => {
    const verdict = parseReflectionVerdict(
      '```\n**VERDICT:** conclude\n**GAP:** none\n**NEXT:** none\n```',
    );
    assert.strictEqual(verdict.verdict, 'conclude');
    assert.strictEqual(verdict.gap, undefined);
    assert.strictEqual(verdict.nextStep, undefined);
  });

  test('parses bulleted labels', () => {
    const verdict = parseReflectionVerdict('- VERDICT: continue\n- GAP: chapter 4\n- NEXT: rewrite chapter 4');
    assert.strictEqual(verdict.verdict, 'continue');
    assert.strictEqual(verdict.nextStep, 'rewrite chapter 4');
  });

  test('strips surrounding quotes and backticks from values', () => {
    const verdict = parseReflectionVerdict('VERDICT: `continue`\nGAP: "the docs"\nNEXT: \'edit the README\'');
    assert.strictEqual(verdict.verdict, 'continue');
    assert.strictEqual(verdict.gap, 'the docs');
    assert.strictEqual(verdict.nextStep, 'edit the README');
  });

  test('infers conclude from prose when no verdict line exists', () => {
    const verdict = parseReflectionVerdict('The work is done and the tests pass, so I am finished.');
    assert.strictEqual(verdict.verdict, 'conclude');
  });

  test('infers continue from prose that proposes a different step', () => {
    const verdict = parseReflectionVerdict('Instead I should read the config file before editing it again.');
    assert.strictEqual(verdict.verdict, 'continue');
  });

  test('empty or unusable text degrades to unknown', () => {
    assert.strictEqual(parseReflectionVerdict('').verdict, 'unknown');
    assert.strictEqual(parseReflectionVerdict('Hmm.').verdict, 'unknown');
  });

  test('an unlabelled verdict word wins over prose inference', () => {
    // "cannot" would infer conclude; the labeled verdict must win.
    const verdict = parseReflectionVerdict('I cannot finish this yet.\nVERDICT: continue\nNEXT: read the schema');
    assert.strictEqual(verdict.verdict, 'continue');
  });

  test('a GAP of "none" is treated as absent rather than as text', () => {
    const verdict = parseReflectionVerdict('VERDICT: conclude\nGAP: N/A\nNEXT: -');
    assert.strictEqual(verdict.gap, undefined);
    assert.strictEqual(verdict.nextStep, undefined);
  });
});

suite('llm/reflection: actionability', () => {
  test('continue with a next step is actionable', () => {
    assert.strictEqual(
      isActionableContinue({ verdict: 'continue', nextStep: 'inspect the failing test' }),
      true,
    );
  });

  test('continue WITHOUT a next step is not actionable', () => {
    // Otherwise the loop resumes with no change of strategy and re-trips the
    // same heuristic — the reflection round-trip would cost tokens and fix nothing.
    assert.strictEqual(isActionableContinue({ verdict: 'continue' }), false);
    assert.strictEqual(isActionableContinue({ verdict: 'continue', nextStep: '   ' }), false);
  });

  test('conclude is never actionable, even with a next step', () => {
    assert.strictEqual(
      isActionableContinue({ verdict: 'conclude', nextStep: 'read the file' }),
      false,
    );
  });

  test('unknown is never actionable', () => {
    assert.strictEqual(isActionableContinue({ verdict: 'unknown', nextStep: 'read the file' }), false);
  });

  test('the continuation turn states the gap, the step and the budget', () => {
    const text = buildContinuationInstruction(
      { verdict: 'continue', gap: 'CHANGELOG is stale', nextStep: 'append the entry' },
      REFLECTION_BONUS_ITERATIONS,
    );
    assert.ok(text.includes('Remaining gap: CHANGELOG is stale.'));
    assert.ok(text.includes('Next step: append the entry'));
    assert.ok(text.includes(`You have ${REFLECTION_BONUS_ITERATIONS} extra iteration(s).`));
    assert.ok(text.includes('Do NOT repeat'));
  });

  test('the continuation turn survives a missing gap', () => {
    const text = buildContinuationInstruction({ verdict: 'continue', nextStep: 'do X' }, 2);
    assert.ok(text.includes('Remaining gap: not stated.'));
    assert.ok(text.includes('Next step: do X'));
  });

  test('the wrap-up addendum is undefined when reflection named nothing', () => {
    assert.strictEqual(buildWrapUpAddendum({ verdict: 'unknown' }), undefined);
    assert.strictEqual(buildWrapUpAddendum({ verdict: 'conclude' }), undefined);
  });

  test('the wrap-up addendum quotes the gap and the next step', () => {
    const addendum = buildWrapUpAddendum({ verdict: 'conclude', gap: 'no tests', nextStep: 'write them' });
    assert.ok(addendum);
    assert.ok(addendum!.includes('Still missing: no tests'));
    assert.ok(addendum!.includes('What you would do next: write them'));
  });

  test('the bonus budget stays small', () => {
    // A reflection that unlocked a large budget would just delay the same halt.
    assert.ok(REFLECTION_BONUS_ITERATIONS > 0 && REFLECTION_BONUS_ITERATIONS <= 5);
  });
});

suite('llm/reflection: signal plumbing', () => {
  test('emptyTurnSignals carries reflectionTurns at zero', () => {
    assert.strictEqual(emptyTurnSignals().reflectionTurns, 0);
  });

  test('addTurnSignals sums reflection turns', () => {
    const a = { ...emptyTurnSignals(), reflectionTurns: 1 };
    const b = { ...emptyTurnSignals(), reflectionTurns: 1 };
    assert.strictEqual(addTurnSignals(a, b).reflectionTurns, 2);
  });

  test('a reflecting turn is counted and reported', () => {
    const record: TurnRecord = {
      at: '2026-01-01T00:00:00.000Z',
      mode: 'act',
      outcome: 'loopDetected',
      signals: { ...emptyTurnSignals(), reflectionTurns: 1 },
    };
    const counters = recordTurn(emptyOutcomeCounters(), record);
    assert.strictEqual(counters.signals.reflectionTurns, 1);
    assert.strictEqual(summarizeOutcomeCounters(counters).turns, 1);
    assert.ok(/reflection turns/i.test(formatOutcomeReport(summarizeOutcomeCounters(counters))));
  });
});

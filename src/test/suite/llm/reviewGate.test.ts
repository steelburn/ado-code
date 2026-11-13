import * as assert from 'assert';
import {
  MAX_REVIEW_DIFF_CHARS,
  REVIEW_BONUS_ITERATIONS,
  buildReviewInstruction,
  formatReviewResume,
  isActionableRevise,
  parseReviewVerdict,
  truncateDiff,
} from '../../../llm/reviewGate';

suite('reviewGate — truncateDiff', () => {
  test('leaves a small diff untouched', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    const sliced = truncateDiff(diff);
    assert.strictEqual(sliced.diff, diff);
    assert.strictEqual(sliced.truncated, false);
  });

  test('keeps head and tail of a large diff and says so', () => {
    const head = 'HEAD-MARKER ' + 'a'.repeat(1000);
    const tail = 'TAIL-MARKER ' + 'z'.repeat(1000);
    const middle = 'm'.repeat(50_000);
    const sliced = truncateDiff(head + middle + tail, 2000);
    assert.strictEqual(sliced.truncated, true);
    assert.ok(sliced.diff.startsWith('HEAD-MARKER'), 'head must survive');
    assert.ok(sliced.diff.endsWith('z'.repeat(500)), 'tail must survive');
    assert.ok(sliced.diff.includes('review diff truncated'), 'the cut must be visible to the reviewer');
    assert.ok(!sliced.diff.includes('m'.repeat(3_000)), 'the middle must be gone');
    // Bounded: the kept text never exceeds the cap by more than the marker line.
    assert.ok(sliced.diff.length < 2000 + 200, `kept ${sliced.diff.length} chars`);
  });

  test('the default cap is smaller than a full-conversation read', () => {
    assert.ok(MAX_REVIEW_DIFF_CHARS > 0 && MAX_REVIEW_DIFF_CHARS <= 20_000);
  });
});

suite('reviewGate — buildReviewInstruction', () => {
  test('carries the diff, the file list and a three-line contract', () => {
    const text = buildReviewInstruction({
      diff: '+++ b/src/a.ts\n+const x = 1;',
      files: ['src/a.ts', 'src/b.ts'],
      truncated: false,
    });
    assert.ok(text.includes('const x = 1;'), 'the diff itself must reach the reviewer');
    assert.ok(text.includes('- src/a.ts') && text.includes('- src/b.ts'));
    assert.ok(text.includes('VERDICT: ship | revise'));
    assert.ok(text.includes('ISSUE:'));
    assert.ok(text.includes('NEXT:'));
    assert.ok(/do not call tools/i.test(text));
    assert.ok(!text.includes('too large to include'), 'no truncation note when nothing was cut');
  });

  test('admits when the diff was cut', () => {
    const text = buildReviewInstruction({ diff: 'x', files: ['a.ts'], truncated: true });
    assert.ok(/too large to include/i.test(text));
  });

  test('an empty file list does not produce a dangling heading', () => {
    const text = buildReviewInstruction({ diff: 'x', files: [], truncated: false });
    assert.ok(text.includes('(unknown)'));
  });

  test('tells the reviewer not to invent findings', () => {
    const text = buildReviewInstruction({ diff: 'x', files: ['a.ts'], truncated: false });
    assert.ok(/do not invent issues/i.test(text));
    assert.ok(/say ship/i.test(text));
  });
});

suite('reviewGate — parseReviewVerdict', () => {
  test('a clean ship block', () => {
    const v = parseReviewVerdict('VERDICT: ship\nISSUE: none\nNEXT: none');
    assert.strictEqual(v.verdict, 'ship');
    assert.strictEqual(v.issue, undefined);
    assert.strictEqual(v.nextStep, undefined);
  });

  test('a revise with both fields', () => {
    const v = parseReviewVerdict('VERDICT: revise\nISSUE: the caller was never updated\nNEXT: update src/b.ts');
    assert.strictEqual(v.verdict, 'revise');
    assert.strictEqual(v.issue, 'the caller was never updated');
    assert.strictEqual(v.nextStep, 'update src/b.ts');
    assert.strictEqual(isActionableRevise(v), true);
  });

  test('markdown dressing does not hide the block', () => {
    const v = parseReviewVerdict(
      ['**VERDICT:** revise', '- **ISSUE:** a stub was left in `load()`', '> **NEXT:** implement load()'].join('\n'),
    );
    assert.strictEqual(v.verdict, 'revise');
    assert.ok(v.issue?.includes('stub'));
    assert.ok(v.nextStep?.includes('implement'));
  });

  test('a fenced block is still a block', () => {
    const v = parseReviewVerdict('```\nVERDICT: revise\nISSUE: broken\nNEXT: fix it\n```');
    assert.strictEqual(v.verdict, 'revise');
    assert.strictEqual(v.nextStep, 'fix it');
  });

  test('a revise with no next step is downgraded to unknown', () => {
    const v = parseReviewVerdict('VERDICT: revise\nISSUE: something is off\nNEXT: none');
    assert.strictEqual(v.verdict, 'unknown');
    assert.strictEqual(v.issue, 'something is off');
    assert.strictEqual(isActionableRevise(v), false);
  });

  test('a revise with no NEXT line at all is downgraded too', () => {
    const v = parseReviewVerdict('VERDICT: revise\nISSUE: something is off');
    assert.strictEqual(v.verdict, 'unknown');
    assert.strictEqual(isActionableRevise(v), false);
  });

  test('placeholders are not next steps', () => {
    for (const placeholder of ['none', 'n/a', 'N/A', '-', 'nothing']) {
      const v = parseReviewVerdict(`VERDICT: revise\nNEXT: ${placeholder}`);
      assert.strictEqual(isActionableRevise(v), false, `${placeholder} must not count as a plan`);
    }
  });

  test('prose without a verdict line is read when it is unambiguous', () => {
    assert.strictEqual(parseReviewVerdict('Looks good to me — lgtm.').verdict, 'ship');
  });

  test('a prose complaint is actionable only when it says what to fix', () => {
    // Same downgrade as a plan-less block (invariant 2): a complaint the loop
    // cannot act on is not a revision.
    assert.strictEqual(parseReviewVerdict('This is broken: the caller does not compile.').verdict, 'unknown');
    const withPlan = parseReviewVerdict('This is broken: the caller does not compile.\nNEXT: update the caller in src/b.ts');
    assert.strictEqual(withPlan.verdict, 'revise');
    assert.strictEqual(isActionableRevise(withPlan), true);
  });

  test('an ambiguous verdict is unknown, never a guess', () => {
    assert.strictEqual(parseReviewVerdict('VERDICT: revise, not ship').verdict, 'unknown');
    assert.strictEqual(parseReviewVerdict('who knows').verdict, 'unknown');
    assert.strictEqual(parseReviewVerdict('').verdict, 'unknown');
    assert.strictEqual(parseReviewVerdict('   \n  ').verdict, 'unknown');
  });

  test('an echoed template is not a revision', () => {
    // The model repeating the contract back is a failure to answer, not a
    // finding — accepting the finish is the safe read (invariant 1).
    const v = parseReviewVerdict('VERDICT: ship | revise\nISSUE: <the one concrete defect, or "none">\nNEXT: <the exact next action>');
    assert.strictEqual(isActionableRevise(v), false);
  });

  test('a ship never carries a fix', () => {
    const v = parseReviewVerdict('VERDICT: ship\nISSUE: none\nNEXT: run the tests');
    assert.strictEqual(v.verdict, 'ship');
    assert.strictEqual(v.nextStep, undefined);
  });
});

suite('reviewGate — resume instruction', () => {
  test('names the defect and the fix', () => {
    const text = formatReviewResume({ verdict: 'revise', issue: 'callers not updated', nextStep: 'update src/b.ts' });
    assert.ok(text.includes('callers not updated'));
    assert.ok(text.includes('update src/b.ts'));
    assert.ok(/do not (re-?do|restart)/i.test(text));
  });

  test('the bonus is bounded and matches what the loop documents', () => {
    assert.ok(REVIEW_BONUS_ITERATIONS > 0 && REVIEW_BONUS_ITERATIONS <= 10);
  });
});

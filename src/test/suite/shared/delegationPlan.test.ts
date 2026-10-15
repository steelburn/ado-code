import * as assert from 'assert';
import {
    planDelegation,
    delegationRunId,
    delegationBranchName,
    formatDelegationStartMessage,
    delegationTrailScope,
    DelegationChildTask,
} from '../../../shared/delegationPlan';

/**
 * Mock ADO child-subtree lookup that records every call it receives, so the
 * prompt-only tests can assert that NO ADO request is attempted at all
 * (AD-01 acceptance criterion 3: "assert with a mocked ADO service").
 */
function mockAdo(children: DelegationChildTask[] = []) {
    const calls: Array<{ project: string; workItemId: number }> = [];
    const fetchChildSubtree = async (project: string, workItemId: number) => {
        calls.push({ project, workItemId });
        return children;
    };
    return { calls, fetchChildSubtree };
}

const child = (id: number, title = `Child ${id}`): DelegationChildTask =>
    ({ id, title, type: 'Task', state: 'Active' });

suite('shared/delegationPlan', () => {
    // ── The three-case matrix from AD-01 ────────────────────────────────
    suite('planDelegation', () => {
        test('no work item + no project → prompt-only, zero ADO calls', async () => {
            const ado = mockAdo([child(101)]);
            const plan = await planDelegation({ fetchChildSubtree: ado.fetchChildSubtree });

            assert.strictEqual(plan.mode, 'prompt-only');
            assert.strictEqual(plan.workItemId, undefined);
            assert.strictEqual(plan.title, undefined);
            assert.deepStrictEqual(plan.childTasks, []);
            assert.strictEqual(ado.calls.length, 0, 'prompt-only delegation must not touch ADO');
        });

        test('no work item + project → prompt-only, zero ADO calls', async () => {
            const ado = mockAdo([child(101)]);
            const plan = await planDelegation({
                project: 'MyProject',
                fetchChildSubtree: ado.fetchChildSubtree,
            });

            assert.strictEqual(plan.mode, 'prompt-only');
            assert.strictEqual(plan.workItemId, undefined);
            assert.strictEqual(ado.calls.length, 0, 'no work item means no child lookup');
        });

        test('work item but no project → run stays linked, child lookup skipped', async () => {
            const ado = mockAdo([child(101)]);
            const plan = await planDelegation({
                workItem: { id: 26758, title: 'AD-01' },
                fetchChildSubtree: ado.fetchChildSubtree,
            });

            assert.strictEqual(plan.mode, 'work-item');
            assert.strictEqual(plan.workItemId, 26758);
            assert.strictEqual(plan.title, 'AD-01');
            assert.deepStrictEqual(plan.childTasks, []);
            assert.strictEqual(ado.calls.length, 0, 'without a project no ADO call may be attempted');
        });

        test('work item + project → children fetched once for that project', async () => {
            const ado = mockAdo([child(101), child(102)]);
            const plan = await planDelegation({
                workItem: { id: 26758, title: 'AD-01' },
                project: 'MyProject',
                fetchChildSubtree: ado.fetchChildSubtree,
            });

            assert.strictEqual(plan.mode, 'work-item');
            assert.strictEqual(plan.workItemId, 26758);
            assert.deepStrictEqual(plan.childTasks.map(c => c.id), [101, 102]);
            assert.deepStrictEqual(ado.calls, [{ project: 'MyProject', workItemId: 26758 }]);
        });
    });

    // ── Naming fallbacks: no `run-…-undefined`, no `feature/ADO-undefined-…` ──
    suite('run id and branch naming', () => {
        test('run id carries the work item id', () => {
            assert.strictEqual(delegationRunId(26758, 1700000000000), 'run-1700000000000-26758');
        });

        test('run id uses a prompt marker when there is no work item', () => {
            const id = delegationRunId(undefined, 1700000000000);
            assert.ok(id.startsWith('run-1700000000000-prompt'), id);
            assert.ok(!id.includes('undefined'), id);
        });

        test('prompt-only run ids are unique within the same millisecond', () => {
            const now = 1700000000000;
            const ids = new Set([
                delegationRunId(undefined, now),
                delegationRunId(undefined, now),
                delegationRunId(undefined, now),
            ]);
            assert.strictEqual(ids.size, 3, 'prompt-only ids must not collide');
        });

        test('branch keeps the ADO-<id>-<slug> format with a work item', () => {
            assert.strictEqual(
                delegationBranchName(26758, 'AD-01 Decouple delegation!'),
                'feature/ADO-26758-ad-01-decouple-delegation',
            );
        });

        test('branch omits the ADO prefix without a work item', () => {
            const branch = delegationBranchName(undefined, 'Fix login bug');
            assert.strictEqual(branch, 'feature/agent-fix-login-bug');
            assert.ok(!branch.includes('undefined'), 'a prompt-only branch must never contain "undefined"');
        });

        test('branch falls back to agent-task when the title has no usable slug', () => {
            assert.strictEqual(delegationBranchName(undefined, '!!!'), 'feature/agent-task');
        });
    });

    // ── Run card / trail labelling ──────────────────────────────────────
    suite('formatDelegationStartMessage', () => {
        test('work-item mode names the item and the child count', () => {
            const plan = {
                mode: 'work-item' as const,
                workItemId: 26758,
                title: 'AD-01',
                childTasks: [child(101)],
            };
            const msg = formatDelegationStartMessage({ agentDisplayName: 'Claude', plan });
            assert.ok(msg.includes('🤖 **Delegated to Claude** for #26758 — AD-01'), msg);
            assert.ok(msg.includes('(including 1 child task(s))'), msg);
        });

        test('prompt-only mode says the run is not linked to a work item', () => {
            const plan = { mode: 'prompt-only' as const, childTasks: [] };
            const msg = formatDelegationStartMessage({ agentDisplayName: 'Claude', plan });
            assert.ok(msg.includes('not linked to a work item'), msg);
            assert.ok(!msg.includes('undefined'), msg);
        });

        test('trail scope names the item or the chat', () => {
            assert.strictEqual(
                delegationTrailScope({ mode: 'work-item', workItemId: 26758, childTasks: [] }),
                '#26758',
            );
            assert.strictEqual(
                delegationTrailScope({ mode: 'prompt-only', childTasks: [] }),
                'this chat (no work item)',
            );
        });
    });
});


// ---------------------------------------------------------------------------
// AD-02 - prompt-only hardening: unique branch identity + title fallback.
// ---------------------------------------------------------------------------
import { delegationBranchToken, delegationRunTitle } from '../../../shared/delegationPlan';

suite('shared/delegationPlan - AD-02 prompt-only hardening', () => {
    suite('delegationBranchToken', () => {
        test('is deterministic for the same run id', () => {
            assert.strictEqual(delegationBranchToken('run-1-prompt-1'), delegationBranchToken('run-1-prompt-1'));
        });

        test('differs for different run ids', () => {
            assert.notStrictEqual(delegationBranchToken('run-1-prompt-1'), delegationBranchToken('run-2-prompt-1'));
        });

        test('is branch-safe (lowercase alphanumeric only)', () => {
            assert.ok(/^[a-z0-9]+$/.test(delegationBranchToken('run-1791960389813-prompt-7')));
        });
    });

    suite('delegationBranchName - prompt-only uniqueness', () => {
        const prompt = 'Read and follow AGENTS.md';

        test('two different runs of the same prompt get distinct branches', () => {
            const a = delegationBranchName(undefined, prompt, 'run-100-prompt-1');
            const b = delegationBranchName(undefined, prompt, 'run-200-prompt-2');
            assert.notStrictEqual(a, b, 'prompt-only branches must be unique per run');
            assert.ok(a.startsWith('feature/agent-'), a);
            assert.ok(b.startsWith('feature/agent-'), b);
            assert.ok(!/undefined|null/.test(a), a);
            assert.ok(!/undefined|null/.test(b), b);
        });

        test('is deterministic for the same run id', () => {
            assert.strictEqual(
                delegationBranchName(undefined, prompt, 'run-100-prompt-1'),
                delegationBranchName(undefined, prompt, 'run-100-prompt-1'),
            );
        });

        test('a work item keeps the historic branch shape, plus a per-run token', () => {
            assert.strictEqual(delegationBranchName(42, 'Fix login bug'), 'feature/ADO-42-fix-login-bug');
            assert.strictEqual(
                delegationBranchName(42, 'Fix login bug', 'run-100-42'),
                `feature/ADO-42-fix-login-bug-${delegationBranchToken('run-100-42')}`,
            );
        });

        test('two runs of one work item never share a branch', () => {
            assert.notStrictEqual(
                delegationBranchName(42, 'Fix login bug', 'run-100-42'),
                delegationBranchName(42, 'Fix login bug', 'run-200-42'),
            );
        });

        test('degrades to feature/agent-<slug> when no run id is supplied', () => {
            assert.strictEqual(delegationBranchName(undefined, 'Fix login bug'), 'feature/agent-fix-login-bug');
        });

        test('never emits an id-less branch suffix for an empty prompt with a run id', () => {
            const b = delegationBranchName(undefined, '', 'run-1-prompt-1');
            assert.ok(b.startsWith('feature/agent-task-'), b);
        });
    });

    suite('delegationRunTitle', () => {
        test('an explicit title always wins (trimmed)', () => {
            assert.strictEqual(delegationRunTitle('some prompt', '  My title  '), 'My title');
        });

        test('falls back to the prompt first non-empty line', () => {
            assert.strictEqual(
                delegationRunTitle('\n  Read and follow AGENTS.md\nThen build'),
                'Read and follow AGENTS.md',
            );
        });

        test('truncates a very long first line', () => {
            assert.ok(delegationRunTitle('x'.repeat(200)).length <= 80);
        });

        test('never returns an empty string', () => {
            assert.strictEqual(delegationRunTitle(''), 'Agent delegation');
            assert.strictEqual(delegationRunTitle('   \n  '), 'Agent delegation');
            assert.strictEqual(delegationRunTitle('Read AGENTS.md', '   '), 'Read AGENTS.md');
        });
    });
});
// ---------------------------------------------------------------------------
// AD-03 - graceful ADO completion path when there is no work item / project.
// ---------------------------------------------------------------------------
import {
    isAdoLinked,
    runAdoRef,
    runWorkItemLabel,
    planRunCompletion,
    defaultRunCommitMessage,
    defaultRunPrTitle,
    workItemRequired,
} from '../../../shared/delegationPlan';

suite('shared/delegationPlan - AD-03 graceful ADO completion', () => {
    suite('isAdoLinked', () => {
        test('is true for a real work item id', () => {
            assert.strictEqual(isAdoLinked(26759), true);
        });

        test('is false when there is no work item', () => {
            assert.strictEqual(isAdoLinked(undefined), false);
        });

        test('treats NaN and 0 as not linked (not real ADO ids)', () => {
            assert.strictEqual(isAdoLinked(NaN), false);
            assert.strictEqual(isAdoLinked(0), false);
        });
    });

    suite('runAdoRef', () => {
        test('renders ADO-<id> for a linked run', () => {
            assert.strictEqual(runAdoRef(26759), 'ADO-26759');
        });

        test('is empty - never "ADO-undefined" - when unlinked', () => {
            assert.strictEqual(runAdoRef(undefined), '');
            assert.ok(!/undefined/.test(runAdoRef(undefined)));
        });
    });

    suite('runWorkItemLabel', () => {
        test('renders #<id> for a linked run', () => {
            assert.strictEqual(runWorkItemLabel(26759), '#26759');
        });

        test('reads "no work item" when unlinked - never "#?" or "#undefined"', () => {
            const label = runWorkItemLabel(undefined);
            assert.strictEqual(label, 'no work item');
            assert.ok(!/undefined/.test(label), label);
            assert.ok(!/\?/.test(label), label);
        });
    });

    suite('planRunCompletion', () => {
        test('ADO-linked run with children syncs and closes the parent', () => {
            const p = planRunCompletion({ workItemId: 42, childIds: [1, 2] });
            assert.strictEqual(p.adoLinked, true);
            assert.strictEqual(p.syncChildren, true);
            assert.strictEqual(p.completeParent, true);
            assert.strictEqual(p.recordOnWorkItem, true);
            assert.strictEqual(p.workItemLabel, '#42');
        });

        test('ADO-linked run delegated WITHOUT children never runs child completion', () => {
            const p = planRunCompletion({ workItemId: 42 });
            assert.strictEqual(p.adoLinked, true);
            assert.strictEqual(p.syncChildren, false);
            assert.strictEqual(p.completeParent, false);
            assert.strictEqual(p.recordOnWorkItem, true);
        });

        test('work-item-less run performs NO ADO work even with child ids', () => {
            const p = planRunCompletion({ childIds: [1, 2] });
            assert.strictEqual(p.adoLinked, false);
            assert.strictEqual(p.syncChildren, false);
            assert.strictEqual(p.completeParent, false);
            assert.strictEqual(p.recordOnWorkItem, false);
            assert.strictEqual(p.workItemLabel, 'no work item');
        });

        test('exposes the validated ids so callers never re-derive them', () => {
            const linked = planRunCompletion({ workItemId: 42, childIds: [7, 8] });
            assert.strictEqual(linked.workItemId, 42);
            assert.deepStrictEqual(linked.childIds, [7, 8]);
            const none = planRunCompletion({ childIds: [7, 8] });
            assert.strictEqual(none.workItemId, undefined);
            assert.deepStrictEqual(none.childIds, []);
        });

        test('no completion label ever contains the string "undefined"', () => {
            for (const wi of [undefined, 0, NaN, 1, 26759]) {
                const p = planRunCompletion({ workItemId: wi, childIds: [1] });
                assert.ok(!/undefined/.test(p.workItemLabel), `${wi} -> ${p.workItemLabel}`);
            }
        });
    });
});

// ---------------------------------------------------------------------------
// AD-04 - commit / push / PR defaults for work-item-less runs.
// ---------------------------------------------------------------------------
suite('shared/delegationPlan - AD-04 merge defaults', () => {
    suite('defaultRunCommitMessage', () => {
        test('keeps the historic ADO-<id>: <title> shape for a linked run', () => {
            assert.strictEqual(
                defaultRunCommitMessage({ workItemId: 26761, title: 'Fix login' }),
                'ADO-26761: Fix login',
            );
        });

        test('omits the work-item reference for a prompt-only run', () => {
            const msg = defaultRunCommitMessage({ title: 'Fix login' });
            assert.strictEqual(msg, 'agent: Fix login');
            assert.ok(!/ADO|undefined|\?/.test(msg), msg);
        });

        test('falls back to a non-empty message when the title is missing', () => {
            assert.strictEqual(defaultRunCommitMessage({}), 'agent: agent changes');
            assert.strictEqual(defaultRunCommitMessage({ workItemId: 5 }), 'ADO-5: agent changes');
        });
    });

    suite('defaultRunPrTitle', () => {
        test('keeps the historic ADO-<id>: <title> shape for a linked run', () => {
            assert.strictEqual(
                defaultRunPrTitle({ workItemId: 26761, title: 'Fix login' }),
                'ADO-26761: Fix login',
            );
        });

        test('renders the bare run title for a prompt-only run', () => {
            assert.strictEqual(defaultRunPrTitle({ title: 'Fix login' }), 'Fix login');
        });

        test('never renders an undefined / ADO-? PR title', () => {
            for (const run of [{}, { workItemId: undefined, title: 'x' }, { title: '' }] as const) {
                const title = defaultRunPrTitle(run);
                assert.ok(!/undefined|ADO-\?/.test(title), title);
                assert.ok(title.length > 0, 'PR title must be non-empty');
            }
        });
    });
});

// ---------------------------------------------------------------------------
// AD-06 - `adoCode.agents.requireWorkItem` opt-out decision.
// ---------------------------------------------------------------------------
suite('shared/delegationPlan - AD-06 requireWorkItem opt-out', () => {
    test('ON + no work item blocks (legacy guard restored)', () => {
        assert.strictEqual(workItemRequired(true, false), true);
    });

    test('ON + work item allows delegation', () => {
        assert.strictEqual(workItemRequired(true, true), false);
    });

    test('OFF (default) allows a prompt-only run', () => {
        assert.strictEqual(workItemRequired(false, false), false);
        assert.strictEqual(workItemRequired(false, true), false);
    });
});

// ── Bug #26935: the task-branch / run title comes from the fetched work item ──
import { resolveWorkItemTitle } from '../../../shared/delegationPlan';

suite('shared/delegationPlan — resolveWorkItemTitle (bug #26935)', () => {
    test('uses System.Title, trimmed, when present', () => {
        assert.strictEqual(resolveWorkItemTitle({ 'System.Title': 'Fix login' }, 42), 'Fix login');
        assert.strictEqual(resolveWorkItemTitle({ 'System.Title': '  Fix login  ' }, 42), 'Fix login');
    });

    test('falls back to a neutral title — never undefined — when the title is absent or blank', () => {
        assert.strictEqual(resolveWorkItemTitle(undefined, 42), 'Work item 42');
        assert.strictEqual(resolveWorkItemTitle({}, 7), 'Work item 7');
        assert.strictEqual(resolveWorkItemTitle({ 'System.Title': '' }, 42), 'Work item 42');
        assert.strictEqual(resolveWorkItemTitle({ 'System.Title': '   ' }, 42), 'Work item 42');
        assert.strictEqual(resolveWorkItemTitle({ 'System.Title': 123 }, 42), 'Work item 42');
    });

    test('the resolved title feeds a branch name that never contains "undefined"', () => {
        const branch = delegationBranchName(42, resolveWorkItemTitle(undefined, 42), 'run-1');
        assert.ok(branch.startsWith('feature/ADO-42-'), branch);
        assert.ok(!branch.includes('undefined'), branch);
    });
});

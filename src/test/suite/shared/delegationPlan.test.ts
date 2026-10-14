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

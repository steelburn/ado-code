import * as assert from 'assert';
import {
  WorkItemDraftQueue,
  WorkItemDraft,
  DraftCreateResult,
  normalizeParentRef,
  DRAFT_QUEUE_SCHEMA_VERSION,
  encodeDraftQueue,
  decodeDraftQueue,
  hasPendingDrafts,
} from '../../../shared/draftQueue';

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` holds, or fail the test after ~1s. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Executor that succeeds for every row, recording each call in order. */
function recordingExecutor(calls: WorkItemDraft[], delayMs = 0) {
  return async (draft: WorkItemDraft): Promise<DraftCreateResult> => {
    calls.push(draft);
    if (delayMs) {
      await tick(delayMs);
    }
    return { id: 100 + calls.length, url: 'https://example.test/' + (100 + calls.length) };
  };
}

function draftInput(title: string, extra: Partial<Parameters<WorkItemDraftQueue['enqueue']>[0]> = {}) {
  return { workItemType: 'Task', title, ...extra };
}

suite('shared/draftQueue', () => {
  test('enqueue appends a pending row with an incrementing id', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const first = queue.enqueue(draftInput('One'));
    const second = queue.enqueue(draftInput('Two'));

    assert.strictEqual(first.id, 'draft-1');
    assert.strictEqual(second.id, 'draft-2');
    assert.strictEqual(first.status, 'pending');
    assert.strictEqual(first.origin, 'tool');
    assert.strictEqual(queue.list().length, 2);
    assert.deepStrictEqual(queue.counts(), { pending: 2, accepted: 0, rejected: 0, blocked: 0, creating: 0, created: 0, failed: 0 });
    queue.dispose();
  });

  test('normalises an existing ADO parent into a canonical ParentRef', () => {
    // Case A: the parent already lives in ADO, so its id is carried verbatim.
    assert.deepStrictEqual(normalizeParentRef({ parentWorkItemId: 42 }), { kind: 'ado', id: 42 });
    // Case B (model only): a parent that is itself a draft.
    assert.deepStrictEqual(normalizeParentRef({ parentLocalId: 'draft-1' }), { kind: 'draft', id: 'draft-1' });
    // No ancestry at all stays undefined rather than a falsy ref.
    assert.strictEqual(normalizeParentRef({}), undefined);
    assert.strictEqual(normalizeParentRef({ parentWorkItemId: 0 }), undefined);
  });

  test('resolves a draft parent through the queue once the parent is created', async () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const child = queue.enqueue(draftInput('Child', { parentWorkItemId: 77 }));
    assert.strictEqual(queue.parentAdoIdOf(child), 77);

    // An unsaved draft parent has no ADO id yet.
    const nested = queue.enqueue(draftInput('Nested', { parentLocalId: 'draft-1' }));
    assert.deepStrictEqual(nested.parentRef, { kind: 'draft', id: 'draft-1' });
    queue.dispose();
  });

  test('accepts rows in any order — the last row can be created first', async () => {
    const calls: WorkItemDraft[] = [];
    const queue = new WorkItemDraftQueue(recordingExecutor(calls));
    queue.enqueue(draftInput('One'));
    queue.enqueue(draftInput('Two'));
    const third = queue.enqueue(draftInput('Three'));

    // Accept out of generation order: this is the whole point of the queue.
    assert.strictEqual(queue.accept([third.id]), 1);
    queue.finalize();
    await waitFor(() => queue.get(third.id)?.status === 'created', 'draft-3 to be created');

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].title, 'Three');
    assert.strictEqual(queue.get(third.id)?.createdWorkItemId, 101);
    assert.strictEqual(queue.get('draft-1')?.status, 'pending', 'untouched rows stay pending');
    queue.dispose();
  });

  test('bulk accept creates rows one at a time, never in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const queue = new WorkItemDraftQueue(async (draft) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(draft.title);
      await tick(5);
      inFlight -= 1;
      return { id: 500, url: 'https://example.test/500' };
    });

    const ids = ['a', 'b', 'c', 'd'].map((title) => queue.enqueue(draftInput(title)).id);
    assert.strictEqual(queue.accept(ids), 4);
    queue.finalize();
    await waitFor(() => queue.counts().created === 4, 'all four rows to be created');

    assert.strictEqual(maxInFlight, 1, 'ADO writes must be serialised, one at a time');
    assert.deepStrictEqual(order, ['a', 'b', 'c', 'd'], 'execution follows enqueue order');
    queue.dispose();
  });

  test('accepting an already created row is a no-op', async () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const draft = queue.enqueue(draftInput('Once'));
    assert.strictEqual(queue.accept([draft.id]), 1);
    queue.finalize();
    await waitFor(() => queue.get(draft.id)?.status === 'created', 'the row to be created');
    assert.strictEqual(queue.accept([draft.id]), 0, 'a second accept must not create a duplicate');
    queue.finalize();
    queue.dispose();
  });

  test('a failed row captures the error, and retry creates it', async () => {
    let shouldFail = true;
    const queue = new WorkItemDraftQueue(async () => {
      if (shouldFail) {
        throw new Error('ADO rejected the payload');
      }
      return { id: 900, url: 'https://example.test/900' };
    });

    const draft = queue.enqueue(draftInput('Flaky'));
    queue.accept([draft.id]);
    queue.finalize();
    await waitFor(() => queue.get(draft.id)?.status === 'failed', 'the row to fail');

    assert.strictEqual(queue.get(draft.id)?.error, 'ADO rejected the payload');
    assert.strictEqual(queue.get(draft.id)?.createdWorkItemId, undefined);

    shouldFail = false;
    assert.strictEqual(queue.retry([draft.id]), 1);
    queue.finalize();
    await waitFor(() => queue.get(draft.id)?.status === 'created', 'the retry to succeed');
    assert.strictEqual(queue.get(draft.id)?.error, undefined, 'success clears the stale error');
    assert.strictEqual(queue.get(draft.id)?.createdWorkItemId, 900);
    queue.dispose();
  });

  test('a failure does not abort the rest of a bulk accept', async () => {
    const queue = new WorkItemDraftQueue(async (draft) => {
      if (draft.title === 'Bad') {
        throw new Error('nope');
      }
      return { id: 1, url: 'https://example.test/1' };
    });

    const ids = ['Good', 'Bad', 'Good2'].map((title) => queue.enqueue(draftInput(title)).id);
    queue.accept(ids);
    queue.finalize();
    await waitFor(() => queue.counts().pending === 0 && queue.counts().creating === 0, 'the batch to drain');

    assert.deepStrictEqual(queue.counts(), { pending: 0, accepted: 0, rejected: 0, blocked: 0, creating: 0, created: 2, failed: 1 });
    queue.dispose();
  });

  test('editing a failed row clears the error and returns it to pending', async () => {
    const queue = new WorkItemDraftQueue(async () => { throw new Error('boom'); });
    const draft = queue.enqueue(draftInput('Typo'));
    queue.accept([draft.id]);
    queue.finalize();
    await waitFor(() => queue.get(draft.id)?.status === 'failed', 'the row to fail');

    assert.strictEqual(queue.update(draft.id, { title: 'Fixed' }), true);
    const updated = queue.get(draft.id);
    assert.strictEqual(updated?.title, 'Fixed');
    assert.strictEqual(updated?.status, 'pending');
    assert.strictEqual(updated?.error, undefined);
    queue.dispose();
  });

  test('a row being created cannot be edited or rejected', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new WorkItemDraftQueue(async () => {
      await gate;
      return { id: 5, url: 'https://example.test/5' };
    });

    const draft = queue.enqueue(draftInput('In flight'));
    queue.accept([draft.id]);
    queue.finalize();
    assert.strictEqual(queue.get(draft.id)?.status, 'creating');

    assert.strictEqual(queue.update(draft.id, { title: 'Sneaky' }), false, 'edit must be refused while creating');
    assert.strictEqual(queue.reject([draft.id]), 0, 'reject must be refused while creating');
    queue.finalize();

    release();
    await waitFor(() => queue.get(draft.id)?.status === 'created', 'the row to finish creating');
    queue.dispose();
  });

  test('reject stages a pending row and finalize drops it', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const keep = queue.enqueue(draftInput('Keep'));
    const drop = queue.enqueue(draftInput('Drop'));

    assert.strictEqual(queue.reject([drop.id]), 1);
    queue.finalize();
    assert.deepStrictEqual(queue.list().map((draft) => draft.id), [keep.id]);
    assert.strictEqual(queue.get(drop.id), undefined);
    queue.dispose();
  });

  test('rows stranded in creating at restore come back as failed, not pending', () => {
    // A reload can kill the host mid-create: the ADO write may or may not have
    // landed, so the row must not silently invite a duplicate.
    const stranded = {
      ...draftInput('Stranded'),
      id: 'draft-3',
      origin: 'tool' as const,
      status: 'creating' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const created = {
      ...draftInput('Done'),
      id: 'draft-1',
      origin: 'tool' as const,
      status: 'created' as const,
      createdWorkItemId: 12,
      createdAt: 1,
      updatedAt: 1,
    };

    const queue = new WorkItemDraftQueue(recordingExecutor([]), [created, stranded]);
    const restored = queue.get('draft-3');
    assert.strictEqual(restored?.status, 'failed');
    assert.match(String(restored?.error), /ADO/);

    assert.strictEqual(queue.get('draft-1')?.status, 'created', 'finished rows restore untouched');
    assert.strictEqual(queue.get('draft-1')?.createdWorkItemId, 12);
    queue.dispose();
  });

  test('restored ids continue the sequence instead of colliding', () => {
    const restored = {
      ...draftInput('Old'),
      id: 'draft-7',
      origin: 'tool' as const,
      status: 'pending' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const queue = new WorkItemDraftQueue(recordingExecutor([]), [restored]);
    assert.strictEqual(queue.enqueue(draftInput('New')).id, 'draft-8');
    queue.dispose();
  });

  test('onChange emits a snapshot per mutation and stops after unsubscribe', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const seen: number[] = [];
    const unsubscribe = queue.onChange((snapshot) => seen.push(snapshot.length));

    const draft = queue.enqueue(draftInput('One'));
    queue.enqueue(draftInput('Two'));
    queue.reject([draft.id]);
    // reject only STAGES: the row is still there (length 2). finalize is what
    // drops it, so it is a second emission — and the only one that shrinks.
    queue.finalize();
    assert.deepStrictEqual(seen, [1, 2, 2, 1]);

    unsubscribe();
    queue.enqueue(draftInput('Three'));
    assert.deepStrictEqual(seen, [1, 2, 2, 1], 'no emission after unsubscribe');
    queue.dispose();
  });

  // ── staged decisions: reversible until finalize ──────────────────────────
  // Accept and reject only record INTENT. ADO is written by finalize() alone,
  // which is the only reason "undo accept" can be honest.

  test('accept stages the decision without writing to ADO', () => {
    const calls: WorkItemDraft[] = [];
    const queue = new WorkItemDraftQueue(recordingExecutor(calls));
    const draft = queue.enqueue(draftInput('Stage me'));

    assert.strictEqual(queue.accept([draft.id]), 1);
    assert.strictEqual(queue.get(draft.id)?.status, 'accepted');
    assert.strictEqual(calls.length, 0, 'accept alone must never reach ADO');
    assert.deepStrictEqual(
      queue.counts(),
      { pending: 0, accepted: 1, rejected: 0, blocked: 0, creating: 0, created: 0, failed: 0 },
    );
    queue.dispose();
  });

  test('undo takes a staged accept back before anything is created', () => {
    const calls: WorkItemDraft[] = [];
    const queue = new WorkItemDraftQueue(recordingExecutor(calls));
    const draft = queue.enqueue(draftInput('Undo me'));

    queue.accept([draft.id]);
    assert.strictEqual(queue.undo([draft.id]), 1);
    assert.strictEqual(queue.get(draft.id)?.status, 'pending');

    queue.finalize();
    assert.strictEqual(calls.length, 0, 'an undone accept must never reach ADO');
    queue.dispose();
  });

  test('reject keeps the row, undo restores it, finalize finally drops it', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const draft = queue.enqueue(draftInput('Reject me'));

    assert.strictEqual(queue.reject([draft.id]), 1);
    assert.strictEqual(queue.get(draft.id)?.status, 'rejected', 'a rejected row stays reviewable');
    assert.strictEqual(queue.list().length, 1, 'and is not silently discarded');

    assert.strictEqual(queue.undo([draft.id]), 1);
    assert.strictEqual(queue.get(draft.id)?.status, 'pending');

    queue.reject([draft.id]);
    queue.finalize();
    assert.strictEqual(queue.get(draft.id), undefined, 'finalize commits the rejection');
    queue.dispose();
  });

  test('switching a decision replaces it instead of stacking', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const draft = queue.enqueue(draftInput('Flip flop'));

    queue.accept([draft.id]);
    queue.reject([draft.id]);
    assert.strictEqual(queue.get(draft.id)?.status, 'rejected');
    queue.accept([draft.id]);
    assert.strictEqual(queue.get(draft.id)?.status, 'accepted');
    queue.dispose();
  });

  test('editing a decided row clears the decision', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const draft = queue.enqueue(draftInput('Typo'));
    queue.reject([draft.id]);

    assert.strictEqual(queue.update(draft.id, { title: 'Fixed' }), true);
    assert.strictEqual(queue.get(draft.id)?.status, 'pending', 'the decision is undone by the edit');
    assert.strictEqual(queue.get(draft.id)?.title, 'Fixed');
    queue.dispose();
  });

  test('a rejected row is never the duplicate a live row is compared against', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const first = queue.enqueue(draftInput('Same title'));
    const second = queue.enqueue(draftInput('Same title'));
    assert.strictEqual(queue.get(second.id)?.duplicateOf, first.id);

    queue.reject([first.id]);
    assert.strictEqual(
      queue.get(second.id)?.duplicateOf,
      undefined,
      'a rejected row is not a competing item any more',
    );
    queue.dispose();
  });

  test('a throwing listener cannot stop the pump', async () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    queue.onChange(() => { throw new Error('broken webview'); });
    const draft = queue.enqueue(draftInput('One'));

    queue.accept([draft.id]);
    queue.finalize();
    await waitFor(() => queue.get(draft.id)?.status === 'created', 'the pump to survive a bad listener');
    queue.dispose();
  });
  // ---- wart fixes: no tombstones, failures survive clearing, duplicates warn ----

  test('a staged reject survives until finalize, then leaves the queue', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const draft = queue.enqueue(draftInput('Discard me'));

    assert.strictEqual(queue.reject([draft.id]), 1);
    queue.finalize();
    assert.deepStrictEqual(queue.list(), []);
    assert.deepStrictEqual(queue.counts(), { pending: 0, accepted: 0, rejected: 0, blocked: 0, creating: 0, created: 0, failed: 0 });
    queue.dispose();
  });

  test('clearCreated removes created rows but keeps failed ones retryable', async () => {
    let attempt = 0;
    const queue = new WorkItemDraftQueue(async () => {
      attempt += 1;
      if (attempt === 2) {
        throw new Error('ADO said no');
      }
      return { id: 100 + attempt, url: 'https://example.test/' + attempt };
    });

    const good = queue.enqueue(draftInput('Good'));
    const bad = queue.enqueue(draftInput('Bad'));
    queue.accept([good.id]);
    queue.finalize();
    await waitFor(() => queue.get(good.id)?.status === 'created', 'the first row to be created');
    queue.accept([bad.id]);
    queue.finalize();
    await waitFor(() => queue.get(bad.id)?.status === 'failed', 'the second row to fail');

    assert.strictEqual(queue.clearCreated(), 1);
    assert.strictEqual(queue.get(good.id), undefined);
    assert.strictEqual(queue.get(bad.id)?.status, 'failed');
    assert.ok(queue.get(bad.id)?.error, 'the failure keeps its error so Retry still means something');
    queue.dispose();
  });

  test('flags a duplicate drafted twice, case and whitespace insensitive', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const first = queue.enqueue(draftInput('Add the export button', { parentWorkItemId: 7 }));
    const second = queue.enqueue(draftInput('  add the   export BUTTON ', { parentWorkItemId: 7 }));

    assert.strictEqual(queue.get(first.id)?.duplicateOf, undefined);
    assert.strictEqual(queue.get(second.id)?.duplicateOf, first.id);
    queue.dispose();
  });

  test('does not flag the same title under another parent or work item type', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    queue.enqueue(draftInput('Same title', { parentWorkItemId: 7 }));
    const otherParent = queue.enqueue(draftInput('Same title', { parentWorkItemId: 8 }));
    const otherType = queue.enqueue(draftInput('Same title', { workItemType: 'Bug', parentWorkItemId: 7 }));

    assert.strictEqual(queue.get(otherParent.id)?.duplicateOf, undefined);
    assert.strictEqual(queue.get(otherType.id)?.duplicateOf, undefined);
    queue.dispose();
  });

  test('a duplicate flag follows the row it points at being renamed or rejected', () => {
    const queue = new WorkItemDraftQueue(recordingExecutor([]));
    const first = queue.enqueue(draftInput('Shared title'));
    const second = queue.enqueue(draftInput('Shared title'));
    assert.strictEqual(queue.get(second.id)?.duplicateOf, first.id);

    assert.strictEqual(queue.update(second.id, { title: 'Different now' }), true);
    assert.strictEqual(queue.get(second.id)?.duplicateOf, undefined);

    queue.update(second.id, { title: 'Shared title' });
    assert.strictEqual(queue.get(second.id)?.duplicateOf, first.id);

    queue.reject([first.id]);
    queue.finalize();
    assert.strictEqual(queue.get(second.id)?.duplicateOf, undefined);
    queue.dispose();
  });

  test('duplicates warn but do not block: accepting both still creates two items', async () => {
    const calls: WorkItemDraft[] = [];
    const queue = new WorkItemDraftQueue(recordingExecutor(calls));
    const first = queue.enqueue(draftInput('Twin'));
    const second = queue.enqueue(draftInput('Twin'));

    queue.accept([first.id, second.id]);
    queue.finalize();
    await waitFor(() => queue.counts().created === 2, 'both duplicates to be created');

    assert.strictEqual(calls.length, 2);
    queue.dispose();
  });
});


suite('shared/draftQueue — Case B nesting', () => {
  type Call = { id: string; title: string; parentAdoId?: number };

  function makeQueue() {
    const calls: Call[] = [];
    let nextId = 900;
    const queue = new WorkItemDraftQueue(async (draft, context) => {
      calls.push({ id: draft.id, title: draft.title ?? '', parentAdoId: context.parentAdoId });
      if ((draft.title ?? '').startsWith('FAIL')) throw new Error('ADO refused the create');
      nextId += 1;
      return { id: nextId, url: 'https://ado.example/' + nextId };
    });
    return { queue, calls };
  }

  function draft(title: string, over: Record<string, unknown> = {}) {
    return { workItemType: 'Task', title, ...over } as any;
  }

  test('a nested child waits in blocked instead of failing, then follows its parent', async () => {
    const { queue, calls } = makeQueue();
    const parent = queue.enqueue(draft('Parent story', { workItemType: 'User Story' }));
    const child = queue.enqueue(draft('Child task', { parentLocalId: parent.id }));

    // Deliberately the wrong order: the child is accepted first.
    queue.accept([child.id]);
    queue.accept([parent.id]);

    const result = queue.finalize();
    assert.deepStrictEqual(result, { queued: 1, removed: 0, blocked: 1 });
    assert.strictEqual(queue.get(child.id)!.status, 'blocked');
    assert.strictEqual(queue.get(child.id)!.blockedBy, parent.id);
    assert.strictEqual(queue.counts().blocked, 1);

    await waitFor(() => queue.counts().created === 2, 'the chain to drain');
    const parentAdoId = queue.get(parent.id)!.createdWorkItemId;
    assert.strictEqual(queue.get(child.id)!.status, 'created');
    assert.strictEqual(queue.get(child.id)!.blockedBy, undefined);
    assert.deepStrictEqual(
      calls.map((call) => [call.title, call.parentAdoId]),
      [['Parent story', undefined], ['Child task', parentAdoId]],
    );
  });

  test('a three-level chain is created depth-first, whatever order it was accepted in', async () => {
    const { queue, calls } = makeQueue();
    const root = queue.enqueue(draft('Root', { workItemType: 'Feature' }));
    const mid = queue.enqueue(draft('Mid', { workItemType: 'User Story', parentLocalId: root.id }));
    const leaf = queue.enqueue(draft('Leaf', { parentLocalId: mid.id }));

    queue.accept([leaf.id, mid.id, root.id]);
    queue.finalize();
    await waitFor(() => queue.counts().created === 3, 'the tree to drain');

    assert.deepStrictEqual(calls.map((call) => call.title), ['Root', 'Mid', 'Leaf']);
    assert.deepStrictEqual(calls.map((call) => call.parentAdoId), [
      undefined,
      queue.get(root.id)!.createdWorkItemId,
      queue.get(mid.id)!.createdWorkItemId,
    ]);
  });

  test('a failed parent leaves its child blocked and naming the parent', async () => {
    const { queue, calls } = makeQueue();
    const parent = queue.enqueue(draft('FAIL parent', { workItemType: 'User Story' }));
    const child = queue.enqueue(draft('Child', { parentLocalId: parent.id }));

    queue.accept([parent.id, child.id]);
    queue.finalize();
    await waitFor(() => queue.get(parent.id)!.status === 'failed', 'the parent to fail');
    await tick(10);

    assert.strictEqual(queue.get(child.id)!.status, 'blocked');
    assert.strictEqual(queue.get(child.id)!.blockedBy, parent.id);
    assert.strictEqual(calls.length, 1, 'the child must never be sent without a parent id');
  });

  test('rejecting a mid-tree draft reparents its children to the surviving ADO ancestor', () => {
    const { queue } = makeQueue();
    const root = queue.enqueue(draft('Story', { workItemType: 'User Story', parentWorkItemId: 4242 }));
    const mid = queue.enqueue(draft('Task', { parentLocalId: root.id }));
    const leaf = queue.enqueue(draft('Subtask', { parentLocalId: mid.id }));

    queue.reject([mid.id]);
    const result = queue.finalize();

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(queue.get(mid.id), undefined);
    // root survives, so the leaf hangs off root — still a draft ref, and it is
    // resolved to root's ADO id when root is created.
    assert.deepStrictEqual(queue.get(leaf.id)!.parentRef, { kind: 'draft', id: root.id });
    assert.strictEqual(queue.get(leaf.id)!.reparentedFrom, mid.id);
    assert.strictEqual(queue.get(leaf.id)!.parentWorkItemId, undefined);
  });

  test('a whole rejected chain falls through to the nearest ADO ancestor', () => {
    const { queue } = makeQueue();
    const root = queue.enqueue(draft('Story', { workItemType: 'User Story', parentWorkItemId: 4242 }));
    const mid = queue.enqueue(draft('Task', { parentLocalId: root.id }));
    const leaf = queue.enqueue(draft('Subtask', { parentLocalId: mid.id }));

    queue.reject([root.id, mid.id]);
    queue.finalize();

    assert.deepStrictEqual(queue.get(leaf.id)!.parentRef, { kind: 'ado', id: 4242 });
    assert.strictEqual(queue.get(leaf.id)!.parentWorkItemId, 4242);
  });

  test('rejecting a draft root with no ADO ancestor promotes its children to the top', () => {
    const { queue } = makeQueue();
    const root = queue.enqueue(draft('Story', { workItemType: 'User Story' }));
    const child = queue.enqueue(draft('Task', { parentLocalId: root.id }));

    queue.reject([root.id]);
    queue.finalize();

    assert.strictEqual(queue.get(child.id)!.parentRef, undefined);
    assert.strictEqual(queue.get(child.id)!.reparentedFrom, root.id);
  });

  test('an ADO-invalid parent/child type edge is warned about, not blocked', () => {
    const { queue } = makeQueue();
    const parent = queue.enqueue(draft('Parent task', { workItemType: 'Task' }));
    const child = queue.enqueue(draft('Child task', { parentLocalId: parent.id }));

    assert.match(queue.get(child.id)!.hierarchyWarning ?? '', /cannot be a child of Task/);
    assert.strictEqual(queue.get(child.id)!.status, 'pending');

    queue.update(parent.id, { workItemType: 'User Story' });
    assert.strictEqual(queue.get(child.id)!.hierarchyWarning, undefined);
  });

  test('a restored blocked row becomes accepted so the next finalize re-decides', () => {
    const { queue } = makeQueue();
    const parent = queue.enqueue(draft('Parent', { workItemType: 'User Story' }));
    const child = queue.enqueue(draft('Child', { parentLocalId: parent.id }));
    queue.accept([parent.id, child.id]);
    const snapshot = queue.list();
    const restored = new WorkItemDraftQueue(async () => ({ id: 1, url: 'u' }), JSON.parse(JSON.stringify(snapshot)));

    assert.strictEqual(restored.get(child.id)!.status, 'accepted');
    assert.strictEqual(restored.get(child.id)!.blockedBy, undefined);
    assert.deepStrictEqual(restored.get(child.id)!.parentRef, { kind: 'draft', id: parent.id });
  });

  // ── Tolerant breakdown parsing ────────────────────────────────────
  // The prompt asks for unique local ids, but a prompt is not a schema: a legacy
  // flat breakdown carries none, and a hallucinated parent can dangle or cycle.
  // Each case must be repaired into a flat row — never an uncreatable orphan.

  test('a breakdown with no local ids enqueues flat rows', () => {
    const { queue } = makeQueue();
    const rows = queue.enqueueMany([draft('One'), draft('Two'), draft('Three')]);

    assert.deepStrictEqual(rows.map((row) => row.parentRef), [undefined, undefined, undefined]);
  });

  test('positional ids make parentLocalId resolvable without an explicit localId', () => {
    const { queue } = makeQueue();
    const rows = queue.enqueueMany([draft('Epic'), draft('Story', { parentLocalId: 't1' })]);

    assert.deepStrictEqual(rows[1].parentRef, { kind: 'draft', id: rows[0].id });
    assert.strictEqual(rows[0].parentRef, undefined);
  });

  test('a dangling parentLocalId falls back to the ADO parent', () => {
    const { queue } = makeQueue();
    const rows = queue.enqueueMany([
      draft('Task', { parentWorkItemId: 4242 }),
      draft('Orphan', { parentLocalId: 'does-not-exist', parentWorkItemId: 4242 }),
    ]);

    assert.deepStrictEqual(rows[1].parentRef, { kind: 'ado', id: 4242 });
    assert.strictEqual(queue.get(rows[1].id)!.status, 'pending');
  });

  test('a self-parented entry is flattened instead of blocking itself', () => {
    const { queue } = makeQueue();
    const rows = queue.enqueueMany([draft('Self', { localId: 'a', parentLocalId: 'a' })]);

    assert.strictEqual(rows[0].parentRef, undefined);
  });

  test('a cycle between two entries is broken rather than left permanently blocked', () => {
    const { queue } = makeQueue();
    const rows = queue.enqueueMany([
      draft('A', { localId: 'a', parentLocalId: 'b' }),
      draft('B', { localId: 'b', parentLocalId: 'a' }),
    ]);

    assert.strictEqual(rows[0].parentRef, undefined);
    assert.strictEqual(rows[1].parentRef, undefined);
    // Decisions still stage normally: a broken cycle must not look "stuck".
    queue.accept([rows[0].id, rows[1].id]);
    assert.deepStrictEqual(queue.list().map((row) => row.status), ['accepted', 'accepted']);
  });

  test('a synthesised id never steals an explicit id claimed by another entry', () => {
    const { queue } = makeQueue();
    // Row 1 declares 't2' explicitly, so row 2 must NOT be synthesised as 't2' —
    // a positional collision here silently reparents row 3 to the wrong row.
    const rows = queue.enqueueMany([
      draft('First', { localId: 't2' }),
      draft('Second'),
      draft('Child', { parentLocalId: 't2' }),
    ]);

    const ids = rows.map((row) => row.id);
    assert.strictEqual(new Set(ids).size, 3);
    assert.deepStrictEqual(rows[2].parentRef, { kind: 'draft', id: rows[0].id });
  });

  test('duplicate local ids are renumbered so a later row keeps its own children', () => {
    const { queue } = makeQueue();
    const rows = queue.enqueueMany([
      draft('First', { localId: 'x' }),
      draft('Second', { localId: 'x' }),
      draft('Child', { parentLocalId: 't2' }),
    ]);

    assert.deepStrictEqual(rows[2].parentRef, { kind: 'draft', id: rows[1].id });
  });

  suite('persisted snapshot codec', () => {
    const row = (id: string): WorkItemDraft => ({
      id,
      workItemType: 'Task',
      title: 'Row',
      status: 'pending',
      origin: 'tool',
      createdAt: 1,
      updatedAt: 2,
    });

    test('a queue round-trips through encode/decode unchanged', () => {
      const queue = new WorkItemDraftQueue(recordingExecutor([]));
      queue.enqueue({ workItemType: 'Task', title: 'Persisted' });

      const encoded = encodeDraftQueue(queue.list());
      assert.strictEqual(encoded.v, DRAFT_QUEUE_SCHEMA_VERSION);

      const decoded = decodeDraftQueue(JSON.parse(JSON.stringify(encoded)));
      assert.strictEqual(decoded.kind, 'ok');
      if (decoded.kind !== 'ok') return;
      assert.strictEqual(decoded.needsRewrite, false);
      // workspaceState serialises to JSON, so explicit `undefined` fields do not
      // survive — compare against the same round trip, not the live rows.
      assert.deepStrictEqual(decoded.items, JSON.parse(JSON.stringify(queue.list())));
    });

    test('a bare array is read as version 1 and flagged for rewrite', () => {
      const decoded = decodeDraftQueue([row('draft-1')]);
      assert.strictEqual(decoded.kind, 'ok');
      if (decoded.kind !== 'ok') return;
      assert.strictEqual(decoded.version, 1);
      assert.strictEqual(decoded.needsRewrite, true);
      assert.strictEqual(decoded.items.length, 1);
    });

    test('a newer schema is refused instead of coerced', () => {
      const decoded = decodeDraftQueue({ v: DRAFT_QUEUE_SCHEMA_VERSION + 1, drafts: [row('draft-1')] });
      assert.deepStrictEqual(decoded, { kind: 'unsupported', version: DRAFT_QUEUE_SCHEMA_VERSION + 1 });
    });

    test('unrecognised or missing storage reads as empty', () => {
      for (const raw of [undefined, null, 42, 'nope', {}, { v: 2 }, { v: 2, drafts: 'nope' }]) {
        assert.deepStrictEqual(decodeDraftQueue(raw), { kind: 'empty' }, `raw=${JSON.stringify(raw)}`);
      }
    });

    test('a decoded snapshot hydrates a fresh queue', () => {
      const source = new WorkItemDraftQueue(recordingExecutor([]));
      source.enqueue({ workItemType: 'Bug', title: 'Restored from disk' });

      const decoded = decodeDraftQueue(encodeDraftQueue(source.list()));
      assert.strictEqual(decoded.kind, 'ok');
      if (decoded.kind !== 'ok') return;

      const restored = new WorkItemDraftQueue(recordingExecutor([]));
      restored.hydrate(decoded.items);
      assert.strictEqual(restored.list()[0].title, 'Restored from disk');
      assert.strictEqual(restored.list()[0].status, 'pending');
    });
  });
});

suite('draftQueue — hasPendingDrafts (does anything still need the user?)', () => {
  const row = (status: string): WorkItemDraft => ({ id: `draft-${status}`, status } as WorkItemDraft);

  test('an empty queue asks for nothing', () => {
    assert.strictEqual(hasPendingDrafts([]), false);
  });

  test('every status but created still owes the user something', () => {
    for (const status of ['pending', 'accepted', 'rejected', 'creating', 'blocked', 'failed']) {
      assert.strictEqual(hasPendingDrafts([row(status)]), true, `${status} must surface the page`);
    }
    assert.strictEqual(hasPendingDrafts([row('created')]), false, 'a created row is done');
  });

  test('one open row among committed ones is enough to surface the page', () => {
    assert.strictEqual(hasPendingDrafts([row('created'), row('created'), row('pending')]), true);
    assert.strictEqual(hasPendingDrafts([row('created'), row('created')]), false);
  });
});

import * as assert from 'assert';
import { AdoClient } from '../../../ado/client';

suite('AdoClient', () => {
  test('constructs with organization and PAT', () => {
    const client = new AdoClient('testorg', 'testpat');
    assert.ok(client);
  });

  test('rejects when credentials are empty', () => {
    // Should throw or handle gracefully
    assert.throws(() => new AdoClient('', ''));
  });

  test('createPullRequest posts the PR and parses the response', async () => {
    let captured: { url: string; init: any } | null = null;
    (globalThis as any).fetch = async (url: string, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        json: async () => ({ pullRequestId: 7, url: 'https://dev.azure.com/org/_git/repo/pullrequest/7', mergeStatus: 'queued' }),
      };
    };

    const client = new AdoClient('org', 'pat');
    const pr = await client.createPullRequest('Proj', 'repo-name', 'feature/ADO-42-x', 'main', 'Title', 'Desc');

    assert.strictEqual(pr.pullRequestId, 7);
    assert.strictEqual(pr.mergeStatus, 'queued', 'mergeStatus surfaced from the creation response');
    assert.ok(captured!.url.includes('/Proj/_apis/git/repositories/repo-name/pullrequests'));
    const body = JSON.parse(captured!.init.body);
    assert.strictEqual(body.sourceRefName, 'refs/heads/feature/ADO-42-x');
    assert.strictEqual(body.targetRefName, 'refs/heads/main');
    assert.strictEqual(body.title, 'Title');
    assert.strictEqual(body.description, 'Desc');
  });

  test('createPullRequest refuses when source and target are the same branch', async () => {
    const client = new AdoClient('org', 'pat');
    await assert.rejects(
      client.createPullRequest('Proj', 'repo', 'main', 'main', 't'),
      /source and target branches are the same/
    );
  });

  test('getPullRequestsBySourceBranch queries by source ref and parses the value array', async () => {
    let capturedUrl = '';
    (globalThis as any).fetch = async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          value: [
            { pullRequestId: 7, status: 'completed', mergeStatus: 'succeeded', url: 'https://dev.azure.com/org/_git/repo/pullrequest/7' },
            { pullRequestId: 8, status: 'active', mergeStatus: 'queued' },
          ],
        }),
      };
    };

    const client = new AdoClient('org', 'pat');
    const prs = await client.getPullRequestsBySourceBranch('Proj', 'repo-name', 'feature/ADO-42-x');

    assert.strictEqual(prs.length, 2);
    assert.strictEqual(prs[0].mergeStatus, 'succeeded');
    assert.ok(capturedUrl.includes('/Proj/_apis/git/repositories/repo-name/pullrequests'));
    assert.ok(capturedUrl.includes('searchCriteria.sourceRefName='), 'source-ref criteria present');
    assert.ok(capturedUrl.includes(encodeURIComponent('refs/heads/feature/ADO-42-x')), 'source ref encoded');
  });

  test('getPullRequestsBySourceBranch returns [] when the value array is missing', async () => {
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({}) });
    const client = new AdoClient('org', 'pat');
    const prs = await client.getPullRequestsBySourceBranch('Proj', 'repo', 'feature/x');
    assert.deepStrictEqual(prs, []);
  });

  test('getPullRequest returns merge status fields for a single PR', async () => {
    let capturedUrl = '';
    (globalThis as any).fetch = async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ pullRequestId: 7, status: 'completed', mergeStatus: 'succeeded', mergeFailureMessage: '', isDraft: false }),
      };
    };

    const client = new AdoClient('org', 'pat');
    const pr = await client.getPullRequest('Proj', 'repo-name', 7);

    assert.strictEqual(pr.pullRequestId, 7);
    assert.strictEqual(pr.mergeStatus, 'succeeded');
    assert.ok(capturedUrl.includes('/Proj/_apis/git/repositories/repo-name/pullrequests/7'));
  });
});

// ── Hierarchy expansion (expandHierarchy) ───────────────────────────
function makeItem(id: number, parentId?: number, type = 'Task', assignedTo = 'dev'): any {
  const fields: Record<string, any> = {
    'System.Id': id,
    'System.Title': `Item ${id}`,
    'System.State': 'Active',
    'System.AssignedTo': { displayName: assignedTo, uniqueName: `${assignedTo}@org.com` },
    'System.WorkItemType': type,
  };
  if (parentId !== undefined) fields['System.Parent'] = { id: parentId };
  return { id, fields, _links: { html: { href: `https://dev.azure.com/org/_workitems/edit/${id}` } } };
}

/**
 * Mock fetch backed by an id→item database. Serves the two request shapes
 * expandHierarchy issues: WIQL POSTs ([System.Parent] IN (...) queries) and
 * batch detail GETs (/ _apis/wit/workitems?ids=...). Any other URL throws.
 */
function mockHierarchyFetch(db: Map<number, any>, calls?: string[]): void {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const urlStr = String(url);
    calls?.push(urlStr);
    if (urlStr.includes('/_apis/wit/wiql')) {
      const body = JSON.parse(init?.body ?? '{}') as { query?: string };
      const m = (body.query ?? '').match(/\[System\.Parent\] IN \(([^)]*)\)/);
      const parentIds = m && m[1] ? m[1].split(',').map(s => parseInt(s, 10)) : [];
      const children = [...db.values()].filter(
        w => w.fields['System.Parent'] && parentIds.includes(w.fields['System.Parent'].id)
      );
      return { ok: true, json: async () => ({ workItems: children.map(c => ({ id: c.id, url: '' })) }) };
    }
    if (urlStr.includes('/_apis/wit/workitems')) {
      const idsMatch = urlStr.match(/ids=([^&]+)/);
      const ids = idsMatch ? idsMatch[1].split(',').map(s => parseInt(s, 10)) : [];
      const value = ids.map(id => db.get(id)).filter(Boolean);
      return { ok: true, json: async () => ({ value }) };
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };
}

suite('AdoClient.expandHierarchy', () => {
  test('walks up missing parents so items nest under their real ancestors', async () => {
    const db = new Map<number, any>([
      [3, makeItem(3, 2, 'Task')],
      [4, makeItem(4, 2, 'Task')],
      [2, makeItem(2, 1, 'User Story')],
      [1, makeItem(1, undefined, 'Feature')],
      [99, makeItem(99, undefined, 'Feature')],
    ]);
    mockHierarchyFetch(db);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(3), db.get(4)]);
    const ids = expanded.map(w => w.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 2, 3, 4], 'parents fetched up the chain; unrelated item excluded');
  });

  test('walks down children: Feature → User Stories → Tasks', async () => {
    const db = new Map<number, any>([
      [1, makeItem(1, undefined, 'Feature')],
      [2, makeItem(2, 1, 'User Story')],
      [3, makeItem(3, 1, 'User Story')],
      [4, makeItem(4, 2, 'Task')],
      [5, makeItem(5, 3, 'Task')],
    ]);
    mockHierarchyFetch(db);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(1)]);
    const ids = expanded.map(w => w.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 2, 3, 4, 5]);
  });

  test('builds the full closure around a base task (ancestors + sibling stories + their tasks)', async () => {
    const db = new Map<number, any>([
      [4, makeItem(4, 2, 'Task')],
      [2, makeItem(2, 1, 'User Story')],
      [1, makeItem(1, undefined, 'Feature')],
      [3, makeItem(3, 1, 'User Story')],
      [5, makeItem(5, 3, 'Task')],
      [99, makeItem(99, undefined, 'Feature')],
    ]);
    mockHierarchyFetch(db);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(4)]);
    const ids = expanded.map(w => w.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 2, 3, 4, 5], 'closure = ancestors + sibling stories + their tasks');
  });

  test('returns the base set unchanged when nothing expands', async () => {
    const db = new Map<number, any>([[7, makeItem(7, undefined, 'Task')]]);
    mockHierarchyFetch(db);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(7)]);
    assert.deepStrictEqual(expanded.map(w => w.id), [7]);
  });

  test('returns [] for an empty base without issuing requests', async () => {
    const calls: string[] = [];
    mockHierarchyFetch(new Map(), calls);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', []);
    assert.deepStrictEqual(expanded, []);
    assert.strictEqual(calls.length, 0);
  });

  test('stops walking when a parent is missing/unreadable (no infinite loop)', async () => {
    const db = new Map<number, any>([[4, makeItem(4, 999, 'Task')]]);
    mockHierarchyFetch(db);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(4)]);
    assert.deepStrictEqual(expanded.map(w => w.id), [4]);
  });

  test('dedupes items reached by both parent and child walks', async () => {
    // Base contains BOTH a story and its task: the task's parent walk would
    // re-find the story; the story's child walk would re-find the task.
    const db = new Map<number, any>([
      [2, makeItem(2, 1, 'User Story')],
      [3, makeItem(3, 2, 'Task')],
      [1, makeItem(1, undefined, 'Feature')],
    ]);
    mockHierarchyFetch(db);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(2), db.get(3)]);
    const ids = expanded.map(w => w.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 2, 3]);
  });
});

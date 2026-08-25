import * as assert from 'assert';
import { AdoClient, parentIdOf, isTerminalState, terminalStateForType } from '../../../ado/client';

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
  test('parentIdOf tolerates {id}, bare number, and string shapes', () => {
    assert.strictEqual(parentIdOf({ 'System.Parent': { id: 7 } }), 7);
    assert.strictEqual(parentIdOf({ 'System.Parent': 7 }), 7);
    assert.strictEqual(parentIdOf({ 'System.Parent': '7' }), 7);
    assert.strictEqual(parentIdOf({ 'System.Parent': null }), undefined);
    assert.strictEqual(parentIdOf({ 'System.Parent': 0 }), undefined);
    assert.strictEqual(parentIdOf({}), undefined);
  });

  test('walks up parents when System.Parent is a bare number', async () => {
    const numItem = (id: number, parentId?: number, type = 'Task'): any => ({
      id,
      fields: {
        'System.Id': id,
        'System.Title': `Item ${id}`,
        'System.State': 'Active',
        'System.AssignedTo': { displayName: 'dev', uniqueName: 'dev@org.com' },
        'System.WorkItemType': type,
        ...(parentId !== undefined ? { 'System.Parent': parentId } : {}),
      },
      _links: {},
    });
    const db = new Map<number, any>([
      [3, numItem(3, 2)],
      [2, numItem(2, 1, 'User Story')],
      [1, numItem(1, undefined, 'Feature')],
    ]);
    mockHierarchyFetch(db);
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(3)]);
    const ids = expanded.map(w => w.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 2, 3], 'ancestors found despite bare-number System.Parent');
  });

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

  suite('AdoClient.getDescendantWorkItems (parent delegation subtree)', () => {
    test('returns the whole subtree below the parent, excluding the parent and unrelated items', async () => {
      const db = new Map<number, any>([
        [1, makeItem(1, undefined, 'Feature')],
        [2, makeItem(2, 1, 'User Story')],
        [3, makeItem(3, 1, 'User Story')],
        [4, makeItem(4, 2, 'Task')],
        [5, makeItem(5, 3, 'Task')],
        [99, makeItem(99, undefined, 'Feature')], // unrelated — must be excluded
      ]);
      mockHierarchyFetch(db);
      const client = new AdoClient('org', 'pat');
      const descendants = await client.getDescendantWorkItems('Proj', 1);
      const ids = descendants.map(w => w.id);
      assert.deepStrictEqual(ids, [2, 3, 4, 5], 'recursive subtree, id-ordered, no parent, no unrelated');
    });

    test('returns [] when the parent does not exist', async () => {
      const db = new Map<number, any>([[1, makeItem(1, undefined, 'Feature')]]);
      mockHierarchyFetch(db);
      const client = new AdoClient('org', 'pat');
      const descendants = await client.getDescendantWorkItems('Proj', 404);
      assert.deepStrictEqual(descendants, []);
    });
  });

  suite('Work item terminal states (auto-complete helpers)', () => {
    test('isTerminalState recognizes Done/Closed/Resolved/Removed', () => {
      assert.strictEqual(isTerminalState('To Do'), false);
      assert.strictEqual(isTerminalState('In Progress'), false);
      assert.strictEqual(isTerminalState('Active'), false);
      assert.strictEqual(isTerminalState('Closed'), true);
      assert.strictEqual(isTerminalState('Done'), true);
      assert.strictEqual(isTerminalState('Resolved'), true);
      assert.strictEqual(isTerminalState('Removed'), true);
      assert.strictEqual(isTerminalState(undefined), false);
    });

    test('terminalStateForType maps Task/Bug/Impediment to Closed, the rest to Resolved', () => {
      assert.strictEqual(terminalStateForType('Task'), 'Closed');
      assert.strictEqual(terminalStateForType('Bug'), 'Closed');
      assert.strictEqual(terminalStateForType('Impediment'), 'Closed');
      assert.strictEqual(terminalStateForType('User Story'), 'Resolved');
      assert.strictEqual(terminalStateForType('Feature'), 'Resolved');
      assert.strictEqual(terminalStateForType('Epic'), 'Resolved');
      assert.strictEqual(terminalStateForType('Product Backlog Item'), 'Resolved');
    });
  });

  test('falls back to per-parent queries when IN is rejected by the org', async () => {
    const db = new Map<number, any>([
      [1, makeItem(1, undefined, 'Feature')],
      [2, makeItem(2, 1, 'User Story')],
      [3, makeItem(3, 2, 'Task')],
    ]);
    (globalThis as any).fetch = async (url: string, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/_apis/wit/wiql')) {
        const body = JSON.parse(init?.body ?? '{}') as { query?: string };
        if ((body.query ?? '').includes('IN (')) {
          throw new Error('IN not supported');
        }
        const m = (body.query ?? '').match(/\[System\.Parent\] = (\d+)/);
        const pid = m ? parseInt(m[1], 10) : -1;
        const children = [...db.values()].filter(
          w => w.fields['System.Parent'] && w.fields['System.Parent'].id === pid
        );
        return { ok: true, json: async () => ({ workItems: children.map(c => ({ id: c.id, url: '' })) }) };
      }
      if (urlStr.includes('/_apis/wit/workitems')) {
        const idsMatch = urlStr.match(/ids=([^&]+)/);
        const ids = idsMatch ? idsMatch[1].split(',').map(s => parseInt(s, 10)) : [];
        return { ok: true, json: async () => ({ value: ids.map(id => db.get(id)).filter(Boolean) }) };
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    };
    const client = new AdoClient('org', 'pat');
    const expanded = await client.expandHierarchy('Proj', [db.get(1)]);
    const ids = expanded.map(w => w.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 2, 3], 'children found via per-parent fallback when IN is rejected');
  });
});

suite('AdoClient.getAllWorkItems', () => {
  test('queries all open items without an AssignedTo filter', async () => {
    let capturedQuery = '';
    (globalThis as any).fetch = async (url: string, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/_apis/wit/wiql')) {
        const body = JSON.parse(init?.body ?? '{}') as { query?: string };
        capturedQuery = body.query ?? '';
        return { ok: true, json: async () => ({ workItems: [{ id: 5, url: '' }, { id: 6, url: '' }] }) };
      }
      if (urlStr.includes('/_apis/wit/workitems')) {
        return { ok: true, json: async () => ({ value: [makeItem(5), makeItem(6)] }) };
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    };
    const client = new AdoClient('org', 'pat');
    const items = await client.getAllWorkItems('Proj');
    assert.strictEqual(items.length, 2);
    assert.ok(capturedQuery.includes('[System.TeamProject]'), 'project scoped');
    // The WHERE clause must not filter by assignee (All mode); the SELECT
    // list legitimately includes AssignedTo for the summary/context menus.
    const whereClause = capturedQuery.split('WHERE')[1] ?? '';
    assert.ok(!whereClause.includes('AssignedTo'), 'no assignee filter for All mode');
    assert.ok(capturedQuery.includes("[System.State] <> 'Closed'"), 'closed items excluded');
  });
});

suite('AdoClient.resolveImagesInHtml', () => {
  /** Mock fetch returning a 1x1 PNG with the given content-type. */
  function mockFetch(calls: Array<{ url: string; ok?: boolean; contentType?: string; bytes?: Uint8Array }>): { urls: string[] } {
    const urls: string[] = [];
    (globalThis as any).fetch = async (url: string) => {
      urls.push(String(url));
      const match = calls.find(c => String(url).includes(c.url)) ?? calls[0];
      if (match && match.ok === false) return { ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      return {
        ok: true,
        headers: { get: () => match?.contentType ?? 'image/png' },
        arrayBuffer: async () => (match?.bytes ?? new Uint8Array([137, 80, 78, 71])).buffer,
      };
    };
    return { urls };
  }

  const ADO_IMG = '<img src="https://dev.azure.com/org/proj-id/_apis/wit/attachments/abc?fileName=shot.jpg" alt="shot">';

  test('rewrites same-origin ADO attachment images to data URLs', async () => {
    const { urls } = mockFetch([{ url: 'attachments/abc', contentType: 'image/jpeg; api-version=7.1' }]);
    const client = new AdoClient('org', 'pat');
    const out = await client.resolveImagesInHtml(ADO_IMG);
    assert.ok(out.startsWith('<img src="data:image/jpeg;base64,'), `Got: ${out}`);
    assert.ok(out.endsWith('" alt="shot">'), `Got: ${out}`);
    assert.strictEqual(urls.length, 1, 'exactly one attachment fetch');
    assert.ok(urls[0].includes('attachments/abc'));
  });

  test('leaves external-host images and existing data URLs untouched', async () => {
    const { urls } = mockFetch([]);
    const client = new AdoClient('org', 'pat');
    const html = '<img src="https://example.com/logo.png" alt="x"> <img src="data:image/png;base64,AAAA" alt="y"> ' + ADO_IMG;
    const out = await client.resolveImagesInHtml(html);
    assert.ok(out.includes('https://example.com/logo.png'), 'external src kept');
    assert.ok(out.includes('data:image/png;base64,AAAA'), 'existing data URL kept');
    assert.ok(out.includes('data:image/png;base64,'), 'ADO image resolved');
    assert.strictEqual(urls.length, 1, 'only the ADO attachment fetched');
  });

  test('keeps the original src when the fetch fails', async () => {
    const { urls } = mockFetch([{ url: 'attachments/abc', ok: false }]);
    const client = new AdoClient('org', 'pat');
    const out = await client.resolveImagesInHtml(ADO_IMG);
    assert.strictEqual(out, ADO_IMG, 'unchanged when fetch fails');
    assert.strictEqual(urls.length, 1);
  });

  test('skips non-image content types', async () => {
    mockFetch([{ url: 'attachments/abc', contentType: 'text/html' }]);
    const client = new AdoClient('org', 'pat');
    const out = await client.resolveImagesInHtml(ADO_IMG);
    assert.strictEqual(out, ADO_IMG, 'unchanged for non-image response');
  });

  test('returns html unchanged when it has no img tags or no same-origin images', async () => {
    const { urls } = mockFetch([]);
    const client = new AdoClient('org', 'pat');
    assert.strictEqual(await client.resolveImagesInHtml('<p>plain text</p>'), '<p>plain text</p>');
    assert.strictEqual(await client.resolveImagesInHtml(''), '');
    assert.strictEqual(
      await client.resolveImagesInHtml('<img src="https://elsewhere.test/x.png">'),
      '<img src="https://elsewhere.test/x.png">',
      'foreign origin not fetched'
    );
    assert.strictEqual(urls.length, 0, 'no fetches at all');
  });

  test('resolves relative image srcs against the ADO base URL', async () => {
    mockFetch([{ url: '_apis/wit/attachments/rel' }]);
    const client = new AdoClient('org', 'pat');
    const out = await client.resolveImagesInHtml('<img src="/_apis/wit/attachments/rel?fileName=a.png">');
    assert.ok(out.includes('data:image/png;base64,'), `Got: ${out}`);
  });

  test('dedupes repeated identical attachment URLs', async () => {
    const { urls } = mockFetch([{ url: 'attachments/dup' }]);
    const client = new AdoClient('org', 'pat');
    const html = `<p>${ADO_IMG}</p><p>${ADO_IMG}</p>`;
    const out = await client.resolveImagesInHtml(html);
    assert.strictEqual(urls.length, 1, 'fetched once despite two occurrences');
    assert.strictEqual((out.match(/data:image/g) || []).length, 2, 'both occurrences rewritten');
  });
});

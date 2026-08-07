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

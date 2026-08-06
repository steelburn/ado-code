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
        json: async () => ({ pullRequestId: 7, url: 'https://dev.azure.com/org/_git/repo/pullrequest/7' }),
      };
    };

    const client = new AdoClient('org', 'pat');
    const pr = await client.createPullRequest('Proj', 'repo-name', 'feature/ADO-42-x', 'main', 'Title', 'Desc');

    assert.strictEqual(pr.pullRequestId, 7);
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
});

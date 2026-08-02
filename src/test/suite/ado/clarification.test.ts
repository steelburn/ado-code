import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

// ── Fakes ───────────────────────────────────────────────────────────
function fakeServices() {
  const calls: any[] = [];
  const ado = {
    getWorkItemWithDiscussion: async () => ({
      detail: {
        id: 42,
        fields: {
          'System.Title': 'Fix login',
          'System.State': 'Active',
          'System.Description': 'desc',
          'System.CreatedBy': { displayName: 'Jane BA', uniqueName: 'jane@org.com' },
        },
      },
      comments: [],
      creator: { displayName: 'Jane BA', uniqueName: 'jane@org.com' },
    }),
    getComments: async () => [{ id: 1, text: 'reply', createdBy: { displayName: 'Jane' }, createdDate: '2026-08-02' }],
    addComment: async (_p: string, _id: number, text: string) => { calls.push({ op: 'comment', text }); return { id: 2 }; },
    updateWorkItem: async () => { calls.push({ op: 'updateState' }); return {}; },
    getWorkItemDetail: async () => ({ fields: { 'System.Description': '', 'Microsoft.VSTS.Common.AcceptanceCriteria': '' } }),
  };
  return { ado, calls };
}

function makeProvider(services: any) {
  const postMessage: any[] = [];
  const provider = new ChatViewProvider(
    { fsPath: '/tmp/x' } as any,
    services,
    { workspaceState: { get: () => undefined, update: async () => {} } } as any
  );
  (provider as any).postMessage = (m: any) => postMessage.push(m);
  (provider as any)._view = {};
  return { provider, postMessage };
}

// ── Tests ───────────────────────────────────────────────────────────
suite('Clarification flow', () => {
  test('requestClarification posts a comment mentioning the creator', async () => {
    const services = fakeServices();
    const { provider } = makeProvider(services);
    await (provider as any).requestClarification(42, 'What happens on cancel?');
    const comment = services.calls.find(c => c.op === 'comment');
    assert.ok(comment, 'addComment called');
    assert.ok(comment.text.includes('Clarification requested from Jane BA'));
    assert.ok(comment.text.includes('<@jane@org.com>'), 'mention syntax present');
    assert.ok(comment.text.includes('What happens on cancel?'));
  });

  test('requestClarification skips state change when clarificationState setting is empty', async () => {
    const services = fakeServices();
    const { provider } = makeProvider(services);
    // Set adoCode.ado.clarificationState to '' (empty = skip state change),
    // then restore after the test.
    const cfg = vscode.workspace.getConfiguration('adoCode');
    const prev = cfg.get<string>('ado.clarificationState', 'Blocked');
    try {
      await cfg.update('ado.clarificationState', '', vscode.ConfigurationTarget.Global);
      await (provider as any).requestClarification(42, 'What happens on cancel?');
      // Comment posted (source of truth)…
      assert.ok(services.calls.some(c => c.op === 'comment'));
      // …but NO state change attempted (empty setting → skip).
      assert.ok(!services.calls.some(c => c.op === 'updateState'), 'state update skipped when setting empty');
    } finally {
      await cfg.update('ado.clarificationState', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('checkTaskReplies refreshes activeWorkItem comments', async () => {
    const services = fakeServices();
    const { provider } = makeProvider(services);
    (provider as any).activeWorkItem = { id: 42, title: 'Fix login', comments: [] };
    await (provider as any).checkTaskReplies(42);
    assert.ok((provider as any).activeWorkItem.comments.length === 1);
    assert.strictEqual((provider as any).activeWorkItem.comments[0].text, 'reply');
  });
});

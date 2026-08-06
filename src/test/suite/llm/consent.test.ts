import * as assert from 'assert';
import { createConsentBroker } from '../../../llm/consent';
import {
  isCommandSessionApproved,
  addSessionCommandApproval,
  clearSessionAutoApprovals,
  isSessionAutoApproved,
  addSessionToolApproval,
} from '../../../llm/tool-approval-ui';

suite('ConsentBroker', () => {
  test('approve resolves the decision to true', async () => {
    const broker = createConsentBroker();
    const { requestId, decision } = broker.request({ tool: 'edit_file', args: { path: 'a.ts' } });
    broker.resolve(requestId, true);
    assert.strictEqual(await decision, true);
    assert.strictEqual(broker.pending, null);
  });

  test('reject resolves the decision to false', async () => {
    const broker = createConsentBroker();
    const { requestId, decision } = broker.request({ tool: 'edit_file', args: {} });
    broker.resolve(requestId, false);
    assert.strictEqual(await decision, false);
    assert.strictEqual(broker.pending, null);
  });

  test('stale requestId is ignored (decision still pending)', async () => {
    const broker = createConsentBroker(30);
    const { requestId, decision } = broker.request({ tool: 'edit_file', args: {} });
    broker.resolve('bogus-id', true);
    // Not resolved by the bogus id — the timeout must still fire (false).
    assert.strictEqual(await decision, false);
    assert.ok(requestId.length > 0);
  });

  test('timeout denies without an answer (loop can never hang)', async () => {
    const broker = createConsentBroker(20);
    const { decision } = broker.request({ tool: 'run_terminal_command', args: { command: 'rm -rf x' } });
    assert.strictEqual(await decision, false);
    assert.strictEqual(broker.pending, null);
  });

  test('rejectAll denies the pending request (webview disposed / chat cleared)', async () => {
    const broker = createConsentBroker();
    const { decision } = broker.request({ tool: 'add_comment', args: {} });
    broker.rejectAll();
    assert.strictEqual(await decision, false);
    assert.strictEqual(broker.pending, null);
  });

  test('new request supersedes an unanswered one', async () => {
    const broker = createConsentBroker();
    const first = broker.request({ tool: 'add_comment', args: {} });
    const second = broker.request({ tool: 'edit_file', args: {} });
    // The first decision must already be denied by the supersede.
    assert.strictEqual(await first.decision, false);
    broker.resolve(second.requestId, true);
    assert.strictEqual(await second.decision, true);
    assert.strictEqual(broker.pending, null);
  });

  test('pending exposes the in-flight request with tool and args', () => {
    const broker = createConsentBroker();
    const args = { path: 'x.ts', oldText: 'a', newText: 'b' };
    broker.request({ tool: 'edit_file', args });
    assert.deepStrictEqual(broker.pending?.tool, 'edit_file');
    assert.deepStrictEqual(broker.pending?.args, args);
    assert.ok(broker.pending?.requestId);
  });
});

suite('Session command approval cache', () => {
  setup(() => {
    clearSessionAutoApprovals();
  });

  test('command is not session-approved by default', () => {
    assert.strictEqual(isCommandSessionApproved('git difftool'), false);
  });

  test('addSessionCommandApproval makes command session-approved', () => {
    addSessionCommandApproval('git difftool');
    assert.strictEqual(isCommandSessionApproved('git difftool'), true);
  });

  test('session approval is exact-match (different command not approved)', () => {
    addSessionCommandApproval('git diff');
    assert.strictEqual(isCommandSessionApproved('git diff'), true);
    assert.strictEqual(isCommandSessionApproved('git status'), false);
  });

  test('clearSessionAutoApprovals clears command cache', () => {
    addSessionCommandApproval('npm run build');
    assert.strictEqual(isCommandSessionApproved('npm run build'), true);
    clearSessionAutoApprovals();
    assert.strictEqual(isCommandSessionApproved('npm run build'), false);
  });

  test('session approval trims whitespace', () => {
    addSessionCommandApproval('  git log  ');
    assert.strictEqual(isCommandSessionApproved('git log'), true);
  });
});

suite('Session tool approval cache', () => {
  setup(() => {
    clearSessionAutoApprovals();
  });

  test('tool is not session-approved by default', () => {
    assert.strictEqual(isSessionAutoApproved('edit_file'), false);
  });

  test('addSessionToolApproval makes the tool session-approved', () => {
    addSessionToolApproval('edit_file');
    assert.strictEqual(isSessionAutoApproved('edit_file'), true);
  });

  test('session approval is per-tool (other tools not approved)', () => {
    addSessionToolApproval('edit_file');
    assert.strictEqual(isSessionAutoApproved('edit_file'), true);
    assert.strictEqual(isSessionAutoApproved('write_to_file'), false);
    assert.strictEqual(isSessionAutoApproved('run_terminal_command'), false);
  });

  test('clearSessionAutoApprovals clears the tool cache too', () => {
    addSessionToolApproval('edit_file');
    clearSessionAutoApprovals();
    assert.strictEqual(isSessionAutoApproved('edit_file'), false);
  });
});

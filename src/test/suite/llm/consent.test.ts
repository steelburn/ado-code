import * as assert from 'assert';
import { createConsentBroker, isHarmlessCommand, matchesToolPattern, matchesCommandPattern } from '../../../llm/consent';
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

  test('autoApproveMs auto-approves at the deadline and reports the approve action', async () => {
    const events: Array<{ id: string; action: string }> = [];
    const broker = createConsentBroker(200, (req, action) => events.push({ id: req.requestId, action }));
    const { requestId, decision } = broker.request(
      { tool: 'run_terminal_command', args: { command: 'git status' } },
      { autoApproveMs: 20 }
    );
    assert.strictEqual(await decision, true, 'auto-approves without an explicit answer');
    assert.strictEqual(broker.pending, null);
    assert.deepStrictEqual(events, [{ id: requestId, action: 'approve' }], 'approve expiry reported');
  });

  test('without autoApproveMs the timeout denies and reports the deny action', async () => {
    const events: Array<{ id: string; action: string }> = [];
    const broker = createConsentBroker(20, (req, action) => events.push({ id: req.requestId, action }));
    const { requestId, decision } = broker.request({ tool: 'run_terminal_command', args: { command: 'rm -rf x' } });
    assert.strictEqual(await decision, false, 'hard timeout denies');
    assert.strictEqual(broker.pending, null);
    assert.deepStrictEqual(events, [{ id: requestId, action: 'deny' }], 'deny expiry reported');
  });

  test('an explicit answer suppresses the timeout callback', async () => {
    const events: Array<{ id: string; action: string }> = [];
    const broker = createConsentBroker(20, (req, action) => events.push({ id: req.requestId, action }));
    const { requestId, decision } = broker.request(
      { tool: 'run_terminal_command', args: { command: 'git status' } },
      { autoApproveMs: 10 }
    );
    broker.resolve(requestId, true);
    assert.strictEqual(await decision, true);
    await new Promise(r => setTimeout(r, 40));
    assert.deepStrictEqual(events, [], 'no expiry callback once the user answered');
  });

  test('request returns the effective deadline (expiresAt)', async () => {
    const before = Date.now();
    const broker = createConsentBroker();
    // Plain case: deadline is now + broker timeout.
    const plain = broker.request({ tool: 'edit_file', args: {} });
    assert.ok(plain.expiresAt >= before + 119000 && plain.expiresAt <= before + 121000,
      'deny deadline ~now+120s');
    // Auto-approve case supersedes it: deadline is now + autoApproveMs.
    const approved = broker.request({ tool: 'run_terminal_command', args: { command: 'git status' } }, { autoApproveMs: 5000 });
    assert.ok(approved.expiresAt >= before + 4900 && approved.expiresAt <= before + 5100,
      `auto-approve deadline ~now+5000 (got ${approved.expiresAt - before})`);
    assert.strictEqual(broker.pending?.autoApproveMs, 5000, 'pending keeps autoApproveMs for re-posting');
    assert.ok(broker.pending?.expiresAt && broker.pending.expiresAt > Date.now(), 'pending keeps expiresAt for re-posting');
    // Clean up both pending timers so the suite never idles on them.
    broker.resolve(approved.requestId, true);
  });

  test('pause freezes the hard-deny timeout; resume keeps the remaining time', async () => {
    const events: Array<{ id: string; action: string }> = [];
    const broker = createConsentBroker(50, (req, action) => events.push({ id: req.requestId, action }));
    const { requestId, decision } = broker.request({ tool: 'run_terminal_command', args: { command: 'rm -rf x' } });
    await new Promise(r => setTimeout(r, 15)); // burn part of the window
    broker.pause();
    assert.ok(broker.paused, 'paused reports true');
    await new Promise(r => setTimeout(r, 70)); // would have denied at 50ms
    assert.deepStrictEqual(events, [], 'no timeout while paused');
    broker.resume();
    assert.strictEqual(broker.paused, false, 'paused reports false after resume');
    assert.strictEqual(await decision, false, 'still denies after resume');
    assert.deepStrictEqual(events, [{ id: requestId, action: 'deny' }], 'deny fires once, after resume');
  });

  test('pause freezes the auto-approve timer too', async () => {
    const events: Array<{ id: string; action: string }> = [];
    const broker = createConsentBroker(500, (req, action) => events.push({ id: req.requestId, action }));
    const { requestId, decision } = broker.request(
      { tool: 'run_terminal_command', args: { command: 'git status' } },
      { autoApproveMs: 30 }
    );
    await new Promise(r => setTimeout(r, 10));
    broker.pause();
    await new Promise(r => setTimeout(r, 80)); // would have auto-approved at 30ms
    assert.deepStrictEqual(events, [], 'no auto-approve while paused');
    broker.resume();
    assert.strictEqual(await decision, true, 'auto-approves after resume');
    assert.deepStrictEqual(events, [{ id: requestId, action: 'approve' }], 'approve fires once, after resume');
  });

  test('resume re-bases expiresAt onto the frozen remaining time', async () => {
    const broker = createConsentBroker();
    broker.request({ tool: 'edit_file', args: {} });
    broker.pause();
    await new Promise(r => setTimeout(r, 20));
    broker.resume();
    const remaining = broker.pending!.expiresAt - Date.now();
    assert.ok(remaining > 110000, `~full window survives a pause (got ${remaining}ms remaining)`);
    broker.resolve(broker.pending!.requestId, true);
  });

  test('the user can still answer while paused', async () => {
    const broker = createConsentBroker(20);
    const { requestId, decision } = broker.request({ tool: 'edit_file', args: {} });
    broker.pause();
    broker.resolve(requestId, true);
    assert.strictEqual(await decision, true);
    assert.strictEqual(broker.paused, false, 'answering clears the paused state');
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

suite('isHarmlessCommand', () => {
  test('returns false for empty command', () => {
    assert.strictEqual(isHarmlessCommand(''), false);
    assert.strictEqual(isHarmlessCommand('  '), false);
  });

  test('rejects shell operators', () => {
    assert.strictEqual(isHarmlessCommand('git status; rm -rf /'), false);
    assert.strictEqual(isHarmlessCommand('echo hello | cat'), false);
    assert.strictEqual(isHarmlessCommand('echo hello && rm -rf /'), false);
    assert.strictEqual(isHarmlessCommand('echo `whoami`'), false);
    assert.strictEqual(isHarmlessCommand('echo $HOME'), false);
    assert.strictEqual(isHarmlessCommand('echo hello > /tmp/x'), false);
    assert.strictEqual(isHarmlessCommand('echo hello < /tmp/x'), false);
    assert.strictEqual(isHarmlessCommand('echo $(cmd)'), false);
    assert.strictEqual(isHarmlessCommand('echo hello\nrm -rf /'), false);
  });

  test('approves read-only git commands', () => {
    assert.strictEqual(isHarmlessCommand('git status'), true);
    assert.strictEqual(isHarmlessCommand('git diff'), true);
    assert.strictEqual(isHarmlessCommand('git diff HEAD'), true);
    assert.strictEqual(isHarmlessCommand('git diff --stat HEAD~3'), true);
    assert.strictEqual(isHarmlessCommand('git log'), true);
    assert.strictEqual(isHarmlessCommand('git log --oneline -10'), true);
    assert.strictEqual(isHarmlessCommand('git show HEAD'), true);
    assert.strictEqual(isHarmlessCommand('git branch'), true);
    assert.strictEqual(isHarmlessCommand('git branch -a'), true);
    assert.strictEqual(isHarmlessCommand('git remote -v'), true);
    assert.strictEqual(isHarmlessCommand('git tag'), true);
    assert.strictEqual(isHarmlessCommand('git blame src/file.ts'), true);
    assert.strictEqual(isHarmlessCommand('git ls-files'), true);
  });

  test('rejects mutating git commands', () => {
    assert.strictEqual(isHarmlessCommand('git add .'), false);
    assert.strictEqual(isHarmlessCommand('git commit -m "msg"'), false);
    assert.strictEqual(isHarmlessCommand('git push'), false);
    assert.strictEqual(isHarmlessCommand('git pull'), false);
    assert.strictEqual(isHarmlessCommand('git merge feature'), false);
    assert.strictEqual(isHarmlessCommand('git checkout -b new'), false);
    assert.strictEqual(isHarmlessCommand('git reset HEAD~1'), false);
    assert.strictEqual(isHarmlessCommand('git stash'), false);
    assert.strictEqual(isHarmlessCommand('git clean -fd'), false);
  });

  test('rejects bare git (no subcommand)', () => {
    assert.strictEqual(isHarmlessCommand('git'), false);
  });

  test('approves read-only base commands', () => {
    assert.strictEqual(isHarmlessCommand('ls'), true);
    assert.strictEqual(isHarmlessCommand('ls -la'), true);
    assert.strictEqual(isHarmlessCommand('pwd'), true);
    assert.strictEqual(isHarmlessCommand('cat file.txt'), true);
    assert.strictEqual(isHarmlessCommand('head -n 10 file.txt'), true);
    assert.strictEqual(isHarmlessCommand('tail -f log.txt'), true);
    assert.strictEqual(isHarmlessCommand('wc -l file.txt'), true);
    assert.strictEqual(isHarmlessCommand('grep pattern file.txt'), true);
    assert.strictEqual(isHarmlessCommand('rg "TODO" src/'), true);
    assert.strictEqual(isHarmlessCommand('find . -name "*.ts"'), true);
    assert.strictEqual(isHarmlessCommand('tree src/'), true);
    assert.strictEqual(isHarmlessCommand('echo hello'), true);
    assert.strictEqual(isHarmlessCommand('date'), true);
    assert.strictEqual(isHarmlessCommand('whoami'), true);
    assert.strictEqual(isHarmlessCommand('which node'), true);
    assert.strictEqual(isHarmlessCommand('node --version'), true);
    assert.strictEqual(isHarmlessCommand('python --version'), true);
    assert.strictEqual(isHarmlessCommand('curl https://example.com'), true);
    assert.strictEqual(isHarmlessCommand('wget https://example.com/file'), true);
    assert.strictEqual(isHarmlessCommand('env'), true);
    assert.strictEqual(isHarmlessCommand('printenv HOME'), true);
  });

  test('approves read-only npm commands', () => {
    assert.strictEqual(isHarmlessCommand('npm test'), true);
    assert.strictEqual(isHarmlessCommand('npm run lint'), true);
    assert.strictEqual(isHarmlessCommand('npm run compile'), true);
    assert.strictEqual(isHarmlessCommand('npm list'), true);
    assert.strictEqual(isHarmlessCommand('npm ls --depth=0'), true);
    assert.strictEqual(isHarmlessCommand('npm info typescript'), true);
    assert.strictEqual(isHarmlessCommand('npm view react version'), true);
    assert.strictEqual(isHarmlessCommand('npm outdated'), true);
    assert.strictEqual(isHarmlessCommand('npm doctor'), true);
  });

  test('rejects mutating npm commands', () => {
    assert.strictEqual(isHarmlessCommand('npm install'), false);
    assert.strictEqual(isHarmlessCommand('npm install express'), false);
    assert.strictEqual(isHarmlessCommand('npm uninstall lodash'), false);
    assert.strictEqual(isHarmlessCommand('npm publish'), false);
    assert.strictEqual(isHarmlessCommand('npm update'), false);
    assert.strictEqual(isHarmlessCommand('npm init'), false);
  });

  test('rejects bare npm (no subcommand)', () => {
    assert.strictEqual(isHarmlessCommand('npm'), false);
  });

  test('approves read-only pip commands', () => {
    assert.strictEqual(isHarmlessCommand('pip list'), true);
    assert.strictEqual(isHarmlessCommand('pip show requests'), true);
    assert.strictEqual(isHarmlessCommand('pip check'), true);
  });

  test('rejects mutating pip commands', () => {
    assert.strictEqual(isHarmlessCommand('pip install requests'), false);
    assert.strictEqual(isHarmlessCommand('pip uninstall requests'), false);
  });

  test('rejects unknown commands', () => {
    assert.strictEqual(isHarmlessCommand('docker rm container'), false);
    assert.strictEqual(isHarmlessCommand('kubectl delete pod x'), false);
    assert.strictEqual(isHarmlessCommand('rm -rf /'), false);
    assert.strictEqual(isHarmlessCommand('dd if=/dev/zero of=/dev/sda'), false);
  });

  test('case insensitive', () => {
    assert.strictEqual(isHarmlessCommand('Git Status'), true);
    assert.strictEqual(isHarmlessCommand('GIT DIFF'), true);
    assert.strictEqual(isHarmlessCommand('NPM Test'), true);
  });
});

suite('wildcard permission matchers', () => {

  test('tool name patterns: exact and glob', () => {
    assert.strictEqual(matchesToolPattern('read_file', ['read_*']), true);
    assert.strictEqual(matchesToolPattern('read_workspace_memory', ['read_*']), true);
    assert.strictEqual(matchesToolPattern('get_work_items', ['get_*']), true);
    assert.strictEqual(matchesToolPattern('get_work_item', ['get_*']), true);
    assert.strictEqual(matchesToolPattern('edit_file', ['read_*', 'get_*']), false);
    assert.strictEqual(matchesToolPattern('edit_file', ['edit_file']), true);
    assert.strictEqual(matchesToolPattern('edit_file', []), false);
    assert.strictEqual(matchesToolPattern('write_to_file', ['*_file']), true);
    assert.strictEqual(matchesToolPattern('edit_file', ['e?it_*']), true);
  });

  test('command patterns: exact entries still require same token count', () => {
    const allowlist = ['git diff', 'npm test'];
    assert.strictEqual(matchesCommandPattern('git diff', allowlist), true);
    assert.strictEqual(matchesCommandPattern('git diff --stat', allowlist), false);
    assert.strictEqual(matchesCommandPattern('npm test', allowlist), true);
    assert.strictEqual(matchesCommandPattern('npm test -- --coverage', allowlist), false);
  });

  test('command patterns: trailing * swallows remaining tokens', () => {
    const allowlist = ['git *', 'npm run *'];
    assert.strictEqual(matchesCommandPattern('git status', allowlist), true);
    assert.strictEqual(matchesCommandPattern('git push origin main', allowlist), true);
    assert.strictEqual(matchesCommandPattern('git', allowlist), true);
    assert.strictEqual(matchesCommandPattern('npm run build', allowlist), true);
    assert.strictEqual(matchesCommandPattern('npm run test -- --watch', allowlist), true);
    assert.strictEqual(matchesCommandPattern('pip install x', allowlist), false);
  });

  test('command patterns: prefix scoping limits the wildcard', () => {
    const allowlist = ['git push *'];
    assert.strictEqual(matchesCommandPattern('git push origin main', allowlist), true);
    assert.strictEqual(matchesCommandPattern('git status', allowlist), false);
    assert.strictEqual(matchesCommandPattern('git push', allowlist), true);
  });

  test('command patterns: quoted chunks stay a single token', () => {
    const allowlist = ['git commit -m *'];
    assert.strictEqual(matchesCommandPattern('git commit -m "hello world"', allowlist), true);
    assert.strictEqual(matchesCommandPattern('git commit -m hi', allowlist), true);
  });

  test('session approvals honor wildcard entries', () => {
    clearSessionAutoApprovals();
    addSessionToolApproval('read_*');
    assert.strictEqual(isSessionAutoApproved('read_file'), true);
    assert.strictEqual(isSessionAutoApproved('read_workspace_memory'), true);
    assert.strictEqual(isSessionAutoApproved('edit_file'), false);

    addSessionCommandApproval('git *');
    assert.strictEqual(isCommandSessionApproved('git status'), true);
    assert.strictEqual(isCommandSessionApproved('git push origin main'), true);
    assert.strictEqual(isCommandSessionApproved('docker ps'), false);
  });
});

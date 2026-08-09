import * as assert from 'assert';
import { createConsentBroker, isHarmlessCommand } from '../../../llm/consent';
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

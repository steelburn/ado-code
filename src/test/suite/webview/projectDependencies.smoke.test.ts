import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  autoInstallWarnings,
  checkProjectDependencies,
  CommandRunner,
} from '../../../webview/projectDependencyProbe';
import { meetsMinimum, parseVersion, planForTemplate } from '../../../shared/projectDependencies';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

/**
 * New-project wizard → "Dependencies" step — Extension Host smoke test.
 *
 * The unit suite already pins the pure logic with an injected runner. What this
 * suite adds is the part only a real host can answer:
 *
 *   1. the PATH probe really spawns against *this* machine (node found, version
 *      parsed, minimum compared) instead of a canned `CommandOutcome`;
 *   2. the `dependencyCheck` → `dependencyCheckResult` round trip through the
 *      real ChatViewProvider switch, including the unknown-template and
 *      broken-runner degradations the wizard relies on to stay usable;
 *   3. the built `webview-ui-dist/webview.js` actually ships the step, so the
 *      panel the user opens contains the guidance UI and not just the probe.
 *
 * No network and no scaffolding here: `npm install` style steps are only
 * *planned* (`report.autoInstall`), never executed.
 */

/** Minimal Services bundle — the dependencyCheck handler touches nothing else. */
function makeServices(): any {
  const state = new Map<string, any>();
  const kv = {
    get: (k: string, d?: any) => (state.has(k) ? state.get(k) : d),
    update: async (k: string, v: any) => {
      state.set(k, v);
    },
    keys: () => [...state.keys()],
  };
  return {
    workspaceState: kv,
    globalState: kv,
    todos: { syncTodoSession: async () => undefined, list: () => [] },
  };
}

/** A provider whose posted messages are capturable without a real webview. */
function captureProvider(): { provider: ChatViewProvider; posted: any[] } {
  const provider = new ChatViewProvider({} as any, makeServices(), {} as any);
  const posted: any[] = [];
  (provider as any)._view = {
    webview: {
      postMessage: (m: any) => {
        posted.push(m);
        return Promise.resolve(true);
      },
    },
  };
  return { provider, posted };
}

/** Pretends the machine has no toolchain at all (PATH empty). */
const nothingInstalled: CommandRunner = async () => ({
  ok: false,
  output: '',
  error: 'spawn ENOENT',
});

/** Runner that violates its contract: the probe must absorb it, not propagate. */
const explodingRunner: CommandRunner = async () => {
  throw new Error('EACCES: probe exploded');
};

function lastResult(posted: any[]): any {
  return posted.filter(m => m.type === 'dependencyCheckResult').pop();
}

suite('New-project Dependencies step — Extension Host smoke', () => {
  test('the real machine satisfies a Node template (live PATH probe)', async () => {
    const plan = planForTemplate('node-ts', {});
    assert.ok(plan.checks.length >= 2, 'node-ts declares a toolchain');

    const report = await checkProjectDependencies('node-ts', {});
    assert.strictEqual(report.platform, process.platform, 'guidance is chosen for this host');
    assert.ok(!report.error, `probe surfaced an error: ${report.error}`);
    assert.strictEqual(report.checks.length, plan.checks.length, 'one status per declared spec');

    const node = report.checks.find((c: any) => c.id === 'node');
    assert.ok(node, 'node is checked');
    assert.strictEqual(node.ok, true, `node should be installed here: ${node.error ?? 'no error'}`);
    assert.ok(node.version, 'version output parsed from the probe');
    assert.ok(
      meetsMinimum(parseVersion(node.version), node.minVersion),
      `node ${node.version} clears the ${node.minVersion} floor`,
    );
    assert.ok(node.label.length > 0 && node.why.length > 0, 'the step can render label + rationale');

    // The two missing lists must agree with the statuses the UI badges.
    const expected = report.checks.filter((c: any) => c.required && !c.ok).map((c: any) => c.label);
    assert.deepStrictEqual(report.missingRequired, expected);
  });

  test('project packages are planned for auto-install, not run by the wizard', async () => {
    const report = await checkProjectDependencies('node-ts', {});
    assert.ok(report.autoInstall.length > 0, 'node-ts scaffolds a package.json → npm install planned');
    for (const step of report.autoInstall) {
      assert.ok(step.cmd && Array.isArray(step.args), `step ${step.id} is runnable`);
    }
  });

  test('an empty machine gets per-platform guidance (flutter + optional JDK)', async () => {
    const report = await checkProjectDependencies('flutter', {}, {}, { run: nothingInstalled });
    assert.ok(report.missingRequired.length > 0, 'required toolchain reported missing');

    const flutter = report.checks.find((c: any) => c.id === 'flutter');
    assert.ok(flutter, 'flutter is checked');
    assert.strictEqual(flutter.ok, false);
    assert.strictEqual(flutter.required, true);
    assert.ok(flutter.why.length > 0, 'why the tool matters');
    assert.ok(flutter.guidance.length > 0, 'a copy-paste install command exists');
    assert.ok(flutter.guidance.every((g: string) => g.trim().length > 0), 'no blank guidance lines');
    assert.ok(flutter.url, 'a download URL exists for the manual route');

    // Optional deps must NOT gate "Next" — the JDK is optional on this template.
    const jdk = report.checks.find((c: any) => c.id === 'java');
    assert.ok(jdk, 'optional JDK probed');
    assert.strictEqual(jdk.required, false);
    assert.ok(report.missingOptional.includes(jdk.label), 'optional miss listed');
    assert.ok(!report.missingRequired.includes(jdk.label), 'optional miss does not block');
  });

  test('a throwing runner degrades to report.error instead of crashing the wizard', async () => {
    const report = await checkProjectDependencies('node-ts', {}, {}, { run: explodingRunner });
    assert.ok(report.error, 'the broken probe rides report.error');
    assert.deepStrictEqual(report.checks, [], 'no half-probed statuses are reported');
    assert.deepStrictEqual(report.missingRequired, [], 'a probe failure is not dressed up as a missing tool');
    assert.ok(report.autoInstall.length > 0, 'the planned installs survive so the wizard can still inform');
  });

  test('provider round trip: dependencyCheck → dependencyCheckResult', async () => {
    const { provider, posted } = captureProvider();
    await (provider as any).handleWebviewMessage({
      type: 'dependencyCheck',
      requestId: 'req-dep-1',
      templateId: 'node-ts',
      templateOptions: {},
      gitInit: true,
    });

    const result = lastResult(posted);
    assert.ok(result, 'dependencyCheckResult posted back to the webview');
    assert.strictEqual(result.requestId, 'req-dep-1', 'requestId echoed for the step to match');
    assert.strictEqual(result.report.platform, process.platform);
    assert.ok(result.report.checks.some((c: any) => c.id === 'node'), 'live probe result, not a stub');
    assert.ok(!result.report.error, `round trip stayed healthy: ${result.report.error}`);
  });

  test('provider round trip: unknown template still answers, never throws', async () => {
    const { provider, posted } = captureProvider();
    await (provider as any).handleWebviewMessage({
      type: 'dependencyCheck',
      requestId: 'req-dep-2',
      templateId: 'no-such-template',
      templateOptions: {},
    });

    const result = lastResult(posted);
    assert.ok(result, 'the webview is never left hanging');
    assert.strictEqual(result.requestId, 'req-dep-2');
    assert.ok(
      !result.report.error && result.report.checks.every((c: any) => c.id === 'git'),
      'unknown template degrades to the git-only plan instead of erroring',
    );
  });

  test('failed autonomous installs surface as wizard warnings', () => {
    const warnings = autoInstallWarnings([
      { id: 'npm-install', label: 'npm install', ok: false, output: 'EAI_AGAIN registry unreachable' } as any,
      { id: 'npm-install-2', label: 'npm install', ok: true, output: 'added 42 packages' } as any,
    ]);
    assert.strictEqual(warnings.length, 1, 'only the failure warns');
    assert.ok(warnings[0].includes('EAI_AGAIN'), 'the output is kept for the user to act on');
  });

  test('the shipped webview bundle carries the Dependencies step', () => {
    const bundlePath = path.resolve(__dirname, '../../../../webview-ui-dist/webview.js');
    assert.ok(
      fs.existsSync(bundlePath),
      `webview bundle missing at ${bundlePath} — run npm run build:webview`,
    );
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    for (const marker of ['dependencyCheck', 'dependencyCheckResult', 'wizard-dep', 'Re-check']) {
      assert.ok(bundle.includes(marker), `bundle does not ship: ${marker}`);
    }
  });
});

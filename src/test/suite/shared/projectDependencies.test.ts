import * as assert from 'assert';
import {
    compareVersions,
    dependencyGate,
    guidanceFor,
    meetsMinimum,
    parseVersion,
    planForTemplate,
} from '../../../shared/projectDependencies';
import {
    checkProjectDependencies,
    runAutoInstalls,
    autoInstallWarnings,
    CommandRunner,
} from '../../../webview/projectDependencyProbe';

/** Fake runner: answers per command, records every call. */
function fakeRunner(answers: Record<string, { ok: boolean; output?: string; error?: string }>) {
    const calls: string[] = [];
    const run: CommandRunner = async (cmd: string) => {
        calls.push(cmd);
        const answer = answers[cmd] ?? { ok: false, error: 'not found on PATH' };
        return { ok: answer.ok, output: answer.output ?? '', error: answer.error };
    };
    return Object.assign(run, { calls });
}

suite('shared/projectDependencies', () => {
    suite('version helpers', () => {
        test('parseVersion reads the first x.y[.z] in a banner', () => {
            assert.strictEqual(parseVersion('v20.11.1'), '20.11.1');
            assert.strictEqual(parseVersion('Python 3.12.2'), '3.12.2');
            assert.strictEqual(parseVersion('8.0.100'), '8.0.100');
            assert.strictEqual(parseVersion('no digits here'), undefined);
            assert.strictEqual(parseVersion(undefined), undefined);
        });

        test('compareVersions compares numerically, not lexically', () => {
            assert.strictEqual(compareVersions('9.0.0', '10.0.0'), -1);
            assert.strictEqual(compareVersions('20', '20.0.0'), 0);
            assert.strictEqual(compareVersions('18.19.0', '18.9.0'), 1);
        });

        test('meetsMinimum needs a version when a floor is set', () => {
            assert.strictEqual(meetsMinimum('20.11.1', '18'), true);
            assert.strictEqual(meetsMinimum('16.20.0', '18'), false);
            assert.strictEqual(meetsMinimum(undefined, '18'), false);
            assert.strictEqual(meetsMinimum(undefined, undefined), true);
        });
    });

    suite('guidanceFor', () => {
        test('picks the line for the platform doing the asking', () => {
            const spec = planForTemplate('node-ts').checks.find(c => c.id === 'node')!;
            assert.ok(guidanceFor(spec, 'win32')[0].includes('winget'));
            assert.ok(guidanceFor(spec, 'darwin')[0].includes('brew'));
            assert.ok(guidanceFor(spec, 'linux')[0].includes('apt'));
        });

        test('empty for a spec without install hints', () => {
            assert.deepStrictEqual(guidanceFor({ ...planForTemplate('node-ts').checks[0], install: undefined }, 'win32'), []);
        });
    });

    suite('planForTemplate', () => {
        test('node templates need Node + npm + git and install packages themselves', () => {
            const plan = planForTemplate('node-ts');
            const ids = plan.checks.map(c => c.id);
            assert.deepStrictEqual(ids, ['node', 'npm', 'git']);
            assert.deepStrictEqual(plan.autoInstall.map(s => s.cmd), ['npm']);
            assert.strictEqual(plan.checks.find(c => c.id === 'node')!.required, true);
        });

        test('python accepts python or python3 and installs requirements', () => {
            const plan = planForTemplate('python');
            const python = plan.checks.find(c => c.id === 'python')!;
            assert.deepStrictEqual(python.probes.map(p => p.cmd), ['python', 'python3']);
            assert.strictEqual(plan.autoInstall[0].requiresFile, 'requirements.txt');
        });

        test('flutter marks the JDK optional and fetches pub packages', () => {
            const plan = planForTemplate('flutter');
            assert.strictEqual(plan.checks.find(c => c.id === 'java')!.required, false);
            assert.deepStrictEqual(plan.autoInstall[0].args, ['pub', 'get']);
        });

        test('documentation templates only care about pandoc and git', () => {
            const plan = planForTemplate('doc-ba');
            assert.deepStrictEqual(plan.checks.map(c => c.id), ['pandoc', 'git']);
            assert.deepStrictEqual(plan.autoInstall, []);
        });

        test('git is optional when the wizard will not init a repo', () => {
            const plan = planForTemplate('node-ts', {}, { gitInit: false });
            assert.strictEqual(plan.checks.find(c => c.id === 'git')!.required, false);
        });

        test('unknown template falls back to the git-only plan', () => {
            assert.deepStrictEqual(planForTemplate('does-not-exist').checks.map(c => c.id), ['git']);
        });
    });

    suite('checkProjectDependencies', () => {
        test('reports found versions and missing required tools', async () => {
            const run = fakeRunner({
                node: { ok: true, output: 'v20.11.1' },
                npm: { ok: false, error: 'not found on PATH' },
                git: { ok: true, output: 'git version 2.44.0.windows.1' },
            });
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'win32' });

            const node = report.checks.find(c => c.id === 'node')!;
            assert.strictEqual(node.ok, true);
            assert.strictEqual(node.version, '20.11.1');

            const npm = report.checks.find(c => c.id === 'npm')!;
            assert.strictEqual(npm.ok, false);
            assert.ok(npm.guidance[0].includes('winget'));
            assert.ok(npm.url);

            assert.deepStrictEqual(report.missingRequired, ['npm 9+']);
            assert.deepStrictEqual(report.missingOptional, []);
            assert.deepStrictEqual(report.autoInstall.map(s => s.id), ['npm-install']);
        });

        test('a version below the floor counts as missing', async () => {
            const run = fakeRunner({
                node: { ok: true, output: 'v16.20.0' },
                npm: { ok: true, output: '9.6.7' },
                git: { ok: true, output: 'git version 2.44.0' },
            });
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'linux' });
            const node = report.checks.find(c => c.id === 'node')!;
            assert.strictEqual(node.ok, false);
            assert.ok(node.error!.includes('need 18+'));
            assert.deepStrictEqual(report.missingRequired, ['Node.js 18+']);
        });

        test('falls through to the next probe candidate', async () => {
            const run = fakeRunner({
                python: { ok: false, error: 'not found on PATH' },
                python3: { ok: true, output: 'Python 3.11.4' },
                pip: { ok: true, output: 'pip 24.0' },
                git: { ok: true, output: 'git version 2.44.0' },
            });
            const report = await checkProjectDependencies('python', {}, {}, { run, platform: 'darwin' });
            assert.strictEqual(report.checks.find(c => c.id === 'python')!.version, '3.11.4');
            assert.deepStrictEqual(report.missingRequired, []);
        });

        test('a thrown runner becomes a soft error, never a rejection', async () => {
            const run: CommandRunner = async () => { throw new Error('spawn EPERM'); };
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'win32' });
            assert.strictEqual(report.error, 'spawn EPERM');
            assert.deepStrictEqual(report.checks, []);
        });
    });

    suite('runAutoInstalls', () => {
        test('skips a step whose required file is absent', async () => {
            const run = fakeRunner({ npm: { ok: true, output: 'added 1 package' } });
            const outcomes = await runAutoInstalls(
                '/tmp/project',
                [{ id: 'npm-install', label: 'npm install', cmd: 'npm', args: ['install'], requiresFile: 'package.json' }],
                { run, fileExists: () => false },
            );
            assert.strictEqual(outcomes[0].ok, true);
            assert.ok(outcomes[0].output.includes('skipped'));
            assert.deepStrictEqual(run.calls, []);
        });

        test('runs the step when the file exists and surfaces failures', async () => {
            const run = fakeRunner({ npm: { ok: false, error: 'EAI_AGAIN registry unreachable' } });
            const outcomes = await runAutoInstalls(
                '/tmp/project',
                [{ id: 'npm-install', label: 'npm install', cmd: 'npm', args: ['install'], requiresFile: 'package.json' }],
                { run, fileExists: () => true },
            );
            assert.strictEqual(outcomes[0].ok, false);
            assert.deepStrictEqual(autoInstallWarnings(outcomes), [
                'Dependency install failed — npm install: EAI_AGAIN registry unreachable',
            ]);
        });
    });

    // The wizard's *Next* button and the step's own hint must hang on the same
    // decision; it lives in the shared module so they cannot drift apart.
    suite('dependencyGate', () => {
        test('a missing required tool blocks until it is acknowledged', async () => {
            const run = fakeRunner({
                node: { ok: true, output: 'v20.11.1' },
                npm: { ok: false, error: 'not found on PATH' },
                git: { ok: true, output: 'git version 2.44.0' },
            });
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'win32' });

            const open = dependencyGate(report, false);
            assert.strictEqual(open.blocked, true);
            assert.strictEqual(open.probeFailed, false);
            assert.strictEqual(open.canAutoInstall, true);
            // Same rule the host uses for the report's own summary, no drift.
            assert.deepStrictEqual(open.blocking.map(d => d.label), report.missingRequired);

            const acknowledged = dependencyGate(report, true);
            assert.strictEqual(acknowledged.blocked, false);
            // The tool stays listed; only the gate opens.
            assert.deepStrictEqual(acknowledged.blocking.map(d => d.label), ['npm 9+']);
        });

        test('a missing optional tool never blocks', async () => {
            const run = fakeRunner({
                flutter: { ok: true, output: 'Flutter 3.19.4' },
                java: { ok: false, error: 'not found on PATH' },
                git: { ok: true, output: 'git version 2.44.0' },
            });
            const report = await checkProjectDependencies('flutter', {}, {}, { run, platform: 'linux' });
            const gate = dependencyGate(report, false);
            assert.deepStrictEqual(gate.blocking, []);
            assert.strictEqual(gate.blocked, false);
        });

        test('a failed probe is a soft warning, not a gate', async () => {
            const run: CommandRunner = async () => { throw new Error('spawn EPERM'); };
            const report = await checkProjectDependencies('python', {}, {}, { run, platform: 'linux' });
            const gate = dependencyGate(report, false);
            assert.strictEqual(gate.probeFailed, true);
            assert.strictEqual(gate.blocked, false);
        });

        test('no report yet means no blocking and nothing to install', () => {
            const gate = dependencyGate(null, false);
            assert.deepStrictEqual(gate.blocking, []);
            assert.strictEqual(gate.blocked, false);
            assert.strictEqual(gate.canAutoInstall, false);
        });
    });
});

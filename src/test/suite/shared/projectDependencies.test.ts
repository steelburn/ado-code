import * as assert from 'assert';
import {
    GIT_ONLY_TEMPLATE_IDS,
    compareVersions,
    dependencyGate,
    guidanceFor,
    meetsMinimum,
    parseVersion,
    planForTemplate,
} from '../../../shared/projectDependencies';
import { PROJECT_TEMPLATES } from '../../../webview-ui/src/components/ProjectCreationWizard/types';
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

        test('an SDK bootstrap renders as ordered steps, not one crammed line', () => {
            const flutter = planForTemplate('flutter').checks.find(c => c.id === 'flutter')!;
            assert.deepStrictEqual(guidanceFor(flutter, 'win32'), [
                'Install the "Flutter" extension (Dart-Code.flutter) — Ctrl+Shift+X → search Flutter → Install (also installs the Dart extension)',
                'Ctrl+Shift+P → "Flutter: New Project" → VS Code asks you to locate the SDK: choose Download SDK',
                'In the "Select Folder for Flutter SDK" dialog pick a folder → Clone Flutter (a git clone, so Git for Windows is needed)',
                'When the download ends click "Add SDK to PATH", restart VS Code, then Ctrl+Shift+P → "Flutter: Run Flutter Doctor"',
            ]);
            // Windows has no winget package for the Flutter SDK — `Flutter.Flutter` and
            // `Google.Flutter` both resolve to nothing on a refreshed index, so the hint
            // must never send anyone down that path again.
            assert.ok(!guidanceFor(flutter, 'win32').some(s => s.includes('winget')), 'the Flutter hint must not claim a winget id');
            assert.deepStrictEqual(guidanceFor(flutter, 'darwin'), [
                'brew install --cask flutter',
                'flutter doctor',
            ]);
        });

        // docs.flutter.dev/tools/vs-code is the page these steps are copied from, so
        // every landmark on it has to survive an edit: the extension install, the
        // palette-driven SDK download, the PATH button, and the palette doctor that
        // validates the setup before `flutter` is on PATH at all.
        test('the Flutter walkthrough stays faithful to docs.flutter.dev/tools/vs-code', () => {
            const flutter = planForTemplate('flutter').checks.find(c => c.id === 'flutter')!;
            const win = guidanceFor(flutter, 'win32');
            assert.strictEqual(win.length, 4, 'four ordered steps: extension, project, SDK download, validation');
            assert.ok(win[0].includes('Ctrl+Shift+X'), 'the extension is installed from the Extensions view');
            assert.ok(win.some(s => s.includes('Download SDK')), 'the SDK comes from the documented "Download SDK" prompt');
            assert.ok(win.some(s => s.includes('Clone Flutter')), 'the download is the documented "Clone Flutter" clone');
            assert.ok(win.some(s => s.includes('Add SDK to PATH')), 'PATH is wired up from the completion notification');
            assert.ok(win.some(s => s.includes('Flutter: Run Flutter Doctor')), 'validation uses the palette command that also works before PATH is applied');
            assert.ok(win.some(s => s.includes('Git for Windows')), '"Clone Flutter" is a git clone, so its prerequisite is named');
            assert.strictEqual(
                flutter.install?.url,
                'https://docs.flutter.dev/tools/vs-code',
                'the link points at the page the steps came from',
            );
            const note = flutter.install?.note ?? '';
            assert.ok(note.includes('xcode-select --install'), 'the macOS prerequisite is spelled out');
            assert.ok(note.includes('libglu1-mesa'), 'the Linux prerequisite is spelled out');
            assert.ok(note.includes('flutter doctor --android-licenses'), 'Android licences keep their documented escape hatch');
            assert.ok(!/only reports unaccepted Android licences/.test(note), 'doctor reports the whole toolchain, not just licences');
        });

        test('the dart hint follows dart.dev, which has no snap and no core formula', () => {
            const dart = planForTemplate('flutter').checks.find(c => c.id === 'dart')!;
            assert.deepStrictEqual(guidanceFor(dart, 'win32'), ['winget install --id=Google.DartSDK -e']);
            assert.deepStrictEqual(guidanceFor(dart, 'darwin'), [
                'brew tap dart-lang/dart',
                'brew trust dart-lang/dart',
                'brew install dart',
            ]);
            const linux = guidanceFor(dart, 'linux');
            assert.ok(linux.some(s => s.includes('apt-get install dart')), 'linux installs from the apt repo');
            assert.ok(!linux.some(s => s.includes('snap')), 'there is no dart snap');
        });

        test('blank steps are dropped and the neighbouring OS still wins', () => {
            const node = planForTemplate('node-ts').checks.find(c => c.id === 'node')!;
            const linuxOnly = { ...node, install: { linux: ['  ', 'sudo apt install nodejs'] } };
            assert.deepStrictEqual(guidanceFor(linuxOnly, 'darwin'), ['sudo apt install nodejs']);
            assert.deepStrictEqual(guidanceFor({ ...node, install: { win: '   ' } }, 'win32'), []);
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

        test('flutter documents where dart comes from and keeps a dart check that never vetoes', () => {
            const plan = planForTemplate('flutter');
            const flutter = plan.checks.find(c => c.id === 'flutter')!;
            assert.ok(flutter.install?.note?.includes('ships with Flutter'), 'the Flutter hint says where dart comes from');
            const dart = plan.checks.find(c => c.id === 'dart')!;
            assert.deepStrictEqual(dart.probes.map(p => p.cmd), ['dart']);
            assert.strictEqual(dart.required, false, 'a Flutter-bundled SDK is a PATH nicety, not a gate');
            assert.ok(dart.install?.note?.includes('flutter/bin'), 'the dart hint names where Flutter exposes it');
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

        // ── the standalone suite repo (docs/test-automation.md §8) ───────────────

        test('test-automation needs Node + npm + git and installs packages itself', () => {
            const plan = planForTemplate('test-automation');
            assert.deepStrictEqual(plan.checks.map(c => c.id), ['node', 'npm', 'playwright', 'git']);
            const node = plan.checks.find(c => c.id === 'node')!;
            const npm = plan.checks.find(c => c.id === 'npm')!;
            // Same specs the Node app templates probe — one toolchain, one table.
            const nodeTemplate = planForTemplate('node-ts');
            assert.deepStrictEqual(node, nodeTemplate.checks.find(c => c.id === 'node'));
            assert.deepStrictEqual(npm, nodeTemplate.checks.find(c => c.id === 'npm'));
            assert.strictEqual(node.required, true);
            assert.strictEqual(npm.required, true);
            assert.strictEqual(plan.checks.find(c => c.id === 'git')!.required, true, 'git is required like the other templates');
            assert.deepStrictEqual(
                plan.autoInstall.map(s => [s.id, s.cmd, s.args, s.requiresFile]),
                [['npm-install', 'npm', ['install'], 'package.json']],
            );
            assert.strictEqual(plan.warnings, undefined, 'a catalogue template needs no advisory');
        });

        test('test-automation keeps k6 and the browser download out of the plan', () => {
            const plan = planForTemplate('test-automation');
            assert.ok(!plan.checks.some(c => c.id === 'k6'), 'k6 is documented, never installed — so no check');
            assert.ok(
                !plan.autoInstall.some(s => s.args.some(a => a.includes('playwright'))),
                'the browser download must never be automatic',
            );
            const browsers = plan.checks.find(c => c.id === 'playwright')!;
            assert.strictEqual(browsers.required, false, 'a proxy-blocked download is a warning, not a gate');
            assert.ok(browsers.why.includes('npx playwright install --with-deps'), 'the item names the command to run');
            assert.ok(browsers.install?.note?.includes('never part of the automatic install'));
            // The plan type has checks + autoInstall only, so the optional check IS
            // the non-blocking channel (the generator's postCreateSteps are not ours).
            assert.deepStrictEqual(Object.keys(plan), ['checks', 'autoInstall']);
        });

        test('an api-only suite still needs Node/npm, but has no browsers to fetch', () => {
            const plan = planForTemplate('test-automation', { e2e: false, api: false });
            assert.ok(plan.checks.some(c => c.id === 'node' && c.required), 'the suite still needs a toolchain');
            assert.ok(plan.checks.some(c => c.id === 'npm' && c.required));
            assert.ok(!plan.checks.some(c => c.id === 'playwright'), 'no e2e folder, nothing to download');
            assert.deepStrictEqual(plan.autoInstall.map(s => s.id), ['npm-install']);
        });

        test('qaDocs adds pandoc as an optional export check', () => {
            const plan = planForTemplate('test-automation', { qaDocs: true });
            assert.strictEqual(plan.checks.find(c => c.id === 'pandoc')!.required, false);
            assert.ok(!planForTemplate('test-automation').checks.some(c => c.id === 'pandoc'), 'off by default');
        });

        // ── the option group on app templates (§6) ──────────────────────────────

        test('an app template with a requested suite adds Node/npm and the suite install', () => {
            const legacy = planForTemplate('node-ts');
            const plan = planForTemplate('node-ts', { testAutomation: 'playwright' });
            assert.deepStrictEqual(plan.checks.map(c => c.id), ['node', 'npm', 'playwright', 'git']);
            // The template's own checks survive untouched, git stays last.
            assert.deepStrictEqual(plan.checks.slice(0, 2), legacy.checks.slice(0, 2));
            assert.strictEqual(plan.checks[plan.checks.length - 1].id, 'git');
            assert.deepStrictEqual(plan.autoInstall.map(s => s.id), ['npm-install', 'npm-install-suite']);
            const suite = plan.autoInstall[1];
            assert.deepStrictEqual(suite.args, ['install', '--prefix', 'tests'], 'root-only: one step, from the project root');
            assert.strictEqual(suite.requiresFile, 'tests/package.json', 'gated on the suite manifest');
        });

        test('a non-Node app keeps its toolchain and gains npm for the suite', () => {
            const plan = planForTemplate('python', { testAutomation: 'api' });
            assert.deepStrictEqual(plan.checks.map(c => c.id), ['python', 'pip', 'node', 'npm', 'git']);
            assert.deepStrictEqual(plan.autoInstall.map(s => s.id), ['pip-install', 'npm-install-suite']);
            assert.ok(!plan.checks.some(c => c.id === 'playwright'), 'api-only: no browser download');
        });

        test("'none' is the legacy plan for every catalogue template", () => {
            for (const template of PROJECT_TEMPLATES) {
                assert.deepStrictEqual(
                    planForTemplate(template.id, { testAutomation: 'none' }),
                    planForTemplate(template.id),
                    `${template.id}: testAutomation 'none' must not change the plan`,
                );
            }
        });

        // Hard constraint (decision T4): the context-aware plan must still reproduce
        // today's plan byte for byte when no suite is requested. The table is that
        // frozen legacy shape — ids, order and the install steps.
        const LEGACY_PLANS: Array<[string, string[], string[]]> = [
            ['node-ts', ['node', 'npm', 'git'], ['npm-install']],
            ['node-js', ['node', 'npm', 'git'], ['npm-install']],
            ['react-ts', ['node', 'npm', 'git'], ['npm-install']],
            ['python', ['python', 'pip', 'git'], ['pip-install']],
            ['php-laravel', ['php', 'composer', 'git'], ['composer-install']],
            ['dotnet-webapi', ['dotnet', 'git'], ['dotnet-restore']],
            ['flutter', ['flutter', 'dart', 'java', 'git'], ['flutter-pub-get']],
            ['doc-ba', ['pandoc', 'git'], []],
            ['empty', ['git'], []],
        ];
        for (const [id, checkIds, installIds] of LEGACY_PLANS) {
            test(`"${id}" keeps its plan shape when no suite is requested`, () => {
                const plan = planForTemplate(id);
                assert.deepStrictEqual(plan.checks.map(c => c.id), checkIds);
                assert.deepStrictEqual(plan.autoInstall.map(s => s.id), installIds);
                assert.deepStrictEqual(Object.keys(plan), ['checks', 'autoInstall'], 'no extra plan fields');
                assert.strictEqual(plan.warnings, undefined);
            });
        }

        // ── finding T-F7: an unknown id must not be silent ──────────────────────

        test('an unknown id warns instead of silently probing only git', () => {
            const plan = planForTemplate('definitely-not-a-template');
            assert.deepStrictEqual(plan.checks.map(c => c.id), ['git'], 'the fallback plan is still git-only');
            assert.strictEqual(plan.warnings?.length, 1);
            assert.ok(plan.warnings[0].includes('definitely-not-a-template'), 'the warning names the id');
            assert.ok(plan.warnings[0].includes('only Git is checked'), 'and says what the plan could do');
        });

        test('the documented git-only template is silent, unlike an unknown id', () => {
            assert.deepStrictEqual(GIT_ONLY_TEMPLATE_IDS, ['empty'], 'derived from the catalogue, not invented');
            for (const id of GIT_ONLY_TEMPLATE_IDS) {
                const plan = planForTemplate(id);
                assert.strictEqual(plan.warnings, undefined, `${id} is a documented git-only target`);
                assert.deepStrictEqual(plan.checks.map(c => c.id), ['git']);
            }
        });

        // Drift guard: catalogue, plan table and warning must agree — a template
        // added without a plan case fails here instead of probing git only.
        test('every catalogue template is handled by the plan table', () => {
            for (const template of PROJECT_TEMPLATES) {
                assert.strictEqual(
                    planForTemplate(template.id).warnings,
                    undefined,
                    `"${template.id}" fell through to the unknown-template warning`,
                );
            }
        });
    });

    suite('checkProjectDependencies', () => {
        test('reports found versions and missing required tools', async () => {
            const run = fakeRunner({
                node: { ok: true, output: 'v20.11.1' },
                npm: { ok: false, error: 'not found on PATH' },
                git: { ok: true, output: 'git version 2.44.0.windows.1' },
            });
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'win32', env: false });

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
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'linux', env: false });
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
            const report = await checkProjectDependencies('python', {}, {}, { run, platform: 'darwin', env: false });
            assert.strictEqual(report.checks.find(c => c.id === 'python')!.version, '3.11.4');
            assert.deepStrictEqual(report.missingRequired, []);
        });

        test('plan advisories travel with the report and never gate', async () => {
            const run = fakeRunner({ git: { ok: true, output: 'git version 2.44.0' } });
            const report = await checkProjectDependencies('definitely-not-a-template', {}, {}, { run, platform: 'linux', env: false });
            assert.strictEqual(report.warnings?.length, 1, 'the plan warning is surfaced');
            assert.ok(report.warnings[0].includes('definitely-not-a-template'));
            assert.deepStrictEqual(report.missingRequired, []);
            assert.strictEqual(dependencyGate(report, false).blocked, false);
        });

        test('a known template carries no warnings field, so the legacy shape stays', async () => {
            const run = fakeRunner({
                node: { ok: true, output: 'v20.11.1' },
                npm: { ok: true, output: '10.2.4' },
                git: { ok: true, output: 'git version 2.44.0' },
            });
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'win32', env: false });
            assert.strictEqual('warnings' in report, false);
        });

        test('a thrown runner becomes a soft error, never a rejection', async () => {
            const run: CommandRunner = async () => { throw new Error('spawn EPERM'); };
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'win32', env: false });
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
                { run, fileExists: () => false, env: false },
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
                { run, fileExists: () => true, env: false },
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
            const report = await checkProjectDependencies('node-ts', {}, {}, { run, platform: 'win32', env: false });

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
            const report = await checkProjectDependencies('flutter', {}, {}, { run, platform: 'linux', env: false });
            const gate = dependencyGate(report, false);
            assert.deepStrictEqual(gate.blocking, []);
            assert.strictEqual(gate.blocked, false);
        });

        test('a failed probe is a soft warning, not a gate', async () => {
            const run: CommandRunner = async () => { throw new Error('spawn EPERM'); };
            const report = await checkProjectDependencies('python', {}, {}, { run, platform: 'linux', env: false });
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

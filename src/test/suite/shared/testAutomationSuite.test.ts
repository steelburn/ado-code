import * as assert from 'assert';
import * as ts from 'typescript';
import {
    DEFAULT_BASE_URL,
    EmittedFile,
    scaffoldTestAutomationSuite,
    TEST_AUTOMATION_OPTIONS,
    TestAutomationOptions,
} from '../../../shared/testAutomationSuite';

function filesOf(
    options: TestAutomationOptions = {},
    hint: { qaDocsFiles?: EmittedFile[] } = {},
): EmittedFile[] {
    return scaffoldTestAutomationSuite(options, hint).files;
}

function pathsOf(options: TestAutomationOptions = {}): string[] {
    return filesOf(options).map((file) => file.path);
}

/** The emitted file at `path`, with the "was it even emitted" failure named. */
function contentOf(options: TestAutomationOptions, path: string): string {
    const found = filesOf(options).find((file) => file.path === path);
    assert.ok(found, `expected ${path} to be emitted for ${JSON.stringify(options)}`);
    return found.content;
}

/** Syntactic diagnostics for one emitted TypeScript file — catches broken code. */
function parseDiagnostics(file: EmittedFile): string[] {
    const result = ts.transpileModule(file.content, {
        fileName: file.path,
        reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    });
    return (result.diagnostics ?? []).map(
        (diagnostic) => `${file.path}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
}

suite('shared/testAutomationSuite', () => {
    suite('defaults', () => {
        test('emits the browser suite, the API suite, test data and the root files', () => {
            const paths = pathsOf();
            for (const expected of [
                'package.json',
                'tsconfig.json',
                '.env.example',
                'README.md',
                'CHANGELOG.md',
                'e2e/playwright.config.ts',
                'e2e/fixtures/test.ts',
                'e2e/pages/base.page.ts',
                'e2e/specs/smoke.spec.ts',
                'api/vitest.config.ts',
                'api/client.ts',
                'api/fixtures/requests.ts',
                'api/specs/smoke.api.test.ts',
                'testdata/seed.json',
                'testdata/generate.ts',
                'reporting/html/config.ts',
                'reporting/evidence/README.md',
            ]) {
                assert.ok(paths.includes(expected), `missing ${expected}`);
            }
        });

        test('emits no performance script, no CI workflow and no Allure config', () => {
            const paths = pathsOf();
            assert.strictEqual(paths.some((path) => path.startsWith('perf/')), false);
            assert.strictEqual(paths.some((path) => path.startsWith('.github/')), false);
            assert.strictEqual(paths.includes('azure-pipelines.yml'), false);
            assert.strictEqual(paths.some((path) => path.startsWith('reporting/allure/')), false);
            assert.strictEqual(paths.some((path) => path.startsWith('docs/')), false);
        });

        test('hands ignore lines to the caller instead of emitting a .gitignore', () => {
            const result = scaffoldTestAutomationSuite();
            assert.strictEqual(
                result.files.some((file) => file.path === '.gitignore'),
                false,
            );
            for (const line of [
                'test-results/',
                'playwright-report/',
                '.playwright/',
                'allure-results/',
                'perf/reports/',
                'node_modules/',
                'dist/',
            ]) {
                assert.ok(result.ignoreLines.includes(line), `missing ignore line ${line}`);
            }
        });

        test('is deterministic — the same options emit the same bytes', () => {
            const options: TestAutomationOptions = {
                ci: 'github',
                reporting: 'both',
                perf: true,
                sample: false,
            };
            assert.deepStrictEqual(
                scaffoldTestAutomationSuite(options),
                scaffoldTestAutomationSuite(options),
            );
        });
    });

    suite('option matrix', () => {
        test('ci x reporting x sample produce the expected file set', () => {
            const reportings = ['html', 'allure', 'both'] as const;
            for (const ci of ['none', 'github', 'azure'] as const) {
                for (const reporting of reportings) {
                    for (const sample of [true, false]) {
                        const label = `ci=${ci} reporting=${reporting} sample=${sample}`;
                        const paths = pathsOf({ ci, reporting, sample });

                        const ciFile =
                            ci === 'github'
                                ? '.github/workflows/test.yml'
                                : ci === 'azure'
                                  ? 'azure-pipelines.yml'
                                  : undefined;
                        if (ciFile) {
                            assert.ok(paths.includes(ciFile), `missing ${ciFile} (${label})`);
                        } else {
                            assert.strictEqual(
                                paths.some((path) => path.startsWith('.github/')),
                                false,
                                label,
                            );
                            assert.strictEqual(paths.includes('azure-pipelines.yml'), false, label);
                        }

                        assert.strictEqual(
                            paths.includes('reporting/html/config.ts'),
                            reporting !== 'allure',
                            `html config (${label})`,
                        );
                        assert.strictEqual(
                            paths.includes('reporting/allure/config.ts'),
                            reporting !== 'html',
                            `allure config (${label})`,
                        );

                        assert.strictEqual(
                            paths.includes('e2e/specs/smoke.spec.ts'),
                            sample,
                            `e2e sample (${label})`,
                        );
                        assert.strictEqual(
                            paths.includes('api/specs/smoke.api.test.ts'),
                            sample,
                            `api sample (${label})`,
                        );
                        // The configs exist whether or not a sample spec does.
                        assert.ok(paths.includes('e2e/playwright.config.ts'), label);
                        assert.ok(paths.includes('api/vitest.config.ts'), label);
                    }
                }
            }
        });

        test('reporting is absent when both suites are off, even when requested', () => {
            const paths = pathsOf({ e2e: false, api: false, reporting: 'both' });
            assert.strictEqual(paths.some((path) => path.startsWith('reporting/')), false);
            assert.strictEqual(paths.some((path) => path.startsWith('e2e/')), false);
            assert.strictEqual(paths.some((path) => path.startsWith('api/')), false);
        });

        test('api-only and e2e-only keep only the reporting they can produce', () => {
            const apiOnly = pathsOf({ e2e: false, reporting: 'allure' });
            assert.strictEqual(apiOnly.includes('reporting/allure/config.ts'), true);
            assert.strictEqual(apiOnly.includes('reporting/html/config.ts'), false);
            assert.strictEqual(
                apiOnly.some((path) => path.startsWith('e2e/')),
                false,
            );

            const e2eOnly = pathsOf({ api: false, reporting: 'both' });
            assert.strictEqual(e2eOnly.includes('e2e/playwright.config.ts'), true);
            assert.strictEqual(
                e2eOnly.some((path) => path.startsWith('api/')),
                false,
            );
        });

        test('perf adds the k6 script and the script entry, nothing else', () => {
            const paths = pathsOf({ perf: true });
            assert.ok(paths.includes('perf/smoke.js'));
            const scripts = JSON.parse(contentOf({ perf: true }, 'package.json')).scripts;
            assert.strictEqual(scripts['test:perf'], 'k6 run perf/smoke.js');
            const withoutPerf = JSON.parse(contentOf({}, 'package.json')).scripts;
            assert.strictEqual(withoutPerf['test:perf'], undefined);
        });
    });

    suite('honesty about what is switched off', () => {
        test('e2e:false, api:false leaves no e2e/ or api/ reference in the README', () => {
            const readme = contentOf({ e2e: false, api: false }, 'README.md');
            for (const reference of ['e2e/', 'api/', 'playwright', 'vitest', 'test:e2e', 'test:api']) {
                assert.strictEqual(
                    readme.toLowerCase().includes(reference.toLowerCase()),
                    false,
                    `README still mentions ${reference}`,
                );
            }
        });

        test('README and package.json stay quiet about the browser suite when it is off', () => {
            const readme = contentOf({ e2e: false }, 'README.md').toLowerCase();
            for (const reference of ['playwright', 'chromium', 'test-results/', 'trace']) {
                assert.strictEqual(readme.includes(reference), false, `README mentions ${reference}`);
            }
            const scripts = JSON.parse(contentOf({ e2e: false }, 'package.json')).scripts;
            assert.strictEqual(scripts['test:e2e'], undefined);
            assert.strictEqual(scripts.report, undefined);
            assert.strictEqual(String(scripts.test).includes('test:e2e'), false);
        });

        test('README and package.json stay quiet about the API suite when it is off', () => {
            const readme = contentOf({ api: false }, 'README.md').toLowerCase();
            for (const reference of ['vitest', 'junit', 'test:api', 'api/client']) {
                assert.strictEqual(readme.includes(reference), false, `README mentions ${reference}`);
            }
            const scripts = JSON.parse(contentOf({ api: false }, 'package.json')).scripts;
            assert.strictEqual(scripts['test:api'], undefined);
            assert.strictEqual(String(scripts.test).includes('test:api'), false);
        });

        test('with nothing enabled npm test only typechecks', () => {
            const scripts = JSON.parse(contentOf({ e2e: false, api: false }, 'package.json')).scripts;
            assert.strictEqual(scripts.test, 'npm run typecheck');
            assert.strictEqual(scripts.testdata, 'tsx testdata/generate.ts');
        });
    });

    suite('emitted file quality', () => {
        test('every emitted .json file parses', () => {
            const files = filesOf({ ci: 'github', reporting: 'both', perf: true });
            for (const file of files.filter((entry) => entry.path.endsWith('.json'))) {
                assert.doesNotThrow(() => JSON.parse(file.content), `${file.path} is not valid JSON`);
            }
        });

        test('every emitted .ts file parses as TypeScript', () => {
            const files = filesOf({ ci: 'github', reporting: 'both', perf: true, qaDocs: true }, {
                qaDocsFiles: [{ path: 'plan.md', content: '# Plan\n' }],
            });
            const diagnostics = files
                .filter((file) => file.path.endsWith('.ts'))
                .flatMap(parseDiagnostics);
            assert.deepStrictEqual(diagnostics, []);
        });

        test('no interpolation escape leaks into the emitted content', () => {
            const files = filesOf(
                { ci: 'azure', reporting: 'both', perf: true, qaDocs: true, sample: true },
                { qaDocsFiles: [{ path: '00-control/plan.md', content: '# Plan\n' }] },
            );
            // These two deliberately contain escapes in the code they emit.
            const escapable = new Set(['api/client.ts', 'testdata/generate.ts']);
            for (const file of files) {
                assert.strictEqual(file.content.includes('\\r'), false, `${file.path} has a literal \\r`);
                assert.strictEqual(file.content.includes('\\`'), false, `${file.path} has a literal \\\``);
                assert.strictEqual(
                    /\\\n$/.test(file.content),
                    false,
                    `${file.path} ends a line with a dangling backslash`,
                );
                if (!escapable.has(file.path)) {
                    assert.strictEqual(file.content.includes('\\n'), false, `${file.path} has a literal \\n`);
                }
            }
        });

        test('paths are relative, POSIX and unique', () => {
            const paths = pathsOf({ ci: 'github', reporting: 'both', perf: true });
            for (const path of paths) {
                assert.strictEqual(path.startsWith('./'), false, path);
                assert.strictEqual(path.startsWith('/'), false, path);
                assert.strictEqual(path.includes('\\'), false, path);
                assert.strictEqual(path, path.trim(), path);
            }
            assert.strictEqual(new Set(paths).size, paths.length);
        });

        test('baseUrl is interpolated into the env template, the client and the config', () => {
            const options: TestAutomationOptions = { baseUrl: 'https://qa.example.com/' };
            assert.ok(contentOf(options, '.env.example').includes('BASE_URL=https://qa.example.com'));
            assert.ok(contentOf(options, 'api/client.ts').includes('"https://qa.example.com"'));
            assert.ok(
                contentOf(options, 'e2e/playwright.config.ts').includes('"https://qa.example.com"'),
            );
            assert.ok(contentOf({}, '.env.example').includes(`BASE_URL=${DEFAULT_BASE_URL}`));
        });

        test('the sample specs never need a live server', () => {
            const e2eSpec = contentOf({}, 'e2e/specs/smoke.spec.ts');
            assert.ok(e2eSpec.includes('setContent('), 'the browser sample must render its own page');
            assert.strictEqual(e2eSpec.includes('goto('), false, 'the browser sample must not navigate');
            assert.ok(e2eSpec.includes('expect('), 'the browser sample must assert');

            const apiSpec = contentOf({}, 'api/specs/smoke.api.test.ts');
            assert.ok(apiSpec.includes('process.env.LIVE_API'), 'live checks must be opt-in');
            assert.ok(apiSpec.includes('describe.skipIf'), 'live checks must skip when unset');
            assert.ok(apiSpec.includes('expect('), 'the API sample must assert');
        });

        test('the browser config reads BASE_URL and uses the HTML reporter by default', () => {
            const config = contentOf({}, 'e2e/playwright.config.ts');
            assert.ok(config.includes('process.env.BASE_URL'));
            assert.ok(config.includes('htmlReport'));
            assert.strictEqual(config.includes('allureReport'), false);
            assert.ok(contentOf({ reporting: 'allure' }, 'e2e/playwright.config.ts').includes('allureReport'));
        });
    });

    suite('tester docs bridge', () => {
        test('qaDocs renders the caller-supplied documents under docs/', () => {
            const result = scaffoldTestAutomationSuite(
                { qaDocs: true },
                {
                    qaDocsFiles: [
                        { path: 'docs/00-project-control/test-plan.md', content: '# Test plan\n' },
                        { path: 'test-cases/tc-001.md', content: '# TC-001\n' },
                    ],
                },
            );
            const paths = result.files.map((file) => file.path);
            assert.ok(paths.includes('docs/00-project-control/test-plan.md'));
            assert.ok(paths.includes('docs/test-cases/tc-001.md'));
            assert.strictEqual(
                paths.some((path) => path.includes('docs/docs/')),
                false,
            );
        });

        test('qaDocs without documents warns instead of emitting an empty docs/', () => {
            const result = scaffoldTestAutomationSuite({ qaDocs: true });
            assert.strictEqual(
                result.files.some((file) => file.path.startsWith('docs/')),
                false,
            );
            assert.ok(result.warnings.some((warning) => warning.includes('qaDocs')));
        });

        test('qaDocs is off by default', () => {
            assert.strictEqual(
                filesOf().some((file) => file.path.startsWith('docs/')),
                false,
            );
        });
    });

    suite('next steps', () => {
        test('postCreateSteps asks for the browsers and never lands in the files', () => {
            const result = scaffoldTestAutomationSuite();
            assert.strictEqual(result.postCreateSteps.length, 1);
            assert.ok(
                (result.postCreateSteps[0].command ?? '').includes('npx playwright install --with-deps'),
            );
            assert.strictEqual(
                result.files.some((file) => file.path.includes('postCreateStep')),
                false,
            );
        });

        test('without the browser suite there is nothing to install', () => {
            assert.deepStrictEqual(scaffoldTestAutomationSuite({ e2e: false }).postCreateSteps, []);
        });

        test('warnings cover the optional tooling only', () => {
            const browsers = scaffoldTestAutomationSuite().warnings;
            assert.ok(browsers.some((warning) => warning.includes('playwright install')));
            const perf = scaffoldTestAutomationSuite({ perf: true }).warnings;
            assert.ok(perf.some((warning) => warning.includes('k6 is not installed')));
            assert.deepStrictEqual(scaffoldTestAutomationSuite({ e2e: false, api: false }).warnings, []);
        });
    });

    suite('catalogue drift', () => {
        test('the option metadata covers the generator defaults', () => {
            const byId = new Map(TEST_AUTOMATION_OPTIONS.map((option) => [option.id, option]));
            assert.deepStrictEqual([...byId.keys()], [
                'e2e',
                'api',
                'perf',
                'reporting',
                'ci',
                'sample',
                'qaDocs',
                'baseUrl',
            ]);
            assert.deepStrictEqual(byId.get('e2e')?.default, true);
            assert.deepStrictEqual(byId.get('api')?.default, true);
            assert.deepStrictEqual(byId.get('perf')?.default, false);
            assert.deepStrictEqual(byId.get('reporting')?.default, 'html');
            assert.deepStrictEqual(byId.get('ci')?.default, 'none');
            assert.deepStrictEqual(byId.get('sample')?.default, true);
            assert.deepStrictEqual(byId.get('qaDocs')?.default, false);
            assert.deepStrictEqual(byId.get('baseUrl')?.default, DEFAULT_BASE_URL);
        });

        test('applying the catalogue defaults matches an options-less request', () => {
            const fromCatalogue: Record<string, unknown> = {};
            for (const option of TEST_AUTOMATION_OPTIONS) {
                fromCatalogue[option.id] = option.default;
            }
            assert.deepStrictEqual(
                pathsOf(fromCatalogue as TestAutomationOptions),
                pathsOf({}),
            );
        });

        test('reporting is hidden when no suite can produce a report', () => {
            const reporting = TEST_AUTOMATION_OPTIONS.find((option) => option.id === 'reporting');
            assert.ok(reporting?.showWhen, 'reporting needs showWhen');
            assert.strictEqual(reporting.showWhen({ e2e: false, api: false }), false);
            assert.strictEqual(reporting.showWhen({ e2e: true, api: false }), true);
            assert.strictEqual(reporting.showWhen({ e2e: false, api: true }), true);
        });

        test('unknown option values fall back to the documented defaults', () => {
            const typo = {
                reporting: 'allure2',
                ci: 'jenkins',
            } as unknown as TestAutomationOptions;
            assert.deepStrictEqual(pathsOf(typo), pathsOf({}));
        });
    });
});

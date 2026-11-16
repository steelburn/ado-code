/**
 * Test-automation suite generator — the executable half of the
 * `test-automation` project template (`/new-project`).
 *
 * WHAT IT IS
 * ----------
 * One pure function that returns the files of a runnable test suite repo:
 * Playwright for the browser, Vitest for HTTP, k6 for a performance smoke,
 * plus test data, reporting wiring, an optional CI workflow and a README that
 * is part of the deliverable. It writes nothing — the caller writes the files,
 * merges `ignoreLines` into `.gitignore` and surfaces `postCreateSteps` in the
 * wizard's Next Steps.
 *
 * WHY IT IS PURE
 * --------------
 * No fs, no vscode, no child_process, no import of the documentation renderer:
 * the suite is reversible, deterministic and testable headlessly, and a suite
 * bug is fixed in exactly one place. `qaDocs` is a *hint* instead — the caller
 * passes `testerDocs()` output in, so the document renderer keeps its own
 * contract (see docs/test-automation.md, T-F2).
 *
 * WHY ONE LANGUAGE
 * ----------------
 * TypeScript + Playwright / Vitest / k6 for every app stack: a tester exercises
 * HTTP and the UI, not the app's own language, so there is no language matrix
 * to maintain (T3). k6 is documented, never installed — it is a single
 * platform-specific binary.
 *
 * WHY THE SAMPLE IS ON BY DEFAULT
 * -------------------------------
 * A suite repo whose first `npm test` is red reads as a scaffolding defect, so
 * the emitted sample specs assert against markup they render themselves and
 * any live check is skipped unless `LIVE_API=1` (T6, §12).
 */

import type { PostCreateStep } from '../webview-ui/src/components/ProjectCreationWizard/types';

/** Application under test, used when the caller supplies no `baseUrl`. */
export const DEFAULT_BASE_URL = 'http://localhost:3000';

/**
 * Options of the `test-automation` template. Every field is optional so a
 * partially-specified request (an old wizard state, a test fixture) resolves
 * to the documented defaults instead of blowing up.
 */
export interface TestAutomationOptions {
    /** Playwright browser suite. Default `true`. */
    e2e?: boolean;
    /** Vitest HTTP suite over a small fetch client. Default `true`. */
    api?: boolean;
    /** k6 smoke script only — no load profiles. Default `false`. */
    perf?: boolean;
    /** HTML report, Allure results, or both. Default `'html'`. */
    reporting?: 'html' | 'allure' | 'both';
    /** One workflow that runs whatever exists. Default `'none'`. */
    ci?: 'none' | 'github' | 'azure';
    /** Emit one passing smoke spec so the first run is green. Default `true`. */
    sample?: boolean;
    /** Render the tester doc set into `docs/`. Default `false`. */
    qaDocs?: boolean;
    /** Written to `.env.example` and used as the client fallback. */
    baseUrl?: string;
}

/** One file to write, path relative to the suite root. */
export interface EmittedFile {
    /** POSIX separators, no leading `./`, no leading slash. */
    path: string;
    content: string;
}

/**
 * Structural twin of the wizard's `TemplateOption`, widened with `showWhen`
 * (the conditional-visibility hook the wizard's options step filters on).
 * Exported here so the catalogue entry and this generator cannot drift.
 */
export interface TemplateOptionLike {
    id: string;
    label: string;
    type: 'boolean' | 'select' | 'input';
    default: boolean | string;
    /** Allowed values for a `select`. */
    options?: string[];
    description?: string;
    /** Hide the control when the current option values make it meaningless. */
    showWhen?: (values: Record<string, unknown>) => boolean;
}

export interface TestAutomationSuiteResult {
    /** Paths relative to the suite root, POSIX separators, no leading dot. */
    files: EmittedFile[];
    /** Lines the caller merges into the project's `.gitignore`. */
    ignoreLines: string[];
    /** Genuinely optional things (browser download, missing k6), never errors. */
    warnings: string[];
    /** Commands the user still has to run — never a hard requirement. */
    postCreateSteps: PostCreateStep[];
}

type Reporting = 'html' | 'allure' | 'both';
type Ci = 'none' | 'github' | 'azure';

/** Options with every default applied and every value normalised. */
interface ResolvedOptions {
    e2e: boolean;
    api: boolean;
    perf: boolean;
    reporting: Reporting;
    ci: Ci;
    sample: boolean;
    qaDocs: boolean;
    /** Trimmed, no trailing slash, never empty. */
    baseUrl: string;
}

const REPORTING_VALUES: readonly Reporting[] = ['html', 'allure', 'both'];
const CI_VALUES: readonly Ci[] = ['none', 'github', 'azure'];

/**
 * Ignore lines handed back to the caller (project-scaffolding.md F4: the
 * writer's `.gitignore` has to be options-aware, so the suite cannot own it).
 */
const IGNORE_LINES: readonly string[] = [
    'test-results/',
    'playwright-report/',
    '.playwright/',
    'allure-results/',
    'perf/reports/',
    'node_modules/',
    'dist/',
];

/** Reported only when at least one of the two executable suites is on. */
const isSuiteEnabled = (values: Record<string, unknown>): boolean =>
    values.e2e !== false || values.api !== false;

/**
 * The option metadata from docs/test-automation.md §5. Lives next to the
 * generator so the catalogue entry and the emitted files are one source.
 */
export const TEST_AUTOMATION_OPTIONS: TemplateOptionLike[] = [
    {
        id: 'e2e',
        label: 'Browser suite (Playwright)',
        type: 'boolean',
        default: true,
        description: 'Chromium suite with traces, screenshots and a page-object base.',
    },
    {
        id: 'api',
        label: 'API suite (Vitest)',
        type: 'boolean',
        default: true,
        description: 'HTTP suite over a small fetch client; cheap enough to leave on.',
    },
    {
        id: 'perf',
        label: 'Performance smoke (k6)',
        type: 'boolean',
        default: false,
        description: 'One k6 smoke script. k6 is documented, never installed.',
    },
    {
        id: 'reporting',
        label: 'Reporting',
        type: 'select',
        default: 'html',
        options: [...REPORTING_VALUES],
        description: 'HTML report, Allure results, or both.',
        showWhen: isSuiteEnabled,
    },
    {
        id: 'ci',
        label: 'CI workflow',
        type: 'select',
        default: 'none',
        options: [...CI_VALUES],
        description: 'One workflow that runs whichever suites exist.',
    },
    {
        id: 'sample',
        label: 'Sample smoke spec',
        type: 'boolean',
        default: true,
        description: 'Keeps the first test run green with a self-contained check.',
    },
    {
        id: 'qaDocs',
        label: 'Tester documents',
        type: 'boolean',
        default: false,
        description: 'Render the tester document set into docs/.',
    },
    {
        id: 'baseUrl',
        label: 'Application URL',
        type: 'input',
        default: DEFAULT_BASE_URL,
        description: 'Written to .env.example and used as the runtime fallback.',
    },
];

/**
 * Build the whole suite in memory.
 *
 * @param options Template options; anything missing falls back to the defaults
 *                in `TEST_AUTOMATION_OPTIONS`.
 * @param hint    `qaDocsFiles` is the caller's `testerDocs()` output — this
 *                module never imports the documentation renderer.
 */
export function scaffoldTestAutomationSuite(
    options: TestAutomationOptions = {},
    hint: { qaDocsFiles?: EmittedFile[] } = {},
): TestAutomationSuiteResult {
    const resolved = resolveOptions(options);
    const docs = hintDocs(hint);
    const files: EmittedFile[] = [];
    const add = (path: string, content: string): void => {
        files.push(emitFile(path, content));
    };

    add('package.json', packageJson(resolved));
    add('tsconfig.json', tsConfig(resolved));
    add('.env.example', envExample(resolved));
    add('README.md', readme(resolved));
    add('CHANGELOG.md', changelog(resolved));

    if (resolved.e2e) {
        add('e2e/playwright.config.ts', playwrightConfig(resolved));
        add('e2e/fixtures/test.ts', e2eFixtures());
        add('e2e/pages/base.page.ts', pageObjectBase());
        if (resolved.sample) {
            add('e2e/specs/smoke.spec.ts', e2eSmokeSpec());
        }
    }

    if (resolved.api) {
        add('api/vitest.config.ts', vitestConfig());
        add('api/client.ts', apiClient(resolved));
        add('api/fixtures/requests.ts', apiFixtures());
        if (resolved.sample) {
            add('api/specs/smoke.api.test.ts', apiSmokeSpec());
        }
    }

    if (resolved.perf) {
        add('perf/smoke.js', perfSmoke(resolved));
    }

    add('testdata/seed.json', seedJson());
    add('testdata/generate.ts', testdataGenerator());

    // Reporting is only meaningful while a suite exists to produce a report.
    if (resolved.e2e || resolved.api) {
        if (resolved.reporting === 'html' || resolved.reporting === 'both') {
            add('reporting/html/config.ts', htmlReportConfig(resolved));
        }
        if (resolved.reporting === 'allure' || resolved.reporting === 'both') {
            add('reporting/allure/config.ts', allureReportConfig());
        }
        add('reporting/evidence/README.md', evidenceReadme(resolved));
    }

    if (resolved.ci === 'github') {
        add('.github/workflows/test.yml', githubWorkflow(resolved));
    }
    if (resolved.ci === 'azure') {
        add('azure-pipelines.yml', azurePipeline(resolved));
    }

    for (const doc of docs) {
        add(`docs/${doc.path}`, doc.content);
    }

    return {
        files,
        ignoreLines: [...IGNORE_LINES],
        warnings: warningsFor(resolved, docs.length),
        postCreateSteps: postCreateStepsFor(resolved),
    };
}

// ---------------------------------------------------------------------------
// option resolution
// ---------------------------------------------------------------------------

function resolveOptions(options: TestAutomationOptions): ResolvedOptions {
    const rawUrl = typeof options.baseUrl === 'string' ? options.baseUrl.trim() : '';
    return {
        e2e: flag(options.e2e, true),
        api: flag(options.api, true),
        perf: flag(options.perf, false),
        reporting: oneOf(options.reporting, REPORTING_VALUES, 'html'),
        ci: oneOf(options.ci, CI_VALUES, 'none'),
        sample: flag(options.sample, true),
        qaDocs: flag(options.qaDocs, false),
        baseUrl: rawUrl.length > 0 ? rawUrl.replace(/\/+$/, '') : DEFAULT_BASE_URL,
    };
}

/** Explicit `false` is `false`; `undefined`/`null` is the fallback. */
function flag(value: unknown, fallback: boolean): boolean {
    return value === undefined || value === null ? fallback : Boolean(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : fallback;
}

// ---------------------------------------------------------------------------
// emit helpers
// ---------------------------------------------------------------------------

function emitFile(path: string, content: string): EmittedFile {
    const normalized = content.replace(/\r\n/g, '\n');
    return {
        path: normalizePath(path),
        content: normalized.endsWith('\n') ? normalized : `${normalized}\n`,
    };
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Tester docs arrive with project-root-relative paths; `docs/` is re-rooted. */
function hintDocs(hint: { qaDocsFiles?: EmittedFile[] }): EmittedFile[] {
    return (hint.qaDocsFiles ?? []).map((doc) => ({
        path: normalizePath(doc.path).replace(/^docs\//, ''),
        content: doc.content,
    }));
}

/** JSON with sorted keys: stable output, no diff churn on regeneration. */
function jsonString(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// root files
// ---------------------------------------------------------------------------

function packageJson(o: ResolvedOptions): string {
    const dependencies: Record<string, string> = {
        '@types/node': '^20.16.0',
        typescript: '^5.6.0',
        tsx: '^4.19.0',
    };
    if (o.e2e) {
        dependencies['@playwright/test'] = '^1.49.0';
    }
    if (o.api) {
        dependencies.vitest = '^2.1.0';
    }
    const wantsAllure = o.reporting === 'allure' || o.reporting === 'both';
    if (o.e2e && wantsAllure) {
        dependencies['allure-playwright'] = '^3.0.0';
        dependencies['allure-commandline'] = '^2.30.0';
    }

    return jsonString({
        name: 'test-automation-suite',
        version: '0.1.0',
        private: true,
        description: describeSuites(o),
        scripts: packageScripts(o),
        devDependencies: sortedRecord(dependencies),
    });
}

function packageScripts(o: ResolvedOptions): Record<string, string> {
    const scripts: Record<string, string> = {};

    const chain = ['npm run typecheck'];
    if (o.api) {
        chain.push('npm run test:api');
    }
    if (o.e2e) {
        chain.push('npm run test:e2e');
    }
    scripts.test = chain.join(' && ');

    if (o.e2e) {
        scripts['test:e2e'] = `playwright test --config e2e/playwright.config.ts${o.sample ? '' : ' --passWithNoTests'}`;
    }
    if (o.api) {
        scripts['test:api'] = `vitest run --root api${o.sample ? '' : ' --passWithNoTests'}`;
    }
    if (o.perf) {
        scripts['test:perf'] = 'k6 run perf/smoke.js';
    }

    Object.assign(scripts, reportScripts(o));

    scripts.testdata = 'tsx testdata/generate.ts';
    scripts.typecheck = 'tsc --noEmit';
    return scripts;
}

/**
 * `report` exists only when a command can actually open something: without the
 * browser suite there is no HTML site and no Allure run to render.
 */
function reportScripts(o: ResolvedOptions): Record<string, string> {
    if (!o.e2e) {
        return {};
    }
    const wantsHtml = o.reporting === 'html' || o.reporting === 'both';
    const wantsAllure = o.reporting === 'allure' || o.reporting === 'both';
    const parts: Record<string, string> = {};
    if (wantsHtml) {
        parts['report:html'] = 'playwright show-report playwright-report';
    }
    if (wantsAllure) {
        parts['report:allure'] =
            'allure generate allure-results --clean -o reporting/allure/report && allure open reporting/allure/report';
    }

    const scripts: Record<string, string> = {};
    const names = Object.keys(parts);
    if (names.length === 1) {
        scripts.report = parts[names[0]];
        return scripts;
    }
    if (names.length > 1) {
        scripts.report = names.map((name) => `npm run ${name}`).join(' && ');
    }
    Object.assign(scripts, parts);
    return scripts;
}

function sortedRecord(value: Record<string, string>): Record<string, string> {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key];
    }
    return sorted;
}

function describeSuites(o: ResolvedOptions): string {
    const suites: string[] = [];
    if (o.e2e) {
        suites.push('Playwright browser suite');
    }
    if (o.api) {
        suites.push('Vitest API suite');
    }
    if (o.perf) {
        suites.push('k6 performance smoke');
    }
    return suites.length > 0 ? suites.join(' + ') : 'Test automation scaffolding';
}

function tsConfig(o: ResolvedOptions): string {
    const include: string[] = [];
    if (o.e2e) {
        include.push('e2e');
    }
    if (o.api) {
        include.push('api');
    }
    include.push('testdata');
    if (o.e2e || o.api) {
        include.push('reporting');
    }

    return jsonString({
        compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            lib: ['ES2022', 'DOM'],
            types: ['node'],
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            skipLibCheck: true,
            resolveJsonModule: true,
            forceConsistentCasingInFileNames: true,
        },
        include,
    });
}

function envExample(o: ResolvedOptions): string {
    const lines = [
        '# Copy the values you need into your shell or CI environment — this',
        '# file is documentation, nothing loads it automatically.',
        `BASE_URL=${o.baseUrl}`,
    ];
    if (o.e2e || o.api) {
        lines.push(
            '# Set LIVE_API=1 to run the checks that touch a running app.',
            'LIVE_API=',
        );
    }
    return `${lines.join('\n')}\n`;
}

function changelog(o: ResolvedOptions): string {
    const parts: string[] = [];
    if (o.e2e) {
        parts.push('Playwright browser suite');
    }
    if (o.api) {
        parts.push('Vitest API suite');
    }
    if (o.perf) {
        parts.push('k6 performance smoke');
    }
    if (o.sample) {
        parts.push('sample specs that pass on a blank repository');
    }
    const summary = parts.length > 0 ? parts.join(', ') : 'shared scaffolding only';
    return ['# Changelog', '', '## 0.1.0', '', `- Initial suite: ${summary}.`].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// browser suite (e2e/)
// ---------------------------------------------------------------------------

function playwrightConfig(o: ResolvedOptions): string {
    const wantsHtml = o.reporting === 'html' || o.reporting === 'both';
    const wantsAllure = o.reporting === 'allure' || o.reporting === 'both';

    const imports: string[] = [];
    const reporters: string[] = [];
    if (wantsAllure) {
        imports.push("import { allureReport } from '../reporting/allure/config';");
        reporters.push('allureReport');
    }
    if (wantsHtml) {
        imports.push("import { htmlReport } from '../reporting/html/config';");
        reporters.push('htmlReport');
    }

    const reporterLine =
        reporters.length === 0
            ? "    reporter: [['list']],"
            : `    reporter: [${reporters.join(', ')}],`;

    return [
        "import { defineConfig, devices } from '@playwright/test';",
        ...imports,
        '',
        `const BASE_URL = process.env.BASE_URL ?? ${JSON.stringify(o.baseUrl)};`,
        '',
        '/**',
        ' * Everything the browser suite needs. BASE_URL is the only environment',
        ' * variable it reads, so no spec hard-codes a host.',
        ' */',
        'export default defineConfig({',
        "    testDir: './specs',",
        '    fullyParallel: true,',
        '    forbidOnly: !!process.env.CI,',
        '    retries: process.env.CI ? 2 : 0,',
        '    workers: process.env.CI ? 1 : undefined,',
        reporterLine,
        "    outputDir: '../test-results',",
        '    use: {',
        '        baseURL: BASE_URL,',
        "        trace: 'on-first-retry',",
        "        screenshot: 'only-on-failure',",
        "        video: 'retain-on-failure',",
        '    },',
        '    projects: [',
        "        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },",
        '    ],',
        '});',
        '',
    ].join('\n');
}

function e2eFixtures(): string {
    return [
        "import { test as base, expect } from '@playwright/test';",
        '',
        '/**',
        ' * Fixtures every spec shares. Add new ones here rather than in a spec, so',
        ' * one page/console listener cannot drift between files.',
        ' */',
        'export interface SuiteFixtures {',
        '    /** Browser console errors seen so far — assert that a journey is clean. */',
        '    consoleErrors: string[];',
        '}',
        '',
        'export const test = base.extend<SuiteFixtures>({',
        '    consoleErrors: async ({ page }, use) => {',
        '        const errors: string[] = [];',
        "        page.on('console', (message) => {",
        "            if (message.type() === 'error') {",
        '                errors.push(message.text());',
        '            }',
        '        });',
        '        await use(errors);',
        '    },',
        '});',
        '',
        'export { expect };',
        '',
    ].join('\n');
}

function pageObjectBase(): string {
    return [
        "import type { Locator, Page } from '@playwright/test';",
        '',
        '/**',
        ' * Page-object base. A concrete page passes its own route and adds the',
        ' * locators its spec needs, so the spec says what to assert, not how to',
        ' * reach it.',
        ' */',
        'export abstract class BasePage {',
        '    protected constructor(',
        '        protected readonly page: Page,',
        '        readonly path: string,',
        '    ) {}',
        '',
        "    /** Navigate to the page's route, resolved against Playwright's baseURL. */",
        '    async open(): Promise<void> {',
        '        await this.page.goto(this.path);',
        '    }',
        '',
        '    /** The first heading on the page — the cheapest sanity assertion. */',
        '    heading(): Locator {',
        "        return this.page.getByRole('heading').first();",
        '    }',
        '',
        '    /** Let in-flight requests settle so assertions do not race a late XHR. */',
        '    async settle(): Promise<void> {',
        "        await this.page.waitForLoadState('networkidle');",
        '    }',
        '}',
        '',
    ].join('\n');
}

function e2eSmokeSpec(): string {
    return [
        "import type { Page } from '@playwright/test';",
        "import { expect, test } from '../fixtures/test';",
        "import { BasePage } from '../pages/base.page';",
        '',
        'const MARKUP =',
        "    '<!doctype html><html lang=\"en\"><head><title>Smoke</title></head>' +",
        "    '<body><main><h1>Test automation suite is running</h1></main></body></html>';",
        '',
        '/** A page object that renders its own page: no server, no BASE_URL. */',
        'class SmokePage extends BasePage {',
        '    constructor(page: Page) {',
        "        super(page, '/');",
        '    }',
        '',
        '    override async open(): Promise<void> {',
        '        await this.page.setContent(MARKUP);',
        '    }',
        '}',
        '',
        '/**',
        ' * Self-contained smoke: it asserts against markup it renders itself, so this',
        ' * file is green before the application exists. Replace it with real journeys',
        ' * once BASE_URL points at a running app.',
        ' */',
        "test('renders a page and finds its heading', async ({ page, consoleErrors }) => {",
        '    await page.setContent(MARKUP);',
        '',
        "    await expect(page).toHaveTitle('Smoke');",
        "    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Test automation suite is running');",
        '    expect(consoleErrors).toEqual([]);',
        '});',
        '',
        "test('the page object base resolves the heading', async ({ page }) => {",
        '    const view = new SmokePage(page);',
        '    await view.open();',
        '',
        "    await expect(view.heading()).toHaveText('Test automation suite is running');",
        "    await expect(page).toHaveTitle('Smoke');",
        '});',
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// API suite (api/)
// ---------------------------------------------------------------------------

function vitestConfig(): string {
    return [
        "import { defineConfig } from 'vitest/config';",
        '',
        '/**',
        ' * API suite only: no browser, no globals, JUnit evidence for CI. The root',
        ' * is this folder, which is why npm run test:api passes --root api.',
        ' */',
        'export default defineConfig({',
        '    test: {',
        "        include: ['specs/**/*.api.test.ts'],",
        "        environment: 'node',",
        '        globals: false,',
        "        reporters: ['default', 'junit'],",
        "        outputFile: { junit: '../reporting/evidence/junit.xml' },",
        '    },',
        '});',
        '',
    ].join('\n');
}

function apiClient(o: ResolvedOptions): string {
    return [
        '/**',
        ' * Minimal fetch-based client for the API under test.',
        ' *',
        ' * No runtime dependency and no retries: a failing call should surface the',
        ' * status and the body, not a retry log. BASE_URL wins over the compiled-in',
        ' * default so one clone can point at staging.',
        ' */',
        '',
        `export const DEFAULT_BASE_URL = ${JSON.stringify(o.baseUrl)};`,
        '',
        '/** One response, already decoded when the server sent JSON. */',
        'export interface ApiResponse<T = unknown> {',
        '    status: number;',
        '    ok: boolean;',
        '    /** Parsed JSON when the content type says JSON, otherwise the raw text. */',
        '    body: T;',
        '    headers: Headers;',
        '}',
        '',
        'export class ApiClient {',
        '    readonly baseUrl: string;',
        '',
        '    constructor(baseUrl: string = process.env.BASE_URL ?? DEFAULT_BASE_URL) {',
        '        this.baseUrl = baseUrl;',
        '    }',
        '',
        '    /** Absolute URL for a path, with exactly one separating slash. */',
        '    url(path: string): string {',
        "        const suffix = path.startsWith('/') ? path : '/' + path;",
        "        return this.baseUrl.replace(/\\/+$/, '') + suffix;",
        '    }',
        '',
        '    get<T = unknown>(path: string): Promise<ApiResponse<T>> {',
        "        return this.request<T>('GET', path);",
        '    }',
        '',
        '    post<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {',
        "        return this.request<T>('POST', path, body);",
        '    }',
        '',
        '    private async request<T>(',
        '        method: string,',
        '        path: string,',
        '        body?: unknown,',
        '    ): Promise<ApiResponse<T>> {',
        '        const response = await fetch(this.url(path), {',
        '            method,',
        "            headers: body === undefined ? undefined : { 'content-type': 'application/json' },",
        '            body: body === undefined ? undefined : JSON.stringify(body),',
        '        });',
        '        const text = await response.text();',
        "        const isJson = (response.headers.get('content-type') ?? '').includes('json');",
        '        const parsed: unknown = isJson && text.length > 0 ? JSON.parse(text) : text;',
        '        return {',
        '            status: response.status,',
        '            ok: response.ok,',
        '            body: parsed as T,',
        '            headers: response.headers,',
        '        };',
        '    }',
        '}',
        '',
    ].join('\n');
}

function apiFixtures(): string {
    return [
        '/**',
        ' * Request fixtures shared by the API specs. Explicit factories beat one bag',
        ' * of magic values: a spec states only the field it cares about.',
        ' */',
        '',
        'export interface NewItemRequest {',
        '    name: string;',
        "    status: 'active' | 'inactive';",
        '}',
        '',
        'export function newItem(overrides: Partial<NewItemRequest> = {}): NewItemRequest {',
        "    return { name: 'Sample item', status: 'active', ...overrides };",
        '}',
        '',
    ].join('\n');
}

function apiSmokeSpec(): string {
    return [
        "import { describe, expect, it } from 'vitest';",
        "import { ApiClient, DEFAULT_BASE_URL } from '../client';",
        '',
        '/**',
        ' * The first two checks are self-contained: they pin the client URL handling',
        ' * and pass before any app exists. The live block is opt-in, so a blank',
        ' * repository is green instead of red against a server that is not running.',
        ' */',
        "describe('api client', () => {",
        "    it('joins the base URL and a path without doubling the slash', () => {",
        "        const client = new ApiClient('http://localhost:3000/');",
        '',
        "        expect(client.url('health')).toBe('http://localhost:3000/health');",
        "        expect(client.url('/health')).toBe('http://localhost:3000/health');",
        '    });',
        '',
        "    it('falls back to BASE_URL, then to the configured default', () => {",
        '        expect(new ApiClient().baseUrl).toBe(process.env.BASE_URL ?? DEFAULT_BASE_URL);',
        '    });',
        '});',
        '',
        "const liveChecks = process.env.LIVE_API === '1';",
        '',
        "describe.skipIf(!liveChecks)('live API (LIVE_API=1)', () => {",
        '    const client = new ApiClient();',
        '',
        "    it('reaches the app under test', async () => {",
        "        const response = await client.get('/');",
        '',
        '        expect(response.status).toBeGreaterThan(0);',
        '        expect(response.status).toBeLessThan(500);',
        '    });',
        '});',
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// performance smoke (perf/)
// ---------------------------------------------------------------------------

function perfSmoke(o: ResolvedOptions): string {
    return [
        "import http from 'k6/http';",
        "import { check, sleep } from 'k6';",
        '',
        '// k6 is not installed by this scaffold — see the README for the install',
        '// link and the run command.',
        `const BASE_URL = __ENV.BASE_URL || ${JSON.stringify(o.baseUrl)};`,
        '',
        'export const options = {',
        '    vus: 1,',
        "    duration: '10s',",
        '    thresholds: {',
        "        http_req_failed: ['rate<0.01'],",
        "        http_req_duration: ['p(95)<500'],",
        '    },',
        '};',
        '',
        'export default function () {',
        "    const response = http.get(BASE_URL + '/');",
        "    check(response, { 'answer below 500': (r) => r.status < 500 });",
        '    sleep(1);',
        '}',
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// test data (testdata/)
// ---------------------------------------------------------------------------

function seedJson(): string {
    return jsonString({
        users: [{ email: 'tester@example.com', role: 'qa' }],
        items: [
            { name: 'Sample item', status: 'active' },
            { name: 'Archived item', status: 'inactive' },
        ],
    });
}

function testdataGenerator(): string {
    return [
        '/**',
        ' * Seed-data generator: prints JSON to stdout, or writes it with --out.',
        ' *',
        ' *   npm run testdata                       # 10 records on stdout',
        ' *   npm run testdata -- --count 50 --out testdata/generated/items.json',
        ' *',
        ' * Kept dependency-free (node:fs + node:crypto) so the suite has no build',
        ' * step of its own.',
        ' */',
        "import { randomUUID } from 'node:crypto';",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        '',
        'export interface GeneratedItem {',
        '    id: string;',
        '    name: string;',
        "    status: 'active' | 'inactive';",
        '    createdAt: string;',
        '}',
        '',
        'export function generate(count: number): GeneratedItem[] {',
        '    return Array.from({ length: count }, (_, index) => ({',
        '        id: randomUUID(),',
        '        name: `Generated item ${index + 1}`,',
        "        status: index % 3 === 0 ? 'inactive' : 'active',",
        "        createdAt: '2024-01-01T00:00:00.000Z',",
        '    }));',
        '}',
        '',
        'function valueAfter(argv: string[], name: string): string | undefined {',
        '    const index = argv.indexOf(name);',
        '    return index === -1 ? undefined : argv[index + 1];',
        '}',
        '',
        'function parseCount(argv: string[]): number {',
        "    const raw = valueAfter(argv, '--count');",
        '    const count = raw === undefined ? NaN : Number(raw);',
        '    return Number.isInteger(count) && count > 0 ? count : 10;',
        '}',
        '',
        'function main(argv: string[]): void {',
        '    const json = JSON.stringify(generate(parseCount(argv)), null, 2);',
        "    const out = valueAfter(argv, '--out');",
        '    if (out === undefined) {',
        "        process.stdout.write(json + '\\n');",
        '        return;',
        '    }',
        '    mkdirSync(dirname(out), { recursive: true });',
        "    writeFileSync(out, json + '\\n', 'utf8');",
        '}',
        '',
        'main(process.argv.slice(2));',
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// reporting (reporting/)
// ---------------------------------------------------------------------------

function htmlReportConfig(o: ResolvedOptions): string {
    if (!o.e2e) {
        return [
            '/**',
            ' * The API suite has no HTML renderer of its own: its evidence is the',
            ' * JUnit XML written to reporting/evidence/junit.xml, which any CI test tab',
            ' * renders. Kept as code so the location is imported, not retyped.',
            ' */',
            "export const evidenceDir = 'reporting/evidence';",
            "export const junitEvidence = 'reporting/evidence/junit.xml';",
            '',
        ].join('\n');
    }
    return [
        '/**',
        ' * Human-facing HTML report for the browser suite. Playwright writes it on',
        ' * npm run test:e2e; npm run report opens the generated folder.',
        ' */',
        "export const htmlReportDir = '../playwright-report';",
        '',
        "export const htmlReport: [string, { outputFolder: string; open: 'never' }] = [",
        "    'html',",
        "    { outputFolder: htmlReportDir, open: 'never' },",
        '];',
        '',
    ].join('\n');
}

function allureReportConfig(): string {
    return [
        '/**',
        ' * Raw Allure results land in allure-results/ at the project root;',
        ' * npm run report renders them into reporting/allure/report.',
        ' *',
        ' * Data only on purpose: this module imports no runner, so it typechecks',
        ' * whether or not the browser suite is enabled.',
        ' */',
        "export const allureResultsDir = '../allure-results';",
        '',
        'export const allureReport:',
        '    [string, { resultsDir: string; detail: boolean; screenshots: boolean }] = [',
        "    'allure-playwright',",
        '    { resultsDir: allureResultsDir, detail: true, screenshots: true },',
        '];',
        '',
    ].join('\n');
}

function evidenceReadme(o: ResolvedOptions): string {
    const lines = [
        '# Evidence',
        '',
        'Manual evidence (screenshots, logs, signed-off checklists) goes here, next',
        'to the machine evidence the suites produce.',
    ];
    if (o.api) {
        lines.push(
            '',
            'The API suite writes `junit.xml` into this folder on every run; it is',
            'safe to delete and regenerate.',
        );
    }
    if (o.e2e) {
        lines.push(
            '',
            'Traces, screenshots and videos of the browser suite land in',
            '`test-results/` instead, because Playwright manages that folder.',
        );
    }
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CI (ci/)
// ---------------------------------------------------------------------------

function githubWorkflow(o: ResolvedOptions): string {
    const lines = [
        'name: test',
        '',
        'on:',
        '  push:',
        '    branches: [main]',
        '  pull_request:',
        '',
        'jobs:',
        '  suite:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '20'",
        '      - run: npm install',
    ];
    if (o.e2e) {
        lines.push('      - run: npx playwright install --with-deps');
    }
    lines.push('      - run: npm run typecheck');
    if (o.api) {
        lines.push('      - run: npm run test:api');
    }
    if (o.e2e) {
        lines.push('      - run: npm run test:e2e');
    }
    const paths = artifactPaths(o);
    if (paths.length > 0) {
        lines.push(
            '      - uses: actions/upload-artifact@v4',
            '        if: always()',
            '        with:',
            '          name: test-reports',
            '          if-no-files-found: ignore',
            '          path: |',
            ...paths.map((path) => `            ${path}`),
        );
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function azurePipeline(o: ResolvedOptions): string {
    const lines = [
        'trigger:',
        '  - main',
        '',
        'pr:',
        '  - main',
        '',
        'pool:',
        '  vmImage: ubuntu-latest',
        '',
        'steps:',
        '  - task: NodeTool@0',
        '    displayName: Use Node 20',
        '    inputs:',
        "      versionSpec: '20.x'",
        '  - script: npm install',
        '    displayName: Install dependencies',
    ];
    if (o.e2e) {
        lines.push(
            '  - script: npx playwright install --with-deps',
            '    displayName: Install Playwright browsers',
        );
    }
    lines.push('  - script: npm run typecheck', '    displayName: Typecheck');
    if (o.api) {
        lines.push('  - script: npm run test:api', '    displayName: API suite');
    }
    if (o.e2e) {
        lines.push('  - script: npm run test:e2e', '    displayName: Browser suite');
    }
    for (const path of artifactPaths(o)) {
        lines.push(
            '  - task: PublishPipelineArtifact@1',
            '    condition: always()',
            `    displayName: Publish ${path}`,
            '    inputs:',
            `      targetPath: $(Build.SourcesDirectory)/${path}`,
            `      artifact: ${path}`,
        );
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

/** Only folders the enabled suites actually create. */
function artifactPaths(o: ResolvedOptions): string[] {
    const paths: string[] = [];
    if (o.e2e) {
        paths.push('test-results');
    }
    if (o.e2e && (o.reporting === 'html' || o.reporting === 'both')) {
        paths.push('playwright-report');
    }
    if (o.e2e && (o.reporting === 'allure' || o.reporting === 'both')) {
        paths.push('allure-results');
    }
    if (o.api) {
        paths.push('reporting/evidence');
    }
    return paths;
}

// ---------------------------------------------------------------------------
// README — part of the deliverable, honest about what is switched off
// ---------------------------------------------------------------------------

function readme(o: ResolvedOptions): string {
    const lines: string[] = ['# Test automation suite', ''];

    const suites: string[] = [];
    if (o.e2e) {
        suites.push('Playwright');
    }
    if (o.api) {
        suites.push('Vitest');
    }
    if (o.perf) {
        suites.push('k6');
    }

    if (suites.length > 0) {
        lines.push(
            `Suites: ${suites.join(', ')}. Every one runs from the repository root and reads \`BASE_URL\`.`,
            '',
        );
    } else {
        lines.push(
            'No suite is enabled in this repository: it carries the shared scaffolding',
            '(test data, TypeScript config, environment template) only.',
            '',
        );
    }

    lines.push('## Contents', '');
    lines.push('| Path | What it is |', '| --- | --- |');
    if (o.e2e) {
        lines.push('| `e2e/` | Playwright config, specs, fixtures and page objects |');
    }
    if (o.api) {
        lines.push('| `api/` | Vitest config, fetch client, specs and request fixtures |');
    }
    if (o.perf) {
        lines.push('| `perf/` | One k6 smoke script |');
    }
    lines.push(
        '| `testdata/` | Seed data and the generator that extends it |',
    );
    if (o.e2e || o.api) {
        lines.push('| `reporting/` | Report settings and the evidence folder |');
    }
    lines.push('| `.env.example` | The environment variables the suites read |', '');

    lines.push('## Quickstart (five minutes)', '');
    lines.push('```bash', 'npm install');
    if (o.e2e) {
        lines.push('npx playwright install --with-deps   # browsers for the browser suite');
    }
    lines.push(
        `export BASE_URL=${o.baseUrl}   # the app under test, when there is one`,
        'npm test',
        '```',
        '',
        'Nothing loads `.env` automatically: copy the values you need into your shell',
        'or into the CI job.',
        '',
    );

    const runOrder: string[] = ['typecheck'];
    if (o.api) {
        runOrder.push('the API suite');
    }
    if (o.e2e) {
        runOrder.push('the browser suite');
    }
    if (o.e2e || o.api) {
        lines.push(`\`npm test\` runs ${runOrder.join(', then ')}.`);
        if (o.sample) {
            lines.push(
                '',
                'With the sample specs in place the run is green before the app under test',
                'exists: the browser sample renders its own markup, and the API checks that',
                'touch a live server are skipped unless `LIVE_API=1`.',
            );
        } else {
            lines.push(
                '',
                'The sample specs are switched off, so each runner exits green on an empty',
                'suite (`--passWithNoTests`). Add specs before trusting that green.',
            );
        }
        lines.push('');
    } else {
        lines.push('`npm test` typechecks the scaffolding; no suite runs.');
        lines.push('');
    }

    if (o.e2e || o.api || o.perf) {
        lines.push('## Running one suite', '');
        if (o.e2e) {
            lines.push(
                '- `npm run test:e2e` — Playwright drives Chromium and treats `BASE_URL` as',
                '  its `baseURL`.',
            );
        }
        if (o.api) {
            lines.push(
                '- `npm run test:api` — Vitest over the fetch client in `api/client.ts`.',
            );
        }
        if (o.perf) {
            lines.push(
                '- `npm run test:perf` — needs k6 on `PATH` (see below); the script is',
                '  `perf/smoke.js`.',
            );
        }
        lines.push('');
    }

    if (o.e2e || o.api) {
        lines.push('## Where reports and evidence land', '');
        if (o.e2e) {
            lines.push(
                '- `test-results/` — traces, screenshots and videos of failing or retried',
                '  browser tests.',
            );
        }
        if (o.e2e && (o.reporting === 'html' || o.reporting === 'both')) {
            lines.push(
                '- `playwright-report/` — the HTML report; `npm run report` opens it.',
            );
        }
        if (o.e2e && (o.reporting === 'allure' || o.reporting === 'both')) {
            lines.push(
                '- `allure-results/` — raw Allure results; `npm run report` renders them',
                '  into `reporting/allure/report` and opens the site.',
            );
        }
        if (o.api) {
            lines.push(
                '- `reporting/evidence/junit.xml` — one JUnit entry per API test, readable by',
                '  the CI test tab.',
            );
        }
        lines.push('');
    }

    if (o.e2e) {
        lines.push(
            '## Reading a failing browser test',
            '',
            '1. Run `npm run test:e2e` and note the failing test name in the output.',
            '2. Open `test-results/` — Playwright writes a trace on the first retry, plus a',
            '   screenshot and a video for every failure.',
            '3. Open a trace with `npx playwright show-trace test-results/<test>/trace.zip`,',
            '   or browse every run with `npx playwright show-report`.',
            '4. In the trace viewer step through each action: the DOM snapshot before and',
            '   after it, the network log and the console explain almost every failure.',
            '',
        );
    }

    if (o.perf) {
        lines.push(
            '## Performance smoke',
            '',
            'k6 is a single binary and is deliberately not installed by this repository;',
            'install it from https://grafana.com/docs/k6/latest/set-up/install-k6/ and run:',
            '',
            '```bash',
            'k6 run perf/smoke.js',
            'k6 run -e BASE_URL=https://staging.example.com perf/smoke.js',
            '```',
            '',
        );
    }

    lines.push('## Adding a spec', '');
    if (o.e2e) {
        lines.push(
            '- Browser: add `e2e/specs/<name>.spec.ts`, import `{ test, expect }` from',
            '  `e2e/fixtures/test.ts`, and extend `BasePage` for the page you drive.',
        );
    }
    if (o.api) {
        lines.push(
            '- API: add `api/specs/<name>.api.test.ts`, build requests with `ApiClient`, and',
            '  keep payloads in `api/fixtures/requests.ts`.',
        );
    }
    if (!o.e2e && !o.api) {
        lines.push('- Enable a suite in the template options before adding one.');
    }
    lines.push(
        '- Test data: extend `testdata/seed.json` or regenerate with',
        '  `npm run testdata -- --count 50 --out testdata/generated/items.json`.',
        '',
    );

    if (o.ci !== 'none') {
        const workflow = o.ci === 'github' ? '.github/workflows/test.yml' : 'azure-pipelines.yml';
        lines.push(
            '## CI',
            '',
            `\`${workflow}\` installs dependencies, installs the Playwright browsers when the`,
            'browser suite is enabled, runs whichever suites exist and uploads the reports',
            'as artifacts. It does not install k6.',
            '',
        );
    }

    lines.push(
        '## Environment variables',
        '',
        '| Variable | Used by | Meaning |',
        '| --- | --- | --- |',
        `| \`BASE_URL\` | every suite | Application under test (default \`${o.baseUrl}\`) |`,
    );
    if (o.e2e || o.api) {
        lines.push(
            '| `LIVE_API` | API suite | `1` enables the checks that hit a running app |',
        );
    }
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// warnings and next steps
// ---------------------------------------------------------------------------

function warningsFor(o: ResolvedOptions, docsCount: number): string[] {
    const warnings: string[] = [];
    if (o.e2e) {
        warnings.push(
            'Playwright browsers are not downloaded by the scaffold: run "npx playwright install --with-deps" before the first browser run. Behind a corporate proxy that download can fail — the project still works once it succeeds.',
        );
    }
    if (o.perf) {
        warnings.push(
            'k6 is not installed by the scaffold. Install it from https://grafana.com/docs/k6/latest/set-up/install-k6/ and run "npm run test:perf".',
        );
    }
    if (o.qaDocs && docsCount === 0) {
        warnings.push(
            'qaDocs is on but no tester documents were supplied, so docs/ was left out. Pass the testerDocs() output through hint.qaDocsFiles.',
        );
    }
    return warnings;
}

function postCreateStepsFor(o: ResolvedOptions): PostCreateStep[] {
    const steps: PostCreateStep[] = [];
    if (o.e2e) {
        steps.push({
            label: 'Install the Playwright browsers',
            command: 'npx playwright install --with-deps',
            detail:
                'Downloads the Chromium build the browser suite drives. Skippable when the browsers are already cached; behind a proxy it can fail without blocking project creation.',
        });
    }
    return steps;
}

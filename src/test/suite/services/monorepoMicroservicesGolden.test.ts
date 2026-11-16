import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectCreationService } from '../../../webview/ProjectCreationService';
import { PROJECT_TEMPLATES, ProjectCreationRequest } from '../../../webview-ui/src/components/ProjectCreationWizard/types';
import { cleanTempDir } from '../utils/cleanTempDir';
import { makeScratchDir } from '../utils/scratchDir';

/**
 * Golden-tree regression for the `monorepo-microservices` template.
 *
 * The fixtures under services/fixtures/ were captured from the shipped
 * generator BEFORE it was decomposed into `monorepoRoot` / `serviceBody` /
 * `compose`. This suite is the safety net for that refactor: the same request
 * must keep producing a byte-identical tree.
 *
 * Two trees, because the refactor moved three gates (docker, compose, CI) and a
 * single default-options tree would leave every branch of them untested:
 *
 *   - `monorepo-microservices.tree.json`         — catalogue defaults.
 *   - `monorepo-microservices.options.tree.json` — pnpm + kafka + k8s without
 *     docker, no gateway, no shared package, no CI, no tooling. It is the only
 *     place the deprecated template's `docker:false` carve-out is pinned.
 *
 * It is deliberately a plain tree comparison — no file counts, no spot checks —
 * because the whole point is "nothing moved", down to the trailing newline.
 * Git is off (gitInit:false): the template never reads HEAD, and a repo would
 * add .git churn to the comparison.
 */

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, '.vscodeignore'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('could not locate the repository root from ' + __dirname);
}

interface GoldenTree {
  templateId: string;
  request: { projectName: string; projectDescription: string; projectVersion: string };
  templateOptions: Record<string, unknown>;
  /** Only the option-heavy fixture records them. */
  warnings?: string[];
  files: Record<string, string>;
}

/** Every file under `dir`, keyed by forward-slashed relative path. */
function readTree(dir: string, base: string = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readTree(full, base, out);
    } else {
      out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  }
  return out;
}

suite('Monorepo microservices — golden tree', () => {
  const service = new ProjectCreationService();
  const fixturesDir = path.join(
    findRepoRoot(),
    'src',
    'test',
    'suite',
    'services',
    'fixtures'
  );
  const goldenTrees: { name: string; tree: GoldenTree }[] = fs
    .readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.tree.json'))
    .sort()
    .map((name) => ({ name, tree: JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as GoldenTree }));

  let targetPath: string | undefined;

  teardown(() => {
    if (targetPath) {
      cleanTempDir(targetPath);
      targetPath = undefined;
    }
  });

  test('the fixtures cover both the defaults and the option-heavy request', () => {
    assert.deepStrictEqual(
      goldenTrees.map((golden) => golden.name),
      ['monorepo-microservices.options.tree.json', 'monorepo-microservices.tree.json'],
      'a fixture went missing — the refactor would lose its safety net'
    );
  });

  for (const golden of goldenTrees) {
    test(`${golden.name}: options are real catalogue options`, () => {
      const template = PROJECT_TEMPLATES.find((t) => t.id === golden.tree.templateId);
      assert.ok(template, `template ${golden.tree.templateId} is missing from the catalogue`);
      const known = new Set(template!.options.map((option) => option.id));
      for (const id of Object.keys(golden.tree.templateOptions)) {
        assert.ok(known.has(id), `fixture uses unknown option "${id}"`);
      }
    });
  }

  test('the defaults fixture still describes the catalogue defaults', () => {
    const defaults = goldenTrees.find((golden) => golden.name === 'monorepo-microservices.tree.json')!;
    const template = PROJECT_TEMPLATES.find((t) => t.id === defaults.tree.templateId)!;
    const fromCatalogue: Record<string, unknown> = {};
    for (const option of template.options) {
      fromCatalogue[option.id] = option.default;
    }
    // If a default changes, the fixture must be re-captured deliberately — a
    // silent drift here would make the comparisons below meaningless.
    assert.deepStrictEqual(defaults.tree.templateOptions, fromCatalogue);
  });

  for (const golden of goldenTrees) {
    test(`${golden.name}: scaffolds a byte-identical tree`, async () => {
      targetPath = makeScratchDir('ado-golden-microservices-');
      const request: ProjectCreationRequest = {
        templateId: golden.tree.templateId,
        projectName: golden.tree.request.projectName,
        projectDescription: golden.tree.request.projectDescription,
        projectVersion: golden.tree.request.projectVersion,
        templateOptions: { ...golden.tree.templateOptions },
        adoIntegration: false,
        adoWorkItemType: 'Task',
        adoAreaPath: '',
        gitInit: false,
        gitInitialCommit: false,
        gitBranchName: 'main',
        targetPath,
      };
      const result = await service.createProject(request);
      assert.strictEqual(result.success, true, result.error);

      const actual = readTree(result.path);
      const expected = golden.tree.files;

      // Compare file sets first so a missing/extra file names itself.
      assert.deepStrictEqual(
        Object.keys(actual).sort(),
        Object.keys(expected).sort(),
        'file set drifted from the fixture'
      );
      for (const file of Object.keys(expected)) {
        assert.strictEqual(actual[file], expected[file], `${file} is not byte-identical to the fixture`);
        assert.ok(!actual[file].includes('\r'), `${file} must be written with LF line endings`);
      }

      if (golden.tree.warnings) {
        assert.deepStrictEqual(result.warnings, golden.tree.warnings, 'warnings drifted from the fixture');
      }
    });
  }
});

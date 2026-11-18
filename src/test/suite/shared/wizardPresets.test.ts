import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectCreationService } from '../../../webview/ProjectCreationService';
import {
  DEFAULT_PRESET_ID,
  MONOREPO_TEMPLATE_ID,
  WIZARD_PRESETS,
  isWizardPresetId,
  resolvePreset,
  wizardPreset,
} from '../../../shared/wizardPresets';
import { MONOREPO_STACKS } from '../../../shared/monorepoStacks';
import { CLAUSE_IDS } from '../../../shared/standardsArtifacts';
import { PROJECT_TEMPLATES } from '../../../webview-ui/src/components/ProjectCreationWizard/types';

/**
 * The preset table is the thing that makes the standard the default, so these
 * tests are about *validity* rather than about the values themselves: a preset
 * that names an option the wizard does not render, or a value its select does not
 * offer, silently produces a tree that does not match what the user picked.
 */
function listFiles(root: string, base = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, base, out);
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

suite('wizardPresets', () => {
  const catalogue = (id: string) => {
    const template = PROJECT_TEMPLATES.find((entry) => entry.id === id);
    assert.ok(template, `catalogue template ${id} is missing`);
    return template!;
  };

  test('every preset targets a template that exists', () => {
    for (const preset of WIZARD_PRESETS) {
      const template = catalogue(preset.templateId);
      assert.strictEqual(preset.templateId, MONOREPO_TEMPLATE_ID, `${preset.id} targets ${preset.templateId}`);
      assert.ok(template.options && template.options.length > 0, `${preset.templateId} declares no options`);
    }
  });

  test('every preset option id is declared by its template', () => {
    const declared = new Set(catalogue(MONOREPO_TEMPLATE_ID).options!.map((option) => option.id));
    for (const preset of WIZARD_PRESETS) {
      for (const id of Object.keys(preset.options)) {
        assert.ok(declared.has(id), `${preset.id} sets option "${id}" which the template does not render`);
      }
    }
  });

  test('every preset option value is one the template accepts', () => {
    const options = new Map(catalogue(MONOREPO_TEMPLATE_ID).options!.map((option) => [option.id, option]));
    for (const preset of WIZARD_PRESETS) {
      for (const [id, value] of Object.entries(preset.options)) {
        const declared = options.get(id)!;
        if (declared.type === 'boolean') {
          assert.strictEqual(typeof value, 'boolean', `${preset.id}.${id} should be a boolean`);
        } else if (declared.options && declared.options.length > 0) {
          assert.ok(
            declared.options.includes(String(value)),
            `${preset.id}.${id} = "${String(value)}" is not one of ${declared.options.join(', ')}`
          );
        }
      }
    }
  });

  test('the default preset is the node-ts one, and every stack has a preset', () => {
    assert.ok(isWizardPresetId(DEFAULT_PRESET_ID));
    assert.strictEqual(wizardPreset(DEFAULT_PRESET_ID).options.stack, 'node-ts');
    for (const stack of MONOREPO_STACKS) {
      const found = WIZARD_PRESETS.filter((preset) => preset.options.stack === stack.id);
      assert.strictEqual(found.length, 1, `stack ${stack.id} should have exactly one preset`);
    }
    assert.strictEqual(WIZARD_PRESETS.length, MONOREPO_STACKS.length);
  });

  test('the preset turns on the artifacts the standard requires', () => {
    for (const preset of WIZARD_PRESETS) {
      assert.strictEqual(preset.options.sharedPackage, true, `${preset.id}: shared package off`);
      assert.strictEqual(preset.options.docker, true, `${preset.id}: containers off`);
      assert.strictEqual(preset.options.k8s, true, `${preset.id}: manifests off`);
      assert.strictEqual(preset.options.ci, true, `${preset.id}: CI gates off`);
      assert.notStrictEqual(preset.options.messageBroker, 'none', `${preset.id}: no broker`);
      assert.ok(
        String(preset.options.services).split(',').includes('gateway'),
        `${preset.id}: no gateway, so /api/v1 has no single entry point`
      );
    }
  });

  test('a preset only claims clauses the scaffold can actually satisfy', () => {
    const all = Object.values(CLAUSE_IDS) as string[];
    for (const preset of WIZARD_PRESETS) {
      for (const id of preset.satisfies) {
        assert.ok(all.includes(id), `${preset.id} claims an unknown clause ${id}`);
      }
      // CON-05 is claimed by every stack: node ships `packages/shared/src/auth.ts`,
      // the other three ship a stdlib edge guard (`securityEdgeGuards.ts`). The
      // guards are asserted end to end in `securityEdgeGuards.test.ts`.
      assert.ok(
        preset.satisfies.includes(CLAUSE_IDS.security),
        `${preset.id}: CON-05 is scaffolded for every stack and must be claimed`
      );
      const expectsResilience = preset.options.stack === 'node-ts';
      assert.strictEqual(
        preset.satisfies.includes(CLAUSE_IDS.resilience),
        expectsResilience,
        `${preset.id}: CON-06 must be claimed exactly when the shared kit ships`
      );
    }
  });

  test('resolvePreset returns the template and options the scaffolders take', () => {
    const resolved = resolvePreset(DEFAULT_PRESET_ID);
    assert.strictEqual(resolved.templateId, MONOREPO_TEMPLATE_ID);
    assert.strictEqual(resolved.options.stack, 'node-ts');
    assert.strictEqual(resolved.preset.id, DEFAULT_PRESET_ID);
  });

  test('resolvePreset applies a valid override', () => {
    const resolved = resolvePreset(DEFAULT_PRESET_ID, { stack: 'python' });
    assert.strictEqual(resolved.options.stack, 'python');
    assert.notStrictEqual(resolved.options.services, undefined, 'overrides must not drop the rest');
  });

  test('resolvePreset refuses a typo instead of ignoring it', () => {
    assert.throws(() => wizardPreset('zen-nope'), /Unknown wizard preset/);
    assert.throws(
      () => resolvePreset(DEFAULT_PRESET_ID, { sharedPackages: true } as never),
      /Unknown preset option/
    );
    assert.throws(() => resolvePreset(DEFAULT_PRESET_ID, { stack: 'cobol' }), /Unknown monorepo stack/);
  });

  test('choosing the preset scaffolds every artifact the standard needs', async () => {
    const resolved = resolvePreset(DEFAULT_PRESET_ID);
    const targetPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-preset-'));
    try {
      const result = await new ProjectCreationService().createProject({
        templateId: resolved.templateId,
        projectName: 'preset-app',
        projectDescription: 'Preset acceptance',
        projectVersion: '0.1.0',
        templateOptions: resolved.options as Record<string, string | boolean>,
        adoIntegration: false,
        adoWorkItemType: 'Task',
        adoAreaPath: '',
        gitInit: false,
        gitInitialCommit: false,
        gitBranchName: 'main',
        targetPath,
      });
      assert.ok(result.success, result.error);

      const files = listFiles(result.path);
      // The preset's promise, item by item: hardened containers (CON-01),
      // contracts (CON-02), observability + lifecycle (CON-03/04), the resilience
      // kit (CON-06), all seven CI gates (§4.3) and the standards AGENTS.md.
      for (const expected of [
        'AGENTS.md',
        'contracts/openapi/users.v1.yaml',
        'contracts/events/envelope.v1.json',
        'packages/shared/src/health.ts',
        'packages/shared/src/logger.ts',
        'packages/shared/src/metrics.ts',
        'packages/shared/src/correlation.ts',
        'packages/shared/src/lifecycle.ts',
        'packages/shared/src/resilience.ts',
        '.github/workflows/ci.yml',
        'docker-compose.yml',
        'docker-compose.databases.yml',
        'services/users/Dockerfile',
      ]) {
        assert.ok(files.includes(expected), `the preset should scaffold ${expected}`);
      }

      // …and the standards block names the clauses those files satisfy.
      const agents = fs.readFileSync(path.join(result.path, 'AGENTS.md'), 'utf8');
      for (const clause of resolved.preset.satisfies) {
        assert.ok(agents.includes(`\`${clause}\``), `AGENTS.md is missing ${clause}`);
      }
      assert.ok(
        files.some((file) => file.startsWith('deploy/k8s/')),
        'the preset turns k8s on, so manifests must be scaffolded'
      );
    } finally {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  });
});

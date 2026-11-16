import * as assert from 'assert';
import {
  ARCHITECTURE_CAPABILITIES,
  ARCHITECTURE_OPTION_ID,
  ARCHITECTURE_STYLES,
  architectureCapability,
  architectureOption,
  isArchitectureStyle,
  resolveArchitecture,
  stackForTemplate,
  supportsArchitecture,
  type ArchitectureStyle,
} from '../../../shared/architectureStyles';
import { resolveContainerization } from '../../../shared/scaffoldContext';
import { PROJECT_TEMPLATES } from '../../../webview-ui/src/components/ProjectCreationWizard/types';

/**
 * Guards the shared architecture contract (docs/project-scaffolding.md §4.1,
 * §4.2, §8). The catalogue-side drift guard — `supportsArchitecture(id)` ⇔ the
 * template carries `architectureOption()` — cannot exist yet: the wizard only
 * gains the option in phase 6, and until then the table's job is to be ready,
 * not to be wired. This suite pins the table, the resolution rule and the
 * containerization matrix so that wiring cannot quietly change them.
 */

const SUPPORTED: string[] = ['node-ts', 'node-js', 'python', 'php-laravel', 'dotnet-webapi'];
const EXCLUDED: string[] = [
  'react-ts',
  'nextjs',
  'react-native',
  'flutter',
  'dotnet-maui',
  'dotnet-console',
  'empty',
  'doc-ba',
  'doc-writer',
  'doc-tester',
];

suite('architectureStyles', () => {
  test('only server-capable templates support an architecture choice', () => {
    for (const id of SUPPORTED) {
      assert.strictEqual(supportsArchitecture(id), true, `${id} should support an architecture`);
    }
    for (const id of EXCLUDED) {
      assert.strictEqual(supportsArchitecture(id), false, `${id} must stay single-layout`);
      assert.strictEqual(architectureCapability(id), undefined, `${id} has no capability entry`);
      assert.strictEqual(stackForTemplate(id), undefined, `${id} has no stack`);
    }
  });

  test('the capability table names only real catalogue templates', () => {
    const catalogue = new Set(PROJECT_TEMPLATES.map((template) => template.id));
    for (const capability of ARCHITECTURE_CAPABILITIES) {
      assert.ok(catalogue.has(capability.templateId), `${capability.templateId} is not in PROJECT_TEMPLATES`);
    }
  });

  test('every supported template offers all three styles to its stack', () => {
    for (const capability of ARCHITECTURE_CAPABILITIES) {
      for (const style of ARCHITECTURE_STYLES) {
        assert.ok(
          capability.architectures.includes(style.id),
          `${capability.templateId} is missing the ${style.id} branch`
        );
      }
    }
  });

  test('the three .NET templates collapse onto one stack', () => {
    // Only dotnet-webapi is in the allow-list; the other two .NET templates are
    // single-layout and must not acquire a stack through the mapping.
    assert.strictEqual(stackForTemplate('dotnet-webapi'), 'dotnet');
    assert.strictEqual(stackForTemplate('dotnet-console'), undefined);
    assert.strictEqual(stackForTemplate('dotnet-maui'), undefined);
  });

  test('architectureOption is one select fed by ARCHITECTURE_STYLES', () => {
    const option = architectureOption();
    assert.strictEqual(option.id, ARCHITECTURE_OPTION_ID);
    assert.strictEqual(option.type, 'select');
    assert.strictEqual(option.default, 'layered');
    assert.deepStrictEqual(option.options, ARCHITECTURE_STYLES.map((style) => style.id));
    assert.strictEqual(architectureOption('microservices').default, 'microservices');
  });

  test('isArchitectureStyle rejects anything off the list', () => {
    for (const style of ARCHITECTURE_STYLES) {
      assert.strictEqual(isArchitectureStyle(style.id), true);
    }
    for (const value of [undefined, null, '', 'monolith', 'Layered', 0, {}]) {
      assert.strictEqual(isArchitectureStyle(value), false, `${String(value)} is not a style`);
    }
  });

  test('resolveArchitecture defaults to layered and ignores garbage', () => {
    assert.strictEqual(resolveArchitecture(undefined), 'layered');
    assert.strictEqual(resolveArchitecture({}), 'layered');
    assert.strictEqual(resolveArchitecture({ [ARCHITECTURE_OPTION_ID]: 'microservices' }), 'microservices');
    assert.strictEqual(resolveArchitecture({ [ARCHITECTURE_OPTION_ID]: 'modular-monolith' }), 'modular-monolith');
    // A stale saved value or a hand-edited payload must never break the wizard.
    for (const bad of ['monolith', 42, null, true]) {
      assert.strictEqual(resolveArchitecture({ [ARCHITECTURE_OPTION_ID]: bad }), 'layered');
    }
  });
});

suite('resolveContainerization', () => {
  const styles: ArchitectureStyle[] = ['layered', 'modular-monolith', 'microservices'];

  test('compose is never on without docker', () => {
    for (const architecture of styles) {
      for (const docker of [undefined, true, false]) {
        for (const database of [undefined, true]) {
          for (const broker of [undefined, true]) {
            const { policy } = resolveContainerization({ architecture, docker, database, broker });
            if (policy.compose) {
              assert.strictEqual(
                policy.dockerEnabled,
                true,
                `${architecture} asked for compose without docker (${JSON.stringify({ docker, database, broker })})`
              );
            }
          }
        }
      }
    }
  });

  test('layered is exactly today: the option decides, never compose', () => {
    assert.deepStrictEqual(resolveContainerization({ architecture: 'layered' }).policy, {
      docker: 'optional',
      dockerEnabled: false,
      compose: false,
    });
    assert.deepStrictEqual(resolveContainerization({ architecture: 'layered', docker: true }).policy, {
      docker: 'optional',
      dockerEnabled: true,
      compose: false,
    });
    assert.deepStrictEqual(resolveContainerization({ architecture: 'layered', docker: false }).policy, {
      docker: 'optional',
      dockerEnabled: false,
      compose: false,
    });
    // A declared DB/broker cannot force containerization on a plain monolith.
    const forced = resolveContainerization({ architecture: 'layered', database: true, broker: true });
    assert.strictEqual(forced.policy.dockerEnabled, false);
    assert.strictEqual(forced.policy.compose, false);
    assert.deepStrictEqual(forced.warnings, []);
  });

  test('modular monolith: docker on by default, opt-out allowed, compose only with a DB or broker', () => {
    const bare = resolveContainerization({ architecture: 'modular-monolith' });
    assert.strictEqual(bare.policy.docker, 'optional');
    assert.strictEqual(bare.policy.dockerEnabled, true, 'docker defaults to on');
    assert.strictEqual(bare.policy.compose, false, 'one deployable runs bare');

    assert.strictEqual(
      resolveContainerization({ architecture: 'modular-monolith', docker: false }).policy.dockerEnabled,
      false,
      'opting out is allowed'
    );

    for (const declared of [{ database: true }, { broker: true }]) {
      const forced = resolveContainerization({ architecture: 'modular-monolith', ...declared });
      assert.strictEqual(forced.policy.compose, true, 'a DB or broker forces compose');
      assert.strictEqual(forced.policy.dockerEnabled, true);
      assert.deepStrictEqual(forced.warnings, []);
    }

    // Opting out of Docker while forcing Compose is incoherent: the compose
    // decision wins and the conflicting answer is reported, never fatal.
    const conflicting = resolveContainerization({ architecture: 'modular-monolith', docker: false, database: true });
    assert.strictEqual(conflicting.policy.compose, true);
    assert.strictEqual(conflicting.policy.docker, 'required');
    assert.strictEqual(conflicting.policy.dockerEnabled, true);
    assert.strictEqual(conflicting.warnings.length, 1);
    assert.match(conflicting.warnings[0], /docker/i);
  });

  test('microservices: docker and compose are required, docker:false is dropped with a warning', () => {
    const plain = resolveContainerization({ architecture: 'microservices' });
    assert.deepStrictEqual(plain.policy, { docker: 'required', dockerEnabled: true, compose: true });
    assert.deepStrictEqual(plain.warnings, []);

    const dropped = resolveContainerization({ architecture: 'microservices', docker: false });
    assert.deepStrictEqual(dropped.policy, { docker: 'required', dockerEnabled: true, compose: true });
    assert.strictEqual(dropped.warnings.length, 1, 'the dropped answer must be visible');
    assert.match(dropped.warnings[0], /docker/i);

    // docker:true is the agreement case, not a warning.
    assert.deepStrictEqual(resolveContainerization({ architecture: 'microservices', docker: true }).warnings, []);
  });

  test('the deprecated template keeps its own docker flag authoritative', () => {
    // `monorepo-microservices` still ships a docker option; forcing it on would
    // change trees that already exist, so honourDockerOption wins for one release.
    const off = resolveContainerization({ architecture: 'microservices', docker: false, honourDockerOption: true });
    assert.deepStrictEqual(off.policy, { docker: 'optional', dockerEnabled: false, compose: false });
    assert.deepStrictEqual(off.warnings, [], 'an honoured flag is not a conflict');

    const on = resolveContainerization({ architecture: 'microservices', docker: true, honourDockerOption: true });
    assert.deepStrictEqual(on.policy, { docker: 'optional', dockerEnabled: true, compose: true });
  });
});

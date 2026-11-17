import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { planContainerFiles, supportsContainerization } from '../../../shared/containerization';
import { BASE_IMAGES, HEALTHCHECK_PATH, RuntimeFamily, hardeningLines } from '../../../shared/containerHardening';
import { MONOREPO_STACKS, MonorepoTreePlan, planMonorepoTree } from '../../../shared/monorepoStacks';
import { PROJECT_TEMPLATES } from '../../../webview-ui/src/components/ProjectCreationWizard/types';

/**
 * The ZEN handbook's CON‑01 clause — multi-stage build, non-root `USER`,
 * `HEALTHCHECK`, deterministic base-image pin — applied to every container this
 * wizard can emit.
 *
 * The value-level assertions (pins, hardening lines) live here once; the
 * generator tests assert the *wiring*, so a new stack cannot ship a container
 * that skips the clause.
 */

const PLAN: MonorepoTreePlan = {
  projectName: 'demo-app',
  description: 'Demo services',
  version: '0.1.0',
  services: ['orders', 'billing'],
  gateway: 'gateway',
  broker: 'rabbitmq',
  sharedPackage: true,
  containerization: true,
};

/** `major.minor.patch`, optionally with a distro suffix — `node:20-alpine` is not a pin. */
const FULL_PATCH_TAG = /:\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;

/** A static-file container serves the site root; a service serves its health route. */
function probePathFor(body: string): string {
  return body.includes(BASE_IMAGES.nginxUnprivileged) ? '/' : HEALTHCHECK_PATH;
}

/** The nginx base image already carries its own CMD; every other runtime must declare one. */
function declaresStartCommand(body: string): boolean {
  return /^(CMD|ENTRYPOINT) /m.test(body) || body.includes(BASE_IMAGES.nginxUnprivileged);
}

/** Families whose container serves no HTTP endpoint, so there is nothing to probe. */
const UNPROBEABLE: readonly RuntimeFamily[] = ['dotnet-console'];

const FAMILIES: readonly RuntimeFamily[] = [
  'node-alpine',
  'python-debian',
  'php-debian',
  'dotnet-web',
  'dotnet-console',
  'nginx-static',
];

function dockerfiles(files: Record<string, string>): Array<[string, string]> {
  return Object.entries(files).filter(([name]) => name.endsWith('Dockerfile'));
}

function assertHardened(label: string, name: string, body: string): void {
  assert.ok(/^USER \S+$/m.test(body), `${label}: ${name} must declare a non-root USER`);
  assert.ok(body.includes('HEALTHCHECK '), `${label}: ${name} must declare a HEALTHCHECK`);
  assert.ok(body.includes(probePathFor(body)), `${label}: ${name} must probe ${probePathFor(body)}`);
  assert.ok(declaresStartCommand(body), `${label}: ${name} must say how to start`);
  assert.ok(!body.includes(':latest'), `${label}: ${name} must not pull :latest`);
  assert.ok((body.match(/^FROM .* AS /gm) || []).length >= 2, `${label}: ${name} must be multi-stage`);
}

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, '.vscodeignore'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('could not locate the repository root from ' + __dirname);
}

suite('Container hardening — base-image pins', () => {
  test('every base image pins a full patch tag', () => {
    for (const [key, image] of Object.entries(BASE_IMAGES)) {
      assert.ok(
        FULL_PATCH_TAG.test(image),
        `${key}: "${image}" must pin major.minor.patch — a minor tag silently moves on the next patch release`
      );
      assert.ok(!image.includes(':latest'), `${key}: :latest is not reproducible`);
    }
  });

  test('the pin predicate rejects the tags it exists to catch', () => {
    assert.strictEqual(FULL_PATCH_TAG.test('node:20-alpine'), false, 'a minor-only tag must fail');
    assert.strictEqual(FULL_PATCH_TAG.test('node:latest'), false);
    assert.strictEqual(FULL_PATCH_TAG.test('node:20.18.0-alpine3.20'), true);
  });

  test('a console runtime is not pointed at the ASP.NET image', () => {
    assert.ok(!BASE_IMAGES.dotnetRuntime.includes('aspnet'), 'the console runtime must stay minimal');
  });
});

suite('Container hardening — runtime families', () => {
  test('every family runs non-root', () => {
    for (const family of FAMILIES) {
      const lines = hardeningLines(family, 8080);
      assert.ok(
        lines.some((line) => /^USER /.test(line)),
        `${family}: the hardening tail must contain a USER line`
      );
    }
  });

  test('every family that serves HTTP is probed', () => {
    for (const family of FAMILIES) {
      if (UNPROBEABLE.includes(family)) {
        continue;
      }
      const lines = hardeningLines(family, 8080);
      assert.ok(
        lines.some((line) => line.startsWith('HEALTHCHECK ')),
        `${family}: the hardening tail must contain a HEALTHCHECK`
      );
      assert.ok(
        lines.some((line) => line.includes('http://127.0.0.1:8080')),
        `${family}: the probe must target the container port`
      );
    }
  });

  test('the probe target is a path the service actually serves', () => {
    assert.strictEqual(HEALTHCHECK_PATH, '/health', 'rename it together with the emitted routes');
  });
});

suite('Container hardening — generated containers', () => {
  test('every monorepo stack ships hardened, multi-stage containers', () => {
    for (const stack of MONOREPO_STACKS) {
      if (stack.id === 'node-ts') {
        continue; // node-ts keeps its dedicated writer, asserted through the golden tree
      }
      const found = dockerfiles(planMonorepoTree(stack.id, PLAN));
      assert.ok(found.length > 0, `${stack.id}: the plan must containerize at least one service`);
      for (const [name, body] of found) {
        assertHardened('monorepo:' + stack.id, name, body);
      }
    }
  });

  test('every containerizable template ships a hardened container', () => {
    for (const template of PROJECT_TEMPLATES) {
      if (!supportsContainerization(template.id)) {
        continue;
      }
      const found = dockerfiles(planContainerFiles(template.id, { projectName: 'demo-app' }));
      assert.ok(found.length > 0, `${template.id}: a containerizable template must emit a Dockerfile`);
      for (const [name, body] of found) {
        if (template.id === 'dotnet-console') {
          // A worker has no HTTP endpoint: non-root and multi-stage still apply.
          assert.ok(/^USER \S+$/m.test(body), `${template.id}: ${name} must declare a non-root USER`);
          assert.ok((body.match(/^FROM .* AS /gm) || []).length >= 2, `${template.id}: ${name} must be multi-stage`);
          assert.ok(!body.includes('HEALTHCHECK'), `${template.id}: ${name} has nothing to probe`);
          assert.ok(declaresStartCommand(body), `${template.id}: ${name} must say how to start`);
          continue;
        }
        assertHardened('template:' + template.id, name, body);
      }
    }
  });

  test('an unprivileged runtime stays off privileged ports', () => {
    for (const template of ['react-ts', 'nextjs']) {
      const body = planContainerFiles(template, { projectName: 'demo-app' })['Dockerfile'];
      if (!body) {
        continue;
      }
      assert.ok(!/EXPOSE (80|443)\b/.test(body), `${template}: an unprivileged container cannot bind 80/443`);
    }
  });

  test('the node monorepo writer (golden tree) is hardened too', () => {
    const fixture = path.join(
      findRepoRoot(),
      'src',
      'test',
      'suite',
      'services',
      'fixtures',
      'monorepo-microservices.tree.json'
    );
    const golden = JSON.parse(fs.readFileSync(fixture, 'utf8')) as { files: Record<string, string> };
    const found = dockerfiles(golden.files);
    assert.ok(found.length > 0, 'the fixture must contain the emitted Dockerfiles');
    for (const [name, body] of found) {
      assertHardened('golden', name, body);
    }
  });
});

import * as assert from 'assert';
import { BASE_IMAGES, HEALTHCHECK_PATH } from '../../../shared/containerHardening';
import { OBSERVABILITY_PATHS } from '../../../shared/observabilityArtifacts';
import {
  containerTargetForTemplate,
  planContainerFiles,
  supportsContainerization,
} from '../../../shared/containerization';
import {
  MONOREPO_STACKS,
  MonorepoTreePlan,
  STACK_OPTION_ID,
  isMonorepoStackId,
  monorepoStackForTemplate,
  monorepoStackOption,
  planMonorepoTree,
  resolveMonorepoStack,
} from '../../../shared/monorepoStacks';
import { PROJECT_TEMPLATES } from '../../../webview-ui/src/components/ProjectCreationWizard/types';

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

suite('Monorepo stacks — the stack select', () => {
  test('offers every stack, Node.js first as the default', () => {
    const option = monorepoStackOption();

    assert.strictEqual(option.id, STACK_OPTION_ID);
    assert.strictEqual(option.type, 'select');
    assert.strictEqual(option.default, 'node-ts');
    assert.deepStrictEqual(
      option.options,
      MONOREPO_STACKS.map((stack) => stack.id),
      'the select must offer exactly the stacks the planner can build'
    );
    for (const id of option.options) {
      assert.ok(option.optionLabels[id], `${id}: every value needs a label or the webview prints the raw id`);
    }
  });

  test('resolves a requested stack and falls back to Node.js TypeScript', () => {
    assert.strictEqual(resolveMonorepoStack({ stack: 'dotnet' }), 'dotnet');
    assert.strictEqual(resolveMonorepoStack({ stack: 'php-laravel' }), 'php-laravel');
    assert.strictEqual(resolveMonorepoStack({ stack: 'python' }), 'python');
    assert.strictEqual(resolveMonorepoStack({}), 'node-ts', 'absent option keeps the pre-existing tree');
    assert.strictEqual(resolveMonorepoStack(undefined), 'node-ts');
    assert.strictEqual(resolveMonorepoStack({ stack: 'rust' }), 'node-ts', 'an unknown stack is not trusted');
    assert.ok(!isMonorepoStackId('rust'));
  });

  test('maps each stack template to its monorepo stack', () => {
    assert.strictEqual(monorepoStackForTemplate('node-ts'), 'node-ts');
    assert.strictEqual(monorepoStackForTemplate('node-js'), 'node-ts');
    assert.strictEqual(monorepoStackForTemplate('dotnet-webapi'), 'dotnet');
    assert.strictEqual(monorepoStackForTemplate('php-laravel'), 'php-laravel');
    assert.strictEqual(monorepoStackForTemplate('python'), 'python');
    assert.strictEqual(monorepoStackForTemplate('react-ts'), undefined, 'frontend-only stacks have no monorepo writer');
  });

  test('every stack points at templates that exist in the catalogue', () => {
    const ids = new Set(PROJECT_TEMPLATES.map((template) => template.id));
    for (const stack of MONOREPO_STACKS) {
      assert.ok(stack.templates.length > 0, `${stack.id}: must be reachable from some template`);
      for (const templateId of stack.templates) {
        assert.ok(ids.has(templateId), `${stack.id}: unknown template "${templateId}"`);
      }
      for (const field of [stack.manifest, stack.install, stack.build, stack.test, stack.image]) {
        assert.ok(field.length > 0, `${stack.id}: descriptors must be complete`);
      }
    }
  });

  test('the monorepo project type carries the stack select', () => {
    const template = PROJECT_TEMPLATES.find((candidate) => candidate.id === 'monorepo-microservices');
    assert.ok(template, 'the Monorepo (Microservices) project type must stay available');
    const stack = template!.options.find((option) => option.id === STACK_OPTION_ID);
    assert.ok(stack, 'without the stack select the project type is Node-only again');
    assert.strictEqual(stack!.type, 'select');
    assert.deepStrictEqual(
      stack!.options,
      MONOREPO_STACKS.map((entry) => entry.id),
      '.NET, Laravel and Python must all be offered'
    );
    assert.strictEqual(template!.options[0].id, STACK_OPTION_ID, 'the stack decides what the other options mean');
  });
});

suite('Monorepo stacks — .NET tree', () => {
  const files = planMonorepoTree('dotnet', PLAN);

  test('writes a solution and one web project per service', () => {
    assert.ok(files['DemoApp.sln'], 'a solution file is what makes this a .NET monorepo');
    assert.ok(files['Directory.Build.props'], 'the shared target framework lives here');
    assert.ok(files['global.json']);
    assert.ok(files['services/Gateway/Gateway.Service.csproj']);
    assert.ok(files['services/Orders/Orders.Service.csproj']);
    assert.ok(files['services/Billing/Billing.Service.csproj']);
    assert.ok(files['services/Orders/Program.cs']);
    assert.ok(files['shared/Contracts/Contracts.csproj']);
  });

  test('the solution lists every project with a stable GUID', () => {
    const solution = files['DemoApp.sln'];
    for (const project of ['Contracts', 'Gateway.Service', 'Orders.Service', 'Billing.Service']) {
      assert.ok(solution.includes(project), `${project} must be in the solution`);
    }
    assert.strictEqual(
      planMonorepoTree('dotnet', PLAN)['DemoApp.sln'],
      solution,
      'the generated GUIDs must be deterministic or every scaffold churns the .sln'
    );
  });

  test('every service gets a Dockerfile that publishes its own project', () => {
    const dockerfile = files['services/Orders/Dockerfile'];
    assert.ok(dockerfile.includes(BASE_IMAGES.dotnetSdk), 'build stage');
    assert.ok(dockerfile.includes(BASE_IMAGES.dotnetAspnet), 'runtime stage');
    assert.ok(
      dockerfile.includes('dotnet publish "services/Orders/Orders.Service.csproj"'),
      'each image must publish its own csproj'
    );
    assert.ok(dockerfile.includes('ENTRYPOINT ["dotnet", "Orders.Service.dll"]'));
  });

  test('Compose runs the gateway, every service and the broker', () => {
    const compose = files['docker-compose.yml'];
    for (const service of ['gateway:', 'orders:', 'billing:', 'broker:']) {
      assert.ok(compose.includes(service), `${service} missing from Compose`);
    }
    assert.ok(compose.includes('rabbitmq:3-management'));
    assert.ok(compose.includes('"8080:8080"'), 'the gateway keeps the well-known port');
    assert.ok(compose.includes('"8101:8101"'), 'service ports follow the plan');
    assert.ok(compose.includes('context: ./services/Orders'), 'each image builds from its own folder');
  });

  test('the README names the stack tooling instead of npm', () => {
    assert.ok(files['README.md'].includes('.NET (C#)'));
    assert.ok(files['README.md'].includes('dotnet restore'));
    assert.ok(!files['README.md'].includes('npm install'), 'a .NET monorepo must not tell you to run npm');
  });
});

suite('Monorepo stacks — PHP/Laravel tree', () => {
  const files = planMonorepoTree('php-laravel', PLAN);

  test('the root composer manifest links the services by path', () => {
    const root = JSON.parse(files['composer.json']);
    assert.deepStrictEqual(root.repositories[0], { type: 'path', url: 'services/*' });
    assert.ok(
      root.repositories.some((entry: { url: string }) => entry.url === 'shared/*'),
      'the shared contracts package must be linkable too'
    );
    assert.strictEqual(root.require.php, '^8.3');
  });

  test('each service is a Laravel app that requires the shared contracts', () => {
    const service = JSON.parse(files['services/orders/composer.json']);
    assert.strictEqual(service.name, 'demo_app/orders');
    assert.ok(service.require['laravel/framework'], 'a Laravel monorepo needs the framework');
    assert.strictEqual(service.require['demo_app/contracts'], '*', 'path repositories must be required');
    assert.ok(files['services/orders/routes/api.php'].includes("'service' => 'orders'"));
    assert.ok(files['services/orders/bootstrap/app.php'].includes('Application::configure'));
    assert.ok(files['services/orders/public/index.php'].includes('vendor/autoload.php'));
  });

  test('the shared contracts library is autoloadable', () => {
    const contracts = JSON.parse(files['shared/Contracts/composer.json']);
    assert.deepStrictEqual(contracts.autoload['psr-4'], { 'Contracts\\': 'src/' });
    assert.ok(files['shared/Contracts/src/HealthResponse.php'].includes('namespace Contracts;'));
  });

  test('every service is containerized on its own port', () => {
    assert.ok(files['services/Orders/Dockerfile'] === undefined, 'folders keep the service slug, not PascalCase');
    assert.ok(files['services/orders/Dockerfile'].includes(BASE_IMAGES.php));
    assert.ok(files['services/orders/Dockerfile'].includes('EXPOSE 8101'));
    assert.ok(files['docker-compose.yml'].includes('"8101:8101"'));
  });
});

suite('Monorepo stacks — Python tree', () => {
  const files = planMonorepoTree('python', PLAN);

  test('the root pyproject declares the workspace members', () => {
    const pyproject = files['pyproject.toml'];
    assert.ok(pyproject.includes('[tool.uv.workspace]'));
    assert.ok(pyproject.includes('"services/orders"'));
    assert.ok(pyproject.includes('"services/billing"'));
    assert.ok(pyproject.includes('"shared/contracts"'));
    assert.ok(files['.python-version'] === undefined || typeof files['.python-version'] === 'string');
  });

  test('each service is a FastAPI app with a health endpoint', () => {
    assert.ok(files['services/orders/pyproject.toml'].includes('"fastapi>=0.111"'));
    assert.ok(files['services/orders/pyproject.toml'].includes('contracts = { workspace = true }'));
    const main = files['services/orders/app/main.py'];
    assert.ok(main.includes('FastAPI(title="orders")'));
    assert.ok(main.includes('@app.get("/health")'));
  });

  test('each service has a container that runs uvicorn on the planned port', () => {
    const dockerfile = files['services/orders/Dockerfile'];
    assert.ok(dockerfile.includes(BASE_IMAGES.python));
    assert.ok(dockerfile.includes('EXPOSE 8101'));
    assert.ok(dockerfile.includes('"--port", "8101"'));
    assert.ok(files['docker-compose.yml'].includes('context: ./services/orders'), 'each service builds itself');
    assert.ok(!files['docker-compose.yml'].includes('npm'), 'a Python monorepo must not be Node-shaped');
  });
});

suite('Monorepo stacks — guards', () => {
  test('node-ts keeps its dedicated writer', () => {
    assert.throws(() => planMonorepoTree('node-ts', PLAN), /dedicated writer/);
  });

  test('a plan without a gateway still numbers its services', () => {
    const files = planMonorepoTree('python', { ...PLAN, gateway: '', services: ['orders'] });
    assert.ok(files['docker-compose.yml'].includes('"8100:8100"'), 'without a gateway the first service takes 8100');
    assert.ok(!files['docker-compose.yml'].includes('gateway:'));
  });

  test('a plan without a broker writes no broker service', () => {
    const files = planMonorepoTree('dotnet', { ...PLAN, broker: 'none' });
    assert.ok(!files['docker-compose.yml'].includes('broker:'));
    assert.ok(!files['.env.example'].includes('BROKER_URL'));
  });
});

suite('Containerization is promoted for every project type', () => {
  test('maps each template to a container target', () => {
    assert.strictEqual(containerTargetForTemplate('node-ts'), 'node');
    assert.strictEqual(containerTargetForTemplate('python'), 'python');
    assert.strictEqual(containerTargetForTemplate('php-laravel'), 'php');
    assert.strictEqual(containerTargetForTemplate('dotnet-webapi'), 'dotnet');
    assert.strictEqual(containerTargetForTemplate('dotnet-console'), 'dotnet');
    assert.strictEqual(containerTargetForTemplate('react-ts'), 'react');
    assert.strictEqual(containerTargetForTemplate('nextjs'), 'next');
  });

  test('leaves mobile, documentation and the empty template alone', () => {
    for (const templateId of ['react-native', 'flutter', 'dotnet-maui', 'doc-ba', 'doc-writer', 'doc-tester', 'empty']) {
      assert.strictEqual(containerTargetForTemplate(templateId), 'none', `${templateId} is not containerizable`);
      assert.deepStrictEqual(planContainerFiles(templateId, { projectName: 'demo' }), {});
    }
  });

  test('every containerizable project type offers an opt-out that defaults to on', () => {
    for (const template of PROJECT_TEMPLATES) {
      if (!supportsContainerization(template.id)) {
        continue;
      }
      const docker = template.options.find((option) => option.id === 'docker');
      assert.ok(docker, `${template.id}: a containerizable template must expose the Docker toggle`);
      assert.strictEqual(docker!.type, 'boolean');
      assert.strictEqual(docker!.default, true, `${template.id}: containerization is promoted, so it defaults on`);
    }
  });

  test('writes a Dockerfile, an ignore file and a Compose service', () => {
    const files = planContainerFiles('python', { projectName: 'Demo App' });
    assert.ok(files.Dockerfile.includes(`FROM ${BASE_IMAGES.python}`));
    assert.ok(files['.dockerignore'].includes('node_modules'), 'the ignore set is shared across stacks');
    assert.ok(files['docker-compose.yml'].includes('  demo-app:'), 'the Compose service is slugged');
    assert.ok(files['docker-compose.yml'].includes('"8000:8000"'));
  });

  test('the React target serves static files from nginx', () => {
    const files = planContainerFiles('react-ts', { projectName: 'demo' });
    assert.ok(files.Dockerfile.includes('RUN npm run build'));
    assert.ok(files.Dockerfile.includes(BASE_IMAGES.nginxUnprivileged));
    assert.ok(files.Dockerfile.includes('EXPOSE 8080'));
  });

  test('a console app gets a runtime image, not the web one', () => {
    const files = planContainerFiles('dotnet-console', { projectName: 'demo' });
    assert.ok(files.Dockerfile.includes(BASE_IMAGES.dotnetRuntime));
    assert.ok(!files.Dockerfile.includes('aspnet'), 'a console app must not pull the ASP.NET runtime');
  });
});

suite('Monorepo stacks — brokers and per-stack wizard options', () => {
  test('NATS is wired like the other brokers', () => {
    const files = planMonorepoTree('dotnet', { ...PLAN, broker: 'nats' });
    assert.ok(files['docker-compose.yml'].includes('nats:2.10-alpine'), 'the wizard offers nats, so it must run');
    assert.ok(files['docker-compose.yml'].includes('"4222:4222"'));
    assert.ok(files['.env.example'].includes('BROKER_URL=nats://broker:4222'));
  });

  test('Node-only monorepo options hide for the other stacks', () => {
    const template = PROJECT_TEMPLATES.find((candidate) => candidate.id === 'monorepo-microservices')!;
    for (const optionId of ['workspaceTool', 'tooling']) {
      const option = template.options.find((candidate) => candidate.id === optionId);
      assert.ok(option && option.showWhen, `${optionId} is npm-only and must be hidden for other stacks`);
      assert.strictEqual(option!.showWhen!({ stack: 'node-ts' }), true, `${optionId} shows for TypeScript`);
      assert.strictEqual(option!.showWhen!({ stack: 'dotnet' }), false, `${optionId} is meaningless for .NET`);
      assert.strictEqual(option!.showWhen!({}), true, 'a legacy payload without stack stays TypeScript');
    }
  });

  test('the stack select is never hidden', () => {
    const template = PROJECT_TEMPLATES.find((candidate) => candidate.id === 'monorepo-microservices')!;
    const stack = template.options.find((candidate) => candidate.id === STACK_OPTION_ID)!;
    assert.strictEqual(stack.showWhen, undefined, 'hiding the stack select would make the project type Node-only again');
  });
});

suite('Monorepo stacks — platform routes (CON-03/CON-04)', () => {
  const stacks = MONOREPO_STACKS.filter((stack) => stack.id !== 'node-ts');

  function sources(stackId: Parameters<typeof planMonorepoTree>[0]): string {
    const files = planMonorepoTree(stackId, PLAN);
    return Object.keys(files)
      .filter((file) => /\.(ts|tsx|py|cs|php)$/.test(file))
      .map((file) => files[file])
      .join('\n');
  }

  test('only the stacks with a shared planner are covered here', () => {
    assert.deepStrictEqual(
      stacks.map((stack) => stack.id),
      ['dotnet', 'php-laravel', 'python'],
      'node-ts keeps its dedicated writer and is covered by the golden fixture'
    );
  });

  for (const stack of stacks) {
    test(`${stack.id} serves liveness, readiness and metrics`, () => {
      const source = sources(stack.id);
      assert.ok(source.includes(OBSERVABILITY_PATHS.live), `${stack.id} has no liveness route`);
      assert.ok(source.includes(OBSERVABILITY_PATHS.ready), `${stack.id} has no readiness route`);
      assert.ok(source.includes(OBSERVABILITY_PATHS.metrics), `${stack.id} has no metrics route`);
    });

    test(`${stack.id} keeps serving the legacy route its HEALTHCHECK probes`, () => {
      // The Dockerfile probe and the app must agree, or every container is unhealthy.
      const source = sources(stack.id);
      assert.ok(source.includes(HEALTHCHECK_PATH), `${stack.id} does not serve ${HEALTHCHECK_PATH}`);
    });

    test(`${stack.id} withdraws readiness without failing liveness`, () => {
      // A constant readiness endpoint either gets a draining pod killed or keeps
      // routing traffic to it, which is exactly what CON-04 forbids.
      const source = sources(stack.id);
      assert.ok(/draining/i.test(source), `${stack.id} readiness can never fail`);
      assert.ok(/503/.test(source), `${stack.id} readiness cannot signal "stop routing"`);
    });

    test(`${stack.id} versions its business routes under /api/v1`, () => {
      if (stack.id === 'php-laravel') {
        // Laravel applies apiPrefix centrally; see the dedicated test below.
        return;
      }
      const source = sources(stack.id);
      assert.ok(source.includes('/api/v1'), `${stack.id} does not expose a versioned surface`);
    });
  }

  test('the PHP routes file stays relative because the prefix is applied centrally', () => {
    const files = planMonorepoTree('php-laravel', PLAN);
    const routes = files['services/orders/routes/api.php'];
    assert.ok(routes, 'missing routes/api.php');
    assert.strictEqual(
      routes.includes('/api/v1'),
      false,
      'a per-route prefix would double up with apiPrefix'
    );
    const bootstrap = files['services/orders/bootstrap/app.php'];
    assert.ok(bootstrap && bootstrap.includes("apiPrefix: 'api/v1'"), 'apiPrefix is not set');
  });

  test('.NET and python serve the versioned resource route directly', () => {
    for (const stackId of ['dotnet', 'python'] as const) {
      assert.ok(
        sources(stackId).includes('/api/v1/orders'),
        `${stackId} does not serve /api/v1/orders`
      );
    }
  });
});

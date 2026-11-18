import * as assert from 'assert';
import { OBSERVABILITY_PATHS } from '../../../shared/observabilityArtifacts';
import { MonorepoTreePlan, planMonorepoTree } from '../../../shared/monorepoStacks';
import {
  DOTNET_GUARD_PATH,
  EDGE_GUARD_AUTH_ENV,
  EDGE_GUARD_ERROR_CODES,
  EDGE_GUARD_EXEMPT_PATHS,
  EDGE_GUARD_HEADERS,
  EDGE_GUARD_MAX_AGE_SECONDS,
  EDGE_GUARD_SECRET_ENV,
  EDGE_GUARD_VERIFIED_VALUE,
  PHP_GUARD_PATH,
  PYTHON_GUARD_PATH,
  dotnetEdgeGuard,
  phpEdgeGuard,
  pythonEdgeGuard,
} from '../../../shared/securityEdgeGuards';
import { createHmac } from 'crypto';

const PLAN: MonorepoTreePlan = {
  projectName: 'demo-app',
  description: 'Demo services',
  version: '0.1.0',
  services: ['orders', 'billing'],
  gateway: 'gateway',
  broker: 'none',
  sharedPackage: true,
  containerization: true,
};

const GUARDS = [
  { family: 'python', path: PYTHON_GUARD_PATH, source: pythonEdgeGuard('orders') },
  { family: 'dotnet', path: DOTNET_GUARD_PATH, source: dotnetEdgeGuard('Orders.Service', 'orders') },
  { family: 'php', path: PHP_GUARD_PATH, source: phpEdgeGuard('orders') },
] as const;

function filesEndingWith(tree: Record<string, string>, suffix: string): string[] {
  return Object.keys(tree).filter((path) => path.endsWith(suffix));
}

suite('Edge auth guards — one contract, three standard libraries', () => {
  test('every family speaks the same header vocabulary as the node gateway', () => {
    for (const guard of GUARDS) {
      for (const header of Object.values(EDGE_GUARD_HEADERS)) {
        assert.ok(
          guard.source.includes(header),
          `${guard.family}: the guard must read ${header} or a request the gateway stamped looks unauthenticated`
        );
      }
      assert.ok(guard.source.includes(EDGE_GUARD_VERIFIED_VALUE), `${guard.family}: the edge marker is missing`);
      assert.ok(guard.source.includes(EDGE_GUARD_AUTH_ENV), `${guard.family}: the opt-out variable is missing`);
      assert.ok(guard.source.includes(EDGE_GUARD_SECRET_ENV), `${guard.family}: the secret variable is missing`);
      assert.ok(
        guard.source.includes(String(EDGE_GUARD_MAX_AGE_SECONDS)),
        `${guard.family}: the freshness window must be stated, not implied`
      );
    }
  });

  test('the probes are exempt in every family, so a liveness check never needs a token', () => {
    for (const guard of GUARDS) {
      for (const path of EDGE_GUARD_EXEMPT_PATHS) {
        assert.ok(guard.source.includes(path), `${guard.family}: ${path} must be reachable before the caller is known`);
      }
      assert.ok(
        EDGE_GUARD_EXEMPT_PATHS.includes(OBSERVABILITY_PATHS.live) &&
          EDGE_GUARD_EXEMPT_PATHS.includes(OBSERVABILITY_PATHS.ready),
        'both platform probes must be exempt, not just one'
      );
    }
  });

  test('the signed message is field-for-field the node canonical form', () => {
    // The gateway signs `subject|scopes|issuer|issuedAt`; a guard that joins in a
    // different order verifies nothing and rejects every stamped request.
    const canonical = (subject: string, scopes: string[], issuer: string) =>
      [subject, scopes.join(' '), issuer].join('|');
    assert.strictEqual(canonical('user-1', ['orders:read', 'orders:write'], 'zen'), 'user-1|orders:read orders:write|zen');

    assert.ok(
      pythonEdgeGuard('orders').includes('"|".join([subject, " ".join(scopes), issuer, str(issued_at)])'),
      'python must join subject|scopes|issuer|issuedAt'
    );
    assert.ok(
      dotnetEdgeGuard('Orders.Service', 'orders').includes(
        'string.Join("|", subject, scopes, issuer, issuedAt.ToString(CultureInfo.InvariantCulture))'
      ),
      'dotnet must join subject|scopes|issuer|issuedAt'
    );
    assert.ok(
      phpEdgeGuard('orders').includes("implode('|', [$subject, $scopes, $issuer, (string) $issuedAt])"),
      'php must join subject|scopes|issuer|issuedAt'
    );
  });

  test('the stamp the node gateway produces is what the guards describe', () => {
    const issuedAt = 1_700_000_000;
    const stamp = `${issuedAt}.${createHmac('sha256', 'shared-secret')
      .update(`user-1|orders:read|zen|${issuedAt}`)
      .digest('hex')}`;

    assert.match(stamp, /^\d+\.[0-9a-f]{64}$/, 'the stamp is <issuedAt>.<hex sha256> and the guards parse exactly that');
    for (const guard of GUARDS) {
      assert.ok(
        guard.source.includes('sha256') || guard.source.toLowerCase().includes('hmacsha256'),
        `${guard.family}: the digest must be hmac-sha256`
      );
    }
  });

  test('signature comparison is constant time in every family', () => {
    const primitives: Record<string, string> = {
      python: 'hmac.compare_digest',
      dotnet: 'CryptographicOperations.FixedTimeEquals',
      php: 'hash_equals',
    };

    for (const guard of GUARDS) {
      assert.ok(
        guard.source.includes(primitives[guard.family]),
        `${guard.family}: a byte-wise comparison leaks the signature one byte at a time`
      );
    }
  });

  test('a missing secret refuses the request instead of trusting it', () => {
    for (const guard of GUARDS) {
      assert.ok(
        guard.source.includes('missing_edge_secret'),
        `${guard.family}: an unconfigured secret must fail closed, not fall through to allow`
      );
    }
    assert.ok(EDGE_GUARD_ERROR_CODES.includes('missing_edge_secret'));
  });

  test('unset EDGE_AUTH_REQUIRED means required — the same default in all three', () => {
    assert.ok(pythonEdgeGuard('orders').includes('os.environ.get(EDGE_AUTH_ENV, "1")'));
    assert.ok(
      dotnetEdgeGuard('Orders.Service', 'orders').includes('Environment.GetEnvironmentVariable(EdgeAuthEnv) ?? "1"')
    );
    assert.ok(phpEdgeGuard('orders').includes("(getenv(self::EDGE_AUTH_ENV) ?: '1')"));

    // Only the explicit opt-out values may turn verification off.
    for (const guard of GUARDS) {
      assert.ok(guard.source.includes('"0"') || guard.source.includes("'0'"), `${guard.family}: no documented opt-out`);
    }
  });

  test('a stale stamp is rejected in every family', () => {
    for (const guard of GUARDS) {
      assert.ok(guard.source.includes('stale_stamp'), `${guard.family}: freshness must be enforced, not documented`);
    }
  });

  test('the identity the gateway stamp carries is required, not defaulted', () => {
    for (const guard of GUARDS) {
      assert.ok(
        guard.source.includes('missing_identity'),
        `${guard.family}: an unstamped subject must be refused, not treated as anonymous`
      );
      assert.ok(
        guard.source.includes('unverified_identity'),
        `${guard.family}: x-auth-verified must be checked, so a direct caller cannot forge the headers`
      );
    }
  });
});

suite('Edge auth guards — wired into each tree', () => {
  const cases = [
    { stack: 'python', path: PYTHON_GUARD_PATH, registration: 'app.middleware("http")(edge_auth_middleware)' },
    { stack: 'dotnet', path: DOTNET_GUARD_PATH, registration: 'app.UseMiddleware<EdgeAuthMiddleware>();' },
    {
      stack: 'php-laravel',
      path: PHP_GUARD_PATH,
      registration: '\\App\\Http\\Middleware\\VerifyEdgeIdentity::class',
    },
  ] as const;

  for (const testCase of cases) {
    test(`${testCase.stack}: every service carries a guard and registers it`, () => {
      const tree = planMonorepoTree(testCase.stack, PLAN);
      const guards = filesEndingWith(tree, testCase.path);

      assert.strictEqual(
        guards.length,
        3,
        `${testCase.stack}: the gateway and both domain services each need their own guard`
      );

      for (const guardPath of guards) {
        assert.ok(tree[guardPath].length > 500, `${guardPath}: a guard that fits in a comment verifies nothing`);
      }

      const entrypoints = guards.map((guardPath) => guardPath.slice(0, guardPath.length - testCase.path.length));
      for (const serviceRoot of entrypoints) {
        const entrypoint = Object.keys(tree).find(
          (path) =>
            path.startsWith(serviceRoot) &&
            (path.endsWith('/main.py') || path.endsWith('/Program.cs') || path.endsWith('/bootstrap/app.php'))
        );

        assert.ok(entrypoint, `${serviceRoot}: no entrypoint to register the guard in`);
        assert.ok(
          tree[entrypoint].includes(testCase.registration),
          `${entrypoint}: the guard exists but nothing runs it — the clause is about requests, not files`
        );
      }
    });
  }

  test('.NET: the guard namespace matches the project it lives in', () => {
    const tree = planMonorepoTree('dotnet', PLAN);
    const guards = filesEndingWith(tree, DOTNET_GUARD_PATH);

    for (const guardPath of guards) {
      const folder = guardPath.slice(0, guardPath.length - DOTNET_GUARD_PATH.length).replace(/\/$/, '');
      const project = Object.keys(tree).find(
        (path) => path.startsWith(`${folder}/`) && path.endsWith('.csproj') && !path.includes('/shared/')
      );

      assert.ok(project, `${folder}: no csproj beside the guard`);
      const projectName = project.slice(project.lastIndexOf('/') + 1).replace(/\.csproj$/, '');
      assert.ok(
        tree[guardPath].includes(`namespace ${projectName}.Security;`),
        `${guardPath}: the namespace must match ${projectName} or Program.cs cannot import it`
      );
      assert.ok(
        tree[`${folder}/Program.cs`].includes(`using ${projectName}.Security;`),
        `${folder}/Program.cs: the using directive must name the namespace the guard declares`
      );
    }
  });

  test('the secret is interpolated from the host environment, never committed', () => {
    for (const testCase of cases) {
      const tree = planMonorepoTree(testCase.stack, PLAN);

      assert.ok(tree['.env.example'], `${testCase.stack}: no .env.example`);
      assert.match(
        tree['.env.example'],
        /^EDGE_AUTH_SHARED_SECRET=$/m,
        `${testCase.stack}: the example must leave the secret empty — a placeholder is a credential people copy`
      );
      assert.match(tree['.env.example'], /^EDGE_AUTH_REQUIRED=1$/m, `${testCase.stack}: verification is on by default`);

      const compose = tree['docker-compose.yml'];
      assert.ok(compose.includes('EDGE_AUTH_SHARED_SECRET: "${EDGE_AUTH_SHARED_SECRET:?'), `${testCase.stack}: compose must fail loudly when the secret is unset`);
      assert.ok(
        !/EDGE_AUTH_SHARED_SECRET: "?[A-Za-z0-9._-]{8,}"?$/m.test(compose.replace(/\$\{EDGE_AUTH_SHARED_SECRET:\?[^}]*\}/g, '')),
        `${testCase.stack}: no literal secret may be written into compose`
      );
    }
  });

  test('the node stack is served by its dedicated writer, not these guards', () => {
    // node-ts keeps `ProjectCreationService.scaffoldMonorepoMicroservices`, whose
    // equivalent artifacts are `packages/shared/src/auth.ts` + `secrets.ts`.
    assert.throws(
      () => planMonorepoTree('node-ts', PLAN),
      /dedicated writer/,
      'if the node tree ever starts flowing through planMonorepoTree, the guard wiring needs a node branch too'
    );
  });
});

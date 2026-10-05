import * as assert from 'assert';

import { createServices, createServiceFactories, Services } from '../../services';
import { lazyServices, ServiceFactories } from '../../shared/lazyServices';
import { logger } from '../../services/logger';

// Guardrail for P3: `createServices()` must hand back a container whose
// services are built on first use.
//
// Before this change every service was constructed during activation, so the
// work-item tree paid for the chat stack, the MCP manager and the repository-
// understanding cache. These tests assert the observable behaviour that makes
// the win real:
//   * building the container constructs nothing,
//   * reading one service constructs that one only,
//   * a service with dependencies pulls them in, and nothing else,
//   * introspection of the container stays free.

const SERVICE_KEYS = [
    'ado',
    'agents',
    'changelog',
    'checkpoints',
    'git',
    'logger',
    'mcp',
    'memory',
    'projectCreation',
    'skillRegistry',
    'skills',
    'todos',
    'understanding',
    'workspaceMemory',
];

function fakeContext(): any {
    return {
        subscriptions: [],
        extensionPath: __dirname,
        workspaceState: { get: () => undefined, update: async () => { /* noop */ } },
        globalState: { get: () => undefined, update: async () => { /* noop */ } },
    };
}

/** The real factories, wrapped so each construction is counted. */
function countingFactories(): { factories: ServiceFactories<Services>; counts: Record<string, number> } {
    const real = createServiceFactories(fakeContext());
    const counts: Record<string, number> = {};
    for (const key of Object.keys(real)) { counts[key] = 0; }

    const wrapped = {} as Record<string, (services: Services) => unknown>;
    for (const [key, factory] of Object.entries(real)) {
        wrapped[key] = (services: Services) => {
            counts[key]++;
            return (factory as (services: Services) => unknown)(services);
        };
    }

    return { factories: wrapped as unknown as ServiceFactories<Services>, counts };
}

function builtKeys(counts: Record<string, number>): string[] {
    return Object.keys(counts).filter((key) => counts[key] > 0).sort();
}

suite('services/laziness', () => {
    test('exposes exactly one factory per service', () => {
        const factories = createServiceFactories(fakeContext());

        assert.deepStrictEqual(Object.keys(factories).sort(), SERVICE_KEYS);
    });

    test('createServices returns a container with every service key', () => {
        const services = createServices(fakeContext());

        assert.deepStrictEqual(Object.keys(services).sort(), SERVICE_KEYS);
    });

    test('building the container constructs no service at all', () => {
        const { factories, counts } = countingFactories();

        const services = lazyServices(factories);

        assert.deepStrictEqual(builtKeys(counts), [], 'activation must not construct any service');
        assert.deepStrictEqual(Object.keys(services).sort(), SERVICE_KEYS);
        assert.deepStrictEqual(builtKeys(counts), [], 'enumerating keys must not construct either');
    });

    test('reading one service constructs only that service', () => {
        const { factories, counts } = countingFactories();
        const services = lazyServices(factories);

        void services.changelog;

        assert.deepStrictEqual(builtKeys(counts), ['changelog']);
    });

    test('a service with dependencies constructs itself and its dependencies only', () => {
        const { factories, counts } = countingFactories();
        const services = lazyServices(factories);

        void services.understanding;

        assert.deepStrictEqual(
            builtKeys(counts),
            ['git', 'understanding', 'workspaceMemory'],
            'understanding depends on git + workspaceMemory and nothing else',
        );
    });

    test('a service is memoized across reads', () => {
        const { factories, counts } = countingFactories();
        const services = lazyServices(factories);

        const first = services.todos;
        const second = services.todos;

        assert.strictEqual(first, second);
        assert.strictEqual(counts.todos, 1);
    });

    test('every service stays a lazy accessor until first read', () => {
        const services = createServices(fakeContext());

        for (const key of SERVICE_KEYS) {
            const descriptor = Object.getOwnPropertyDescriptor(services, key);
            assert.ok(descriptor, `missing descriptor for ${key}`);
            assert.strictEqual(typeof descriptor!.get, 'function', `${key} must be lazy`);
        }
    });

    test('logger resolves to the shared singleton', () => {
        const services = createServices(fakeContext());

        assert.strictEqual(services.logger, logger);
    });
});

import * as assert from 'assert';

import { lazyServices, ServiceFactories } from '../../../shared/lazyServices';

// Guardrail for the P3 laziness primitive.
//
// `createServices()` used to eagerly `new` every service during activation,
// so a session that only opened the work-item tree still paid for the chat
// stack, MCP manager, understanding cache and so on. `lazyServices()` is the
// primitive that moves construction to first property access.
//
// These tests pin the *contract* the startup path depends on:
//   1. nothing is built until a property is read (that is the whole point),
//   2. each service is built at most once and every read returns that instance,
//   3. reading one service never builds its siblings (a factory receives the
//      container and pulls in only what it actually needs),
//   4. introspection (Object.keys / `in` / descriptors) stays free — otherwise
//      logging or debugging would silently make startup eager again.

interface Probe {
    a: number;
    b: string;
    c: { id: string };
}

const ZERO: Record<keyof Probe, number> = { a: 0, b: 0, c: 0 };

function countingFactories(): { factories: ServiceFactories<Probe>; calls: Record<keyof Probe, number> } {
    const calls: Record<keyof Probe, number> = { ...ZERO };
    return {
        calls,
        factories: {
            a: () => { calls.a++; return 1; },
            b: () => { calls.b++; return 'x'; },
            c: () => { calls.c++; return { id: 'c' }; },
        },
    };
}

suite('shared/lazyServices', () => {
    test('builds nothing until a property is read', () => {
        const { factories, calls } = countingFactories();

        lazyServices(factories);

        assert.deepStrictEqual(calls, ZERO, 'no factory may run while creating the container');
    });

    test('a read builds only the service that was read', () => {
        const { factories, calls } = countingFactories();
        const services = lazyServices(factories);

        assert.strictEqual(services.a, 1);

        assert.deepStrictEqual(calls, { ...ZERO, a: 1 }, 'reading `a` must not build `b` or `c`');
    });

    test('memoizes — a service is built exactly once no matter how often it is read', () => {
        const { factories, calls } = countingFactories();
        const services = lazyServices(factories);

        void services.c;
        void services.c;
        void services.c;

        assert.strictEqual(calls.c, 1);
    });

    test('every read returns the identical instance', () => {
        const { factories } = countingFactories();
        const services = lazyServices(factories);

        assert.strictEqual(services.c, services.c);
        assert.strictEqual(services.b, services.b);
    });

    test('enumerating keys does not build anything', () => {
        const { factories, calls } = countingFactories();
        const services = lazyServices(factories);

        assert.deepStrictEqual(Object.keys(services).sort(), ['a', 'b', 'c']);

        assert.deepStrictEqual(calls, ZERO, 'Object.keys must not trigger construction');
    });

    test('membership checks and property descriptors do not build anything', () => {
        const { factories, calls } = countingFactories();
        const services = lazyServices(factories);

        assert.ok('a' in services);
        for (const key of Object.keys(services)) {
            const descriptor = Object.getOwnPropertyDescriptor(services, key);
            assert.ok(descriptor, `expected a descriptor for ${key}`);
            assert.strictEqual(typeof descriptor!.get, 'function', `${key} must stay a lazy accessor`);
        }

        assert.deepStrictEqual(calls, ZERO);
    });

    test('a service may pull in a sibling service lazily', () => {
        interface Dependent {
            base: number;
            derived: string;
        }
        const calls = { base: 0, derived: 0 };

        const container = lazyServices<Dependent>({
            base: () => { calls.base++; return 41; },
            derived: (services) => { calls.derived++; return `d${services.base + 1}`; },
        });

        assert.deepStrictEqual(calls, { base: 0, derived: 0 }, 'defining the dependency graph builds nothing');

        assert.strictEqual(container.derived, 'd42');
        assert.deepStrictEqual(calls, { base: 1, derived: 1 }, 'the dependency is built on demand, once');
    });

    test('a throwing factory is not memoized and is retried on the next read', () => {
        let attempts = 0;
        const services = lazyServices<{ boom: string }>({
            boom: () => {
                attempts++;
                if (attempts === 1) { throw new Error('nope'); }
                return 'ok';
            },
        });

        assert.throws(() => services.boom, /nope/);
        assert.strictEqual(services.boom, 'ok', 'a failed construction must not be cached');
        assert.strictEqual(attempts, 2);
    });

    test('a value may be overridden and the override sticks (no construction)', () => {
        const { factories, calls } = countingFactories();
        const services = lazyServices(factories);

        services.b = 'override';

        assert.strictEqual(services.b, 'override');
        assert.strictEqual(calls.b, 0, 'overriding must not run the factory');
    });
});

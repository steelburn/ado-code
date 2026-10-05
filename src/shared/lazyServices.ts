// Lazy service container (startup-loading optimisation, phase P3).
//
// `createServices()` used to `new` every service while `activate()` ran, so a
// session that only opened the work-item tree still paid for the chat stack,
// the MCP manager and the repository-understanding cache. This module is the
// dependency-free primitive that moves construction to *first property access*.
//
// Contract (pinned by src/test/suite/shared/lazyServices.test.ts):
//   * building the container constructs nothing,
//   * each service is built at most once; every read returns that instance,
//   * reading one service does not build its siblings — a factory receives the
//     container and pulls only the dependencies it actually needs,
//   * introspection (`Object.keys`, `in`, descriptors) stays free,
//   * a factory that throws is not memoized, so it is retried on the next read.

/**
 * A factory per service. Each factory is handed the (lazy) container so it can
 * resolve sibling services on demand without forcing their construction.
 */
export type ServiceFactories<T> = { [K in keyof T]: (services: T) => T[K] };

/**
 * Wrap a map of factories in a container whose properties are built on first
 * access and then memoized. Properties stay enumerable and configurable, so the
 * object behaves like the plain literal it replaces.
 */
export function lazyServices<T extends object>(factories: ServiceFactories<T>): T {
    const container = {} as T;

    for (const key of Object.keys(factories) as Array<keyof T & string>) {
        let built = false;
        let value: T[keyof T & string];

        Object.defineProperty(container, key, {
            enumerable: true,
            configurable: true,
            get(): T[keyof T & string] {
                if (!built) {
                    // Assign-then-flag: a throwing factory leaves `built` false,
                    // so the failure is not cached and the next read retries.
                    value = factories[key](container);
                    built = true;
                }
                return value;
            },
            set(next: T[keyof T & string]): void {
                value = next;
                built = true;
            },
        });
    }

    return container;
}

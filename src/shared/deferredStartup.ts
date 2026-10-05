// Deferred startup queue (startup-loading optimisation, phase P2).
//
// Activation should only do what is required to make the first view usable.
// Anything that costs I/O, spawns a process or hits the network — refreshing
// repository understanding, connecting MCP servers, probing installed agents —
// is registered here and drained *after* activation returns, so it never sits
// on the critical path to the user's first render.
//
// The queue is deliberately tiny and dependency-free so it can be unit-tested
// outside the extension host (see src/test/suite/shared/deferredStartup.test.ts).

export type DeferScheduler = (fn: () => void) => void;

interface DeferredTask {
  name: string;
  run: () => unknown;
}

export interface DeferredStartupOptions {
  /** How to schedule the drain. Defaults to a 0 ms macrotask (after activation). */
  schedule?: DeferScheduler;
  /** Duration source, injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
  /** Called after each task with its name, duration and (optional) error. */
  log?: (message: string) => void;
}

/**
 * Runs registered tasks sequentially once `start()` is called, each isolated so
 * one failure cannot abort the rest. Tasks registered after the drain has begun
 * are picked up by the same loop.
 */
export class DeferredStartup {
  private readonly queue: DeferredTask[] = [];
  private readonly schedule: DeferScheduler;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private scheduled = false;
  private flushing = false;

  constructor(options: DeferredStartupOptions = {}) {
    this.schedule = options.schedule ?? ((fn) => setTimeout(fn, 0));
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.log = options.log ?? (() => { /* no-op */ });
  }

  /** Number of tasks not yet run (useful for tests and diagnostics). */
  get pending(): number {
    return this.queue.length;
  }

  /** Queue work that must not run during activation. */
  register(name: string, run: () => unknown): void {
    this.queue.push({ name, run });
  }

  /**
   * Begin draining the queue on the next tick. Idempotent — calling it twice (or
   * with an empty queue) is a no-op.
   */
  start(): void {
    if (this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    this.schedule(() => { void this.flush(); });
  }

  /**
   * Drain every queued task now, in registration order. Resolves when all tasks
   * have settled; never rejects.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        const t0 = this.now();
        try {
          await task.run();
          this.log(`startup(deferred): ${task.name} finished in ${Math.round(this.now() - t0)}ms`);
        } catch (err) {
          this.log(`startup(deferred): ${task.name} failed after ${Math.round(this.now() - t0)}ms: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

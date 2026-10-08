/**
 * SerialQueue — runs async tasks strictly one after another.
 *
 * Why this exists: the agentic loop executes auto-approved tool calls of a
 * single iteration CONCURRENTLY (read-only + yolo/act calls run together to
 * save round-trips). Some tools, however, drive a *single-slot* user-facing
 * flow — the work-item draft editor and its confirmation card — where a second
 * concurrent invocation would overwrite the first one's resolver and make the
 * confirmation broker supersede the earlier card. Serializing those flows
 * through one queue makes a batch of calls review one card at a time.
 */
export class SerialQueue {
  /** Settles when the currently in-flight (or last enqueued) task settles. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Number of tasks that are queued or running. */
  private pending = 0;

  /**
   * Enqueue `task`. The first task starts synchronously — so callers observe a
   * deterministic start order — while every later task waits for the queue to
   * drain to it, preserving FIFO order regardless of how long each task runs.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;

    const started: Promise<T> = this.pending === 1
      ? invoke(task)
      : this.tail.then(task, task);

    this.tail = started.then(
      () => { this.pending -= 1; },
      () => { this.pending -= 1; },
    );
    return started;
  }
}

/** Invoke `task`, converting a synchronous throw into a rejected promise. */
function invoke<T>(task: () => Promise<T>): Promise<T> {
  try {
    return task();
  } catch (err) {
    return Promise.reject(err);
  }
}

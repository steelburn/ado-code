// Persistence for the turn outcome counters (roadmap #1, stage 1).
//
// One small JSON file per workspace under `.ado-code/metrics/` — the same
// machine-local, git-ignored directory that already holds memory, checkpoints
// and artifact metadata (see services/ignoreFiles.ts). Rules, in priority order:
//
//   1. Metrics must NEVER break a turn. Every failure is logged and swallowed.
//   2. Writes are serialized: turns finish concurrently, and a read-modify-write
//      race would silently lose counts.
//   3. Writes are atomic (temp file + rename): a cancelled write leaves the
//      previous file intact instead of a truncated JSON body.
//
// No policy lives here — the counting rules are in ./turnOutcome, which stays
// unit-testable without touching the disk.

import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../logger';
import {
  OutcomeCounters,
  TurnRecord,
  emptyOutcomeCounters,
  parseOutcomeCounters,
  recordTurn,
  serializeOutcomeCounters,
} from './turnOutcome';

export const OUTCOME_DIR = path.join('.ado-code', 'metrics');
export const OUTCOME_FILE_NAME = 'turn-outcomes.json';

export class TurnOutcomeStore {
  /** Serializes read-modify-write cycles so concurrent turns cannot clobber. */
  private queue: Promise<void> = Promise.resolve();
  private cached?: OutcomeCounters;

  /** `root` is a resolver, not a value: the workspace folder can change mid-session. */
  constructor(private readonly root: () => string | undefined) {}

  filePath(): string | undefined {
    const root = this.root();
    return root ? path.join(root, OUTCOME_DIR, OUTCOME_FILE_NAME) : undefined;
  }

  /** Cached read: the file only changes through this store in normal operation. */
  async read(): Promise<OutcomeCounters> {
    if (this.cached) return this.cached;
    const file = this.filePath();
    if (!file) return emptyOutcomeCounters();
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      this.cached = parseOutcomeCounters(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.warn(`outcomes: could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.cached = emptyOutcomeCounters();
    }
    return this.cached;
  }

  /**
   * Fold one finished turn into the persisted aggregate. Safe to fire and
   * forget: never rejects, never throws at the call site.
   */
  record(record: TurnRecord): Promise<void> {
    this.queue = this.queue
      .then(() => this.foldAndWrite(record))
      .catch((err) => {
        logger.warn(
          `outcomes: failed to record turn: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    return this.queue;
  }

  /** Drop everything (the report offers this as a "start a clean baseline" action). */
  clear(): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        this.cached = emptyOutcomeCounters();
        const file = this.filePath();
        if (!file) return;
        try {
          await fs.promises.rm(file, { force: true });
        } catch (err) {
          logger.warn(
            `outcomes: failed to clear ${file}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
      .catch(() => undefined);
    return this.queue;
  }

  private async foldAndWrite(record: TurnRecord): Promise<void> {
    const file = this.filePath();
    if (!file) return;
    const counters = recordTurn(await this.read(), record);
    // Commit in memory first: the next read then sees the increment even if the
    // disk write below fails, so a broken file cannot silently stop counting.
    this.cached = counters;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, serializeOutcomeCounters(counters), 'utf8');
    await fs.promises.rename(tmp, file);
  }
}

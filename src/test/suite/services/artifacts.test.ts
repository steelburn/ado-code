import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PRUNE_INTERVAL_MS,
  PRUNABLE_KINDS,
  classifyArtifact,
  formatPruneReport,
  planPrune,
  pruneArtifacts,
  pruneStampPath,
  resolvePrunePolicy,
  runScheduledPrune,
  scanArtifacts,
} from '../../../services/artifacts/ArtifactStore';
import type { PrunePolicy } from '../../../services/artifacts/ArtifactStore';
import {
  buildContextCostReport,
  formatContextCostReport,
} from '../../../services/artifacts/contextCost';

const DAY = 24 * 60 * 60 * 1000;

function write(root: string, rel: string, content: string, ageDays = 0): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (ageDays > 0) {
    const stamp = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(abs, stamp, stamp);
  }
  return abs;
}

function policy(
  kinds: Partial<Record<string, { maxFiles: number; maxAgeDays: number }>>,
  maxTotalBytes = 10 * 1024 * 1024
): PrunePolicy {
  return { kinds, maxTotalBytes } as PrunePolicy;
}

const aggressionPolicy = () =>
  policy(
    Object.fromEntries(PRUNABLE_KINDS.map(kind => [kind, { maxFiles: 1, maxAgeDays: 1 }]))
  );

suite('ArtifactStore — classification', () => {
  test('maps every known artifact path to its kind', () => {
    const cases: Array<[string, string]> = [
      ['.ado-code/understanding/workitem-27351.md', 'workitem-cache'],
      ['.ado-code/understanding/repo.md', 'understanding-map'],
      ['.ado-code/understanding/index.json', 'understanding-index'],
      ['.ado-code/task-draft.md', 'draft'],
      ['.ado-code/task-draft-1792086047.md', 'draft'],
      ['.ado-code/runs/run-1.out.txt', 'run-log'],
      ['.ado-code/memory/memory_handling.md', 'memory'],
      ['.ado-code/sessions/abc/mirror.json', 'session'],
      ['.ado-code/.prune-stamp.json', 'state'],
    ];
    for (const [rel, expected] of cases) {
      assert.strictEqual(classifyArtifact(rel), expected, rel);
    }
  });

  test('never claims files outside .ado-code', () => {
    assert.strictEqual(classifyArtifact('src/index.ts'), 'other');
    assert.strictEqual(classifyArtifact('AGENTS.md'), 'other');
    assert.strictEqual(classifyArtifact('ado-code/.ado-code/x'), 'other');
    assert.strictEqual(classifyArtifact('.ado-code/scratch/tmp.js'), 'other');
  });

  test('tolerates Windows separators and a leading ./', () => {
    assert.strictEqual(classifyArtifact('.ado-code\\runs\\a.log'), 'run-log');
    assert.strictEqual(classifyArtifact('./.ado-code/understanding/workitem-1.md'), 'workitem-cache');
  });
});

suite('ArtifactStore — inventory', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-artifacts-'));
  });

  teardown(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows can hold handles briefly; the temp dir is disposable. */
    }
  });

  test('summarises only what lives under .ado-code', () => {
    write(root, '.ado-code/understanding/workitem-1.md', 'a'.repeat(100));
    write(root, '.ado-code/understanding/workitem-2.md', 'b'.repeat(200));
    write(root, '.ado-code/runs/run-1.out.txt', 'c'.repeat(50));
    write(root, '.ado-code/memory/note.md', 'd'.repeat(30));
    const outside = write(root, 'README.md', 'not an artifact');

    const inventory = scanArtifacts(root);
    const kinds = inventory.entries.map(e => e.kind).sort();

    assert.deepStrictEqual(kinds, ['memory', 'run-log', 'workitem-cache', 'workitem-cache']);
    assert.strictEqual(inventory.totalCount, 4);
    assert.strictEqual(inventory.totalBytes, 380);
    assert.ok(
      !inventory.entries.some(e => path.resolve(e.absPath) === path.resolve(outside)),
      'files outside .ado-code are not artifacts'
    );
  });

  test('reports truncation instead of throwing when the entry cap bites', () => {
    for (let i = 0; i < 6; i++) {
      write(root, `.ado-code/runs/run-${i}.log`, 'x');
    }
    const inventory = scanArtifacts(root, { maxEntries: 3 });
    assert.strictEqual(inventory.truncated, true);
    assert.ok(inventory.entries.length <= 3);
  });

  test('missing state dir yields an empty inventory', () => {
    const inventory = scanArtifacts(root);
    assert.strictEqual(inventory.entries.length, 0);
    assert.strictEqual(inventory.totalCount, 0);
    assert.strictEqual(inventory.truncated, false);
  });
});

suite('ArtifactStore — prune planning', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-artifacts-'));
  });

  teardown(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* disposable temp dir */
    }
  });

  test('keeps the newest maxFiles of a prunable kind', () => {
    for (let i = 0; i < 5; i++) {
      write(root, `.ado-code/understanding/workitem-${i}.md`, 'x'.repeat(10), i);
    }
    const p = policy({ 'workitem-cache': { maxFiles: 2, maxAgeDays: 3650 } });
    const candidates = planPrune(scanArtifacts(root), p);

    assert.strictEqual(candidates.length, 3);
    const removed = candidates.map(c => c.entry.relPath).sort();
    assert.deepStrictEqual(removed, [
      '.ado-code/understanding/workitem-2.md',
      '.ado-code/understanding/workitem-3.md',
      '.ado-code/understanding/workitem-4.md',
    ]);
    assert.ok(candidates.every(c => c.reason.length > 0));
  });

  test('removes files past maxAgeDays but always keeps the newest of a kind', () => {
    for (const age of [0, 1, 2, 30, 40]) {
      write(root, `.ado-code/understanding/workitem-${age}.md`, 'x', age);
    }
    const p = policy({ 'workitem-cache': { maxFiles: 100, maxAgeDays: 7 } });
    const candidates = planPrune(scanArtifacts(root), p);

    assert.deepStrictEqual(candidates.map(c => c.entry.relPath).sort(), [
      '.ado-code/understanding/workitem-30.md',
      '.ado-code/understanding/workitem-40.md',
    ]);
  });

  test('never proposes user data or unrecognised files', () => {
    write(root, '.ado-code/memory/user-note.md', 'mine', 400);
    write(root, '.ado-code/sessions/abc/mirror.json', '{}', 400);
    write(root, '.ado-code/worktrees/run-1/file.ts', 'x', 400);
    write(root, '.ado-code/scratch/notes.txt', 'x', 400);
    write(root, '.ado-code/runs/run-old.log', 'x', 400);
    write(root, '.ado-code/runs/run-new.log', 'x', 0);

    const candidates = planPrune(scanArtifacts(root), aggressionPolicy());
    for (const candidate of candidates) {
      assert.ok(
        (PRUNABLE_KINDS as readonly string[]).includes(candidate.entry.kind),
        `should not prune ${candidate.entry.kind}: ${candidate.entry.relPath}`
      );
    }
    const removed = candidates.map(c => c.entry.relPath);
    assert.ok(!removed.includes('.ado-code/memory/user-note.md'));
    assert.ok(!removed.includes('.ado-code/scratch/notes.txt'));
    assert.ok(!removed.includes('.ado-code/worktrees/run-1/file.ts'));
  });

  test('evicts the oldest artifacts when maxTotalBytes is exceeded', () => {
    write(root, '.ado-code/runs/a.log', 'a'.repeat(400), 3);
    write(root, '.ado-code/runs/b.log', 'b'.repeat(400), 2);
    write(root, '.ado-code/runs/c.log', 'c'.repeat(400), 1);

    const p = policy(
      { 'run-log': { maxFiles: 100, maxAgeDays: 3650 } },
      900
    );
    const candidates = planPrune(scanArtifacts(root), p);

    assert.ok(candidates.length >= 1);
    assert.strictEqual(candidates[0].entry.relPath, '.ado-code/runs/a.log', 'oldest goes first');
    assert.strictEqual(candidates[0].reason, 'total-bytes');
  });
});

suite('ArtifactStore — prune execution', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-artifacts-'));
  });

  teardown(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* disposable temp dir */
    }
  });

  test('a dry run reports exactly the bytes a real run frees', () => {
    for (let i = 0; i < 5; i++) {
      write(root, `.ado-code/understanding/workitem-${i}.md`, 'x'.repeat(10), i);
    }
    const p = policy({ 'workitem-cache': { maxFiles: 2, maxAgeDays: 3650 } });

    const dry = pruneArtifacts(root, { policy: p, dryRun: true });
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(dry.deleted, 3);
    assert.strictEqual(fs.readdirSync(path.join(root, '.ado-code', 'understanding')).length, 5);

    const real = pruneArtifacts(root, { policy: p });
    assert.strictEqual(real.dryRun, false);
    assert.strictEqual(real.deleted, 3);
    assert.strictEqual(real.bytesFreed, dry.bytesFreed);
    assert.deepStrictEqual(
      fs.readdirSync(path.join(root, '.ado-code', 'understanding')).sort(),
      ['workitem-0.md', 'workitem-1.md']
    );
  });

  test('is idempotent: a second run deletes nothing', () => {
    for (let i = 0; i < 4; i++) {
      write(root, `.ado-code/task-draft-${i}.md`, 'x'.repeat(20), i);
    }
    const p = policy({ draft: { maxFiles: 2, maxAgeDays: 3650 } });

    const first = pruneArtifacts(root, { policy: p });
    assert.strictEqual(first.deleted, 2);
    assert.ok(first.bytesFreed > 0);

    const second = pruneArtifacts(root, { policy: p });
    assert.strictEqual(second.deleted, 0);
    assert.strictEqual(second.bytesFreed, 0);
    assert.strictEqual(second.candidates.length, 0);
  });

  test('keeps memory, sessions, worktrees and unrecognised files', () => {
    const keep = [
      '.ado-code/memory/user-note.md',
      '.ado-code/sessions/abc/mirror.json',
      '.ado-code/worktrees/run-1/file.ts',
      '.ado-code/scratch/notes.txt',
    ];
    for (const rel of keep) {
      write(root, rel, 'x'.repeat(50), 400);
    }

    pruneArtifacts(root, { policy: aggressionPolicy() });
    for (const rel of keep) {
      assert.ok(fs.existsSync(path.join(root, rel)), `${rel} must survive`);
    }
  });

  test('a keep-everything policy deletes nothing (disabled)', () => {
    for (let i = 0; i < 3; i++) {
      write(root, `.ado-code/understanding/workitem-${i}.md`, 'x', i);
    }
    const p = policy(
      Object.fromEntries(
        PRUNABLE_KINDS.map(kind => [kind, { maxFiles: 1000, maxAgeDays: 36500 }])
      )
    );
    const report = pruneArtifacts(root, { policy: p });
    assert.strictEqual(report.deleted, 0);
    assert.strictEqual(fs.readdirSync(path.join(root, '.ado-code', 'understanding')).length, 3);
  });

  test('300 cached work items collapse to the configured maximum', () => {
    const dir = path.join(root, '.ado-code', 'understanding');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(dir, `workitem-${i}.md`), 'x'.repeat(8));
    }
    const p = policy({ 'workitem-cache': { maxFiles: 25, maxAgeDays: 3650 } });

    const report = pruneArtifacts(root, { policy: p });
    assert.strictEqual(report.deleted, 275);
    assert.strictEqual(fs.readdirSync(dir).length, 25);
  });

  test('formatPruneReport distinguishes a dry run from a real one', () => {
    write(root, '.ado-code/understanding/workitem-1.md', 'x'.repeat(100), 5);
    write(root, '.ado-code/understanding/workitem-2.md', 'x'.repeat(100), 0);
    const p = policy({ 'workitem-cache': { maxFiles: 1, maxAgeDays: 3650 } });

    const dryText = formatPruneReport(pruneArtifacts(root, { policy: p, dryRun: true }));
    assert.ok(/dry run/i.test(dryText), dryText);
    assert.ok(dryText.includes('workitem-cache'), dryText);

    const realText = formatPruneReport(pruneArtifacts(root, { policy: p }));
    assert.ok(!/dry run/i.test(realText), realText);
  });
});

suite('ArtifactStore — policy resolution and scheduling', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-artifacts-'));
  });

  teardown(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* disposable temp dir */
    }
  });

  test('resolvePrunePolicy covers every prunable kind with sane defaults', () => {
    const resolved = resolvePrunePolicy({});
    for (const kind of PRUNABLE_KINDS) {
      const rule = resolved.kinds[kind];
      assert.ok(rule, `no rule for ${kind}`);
      assert.ok(rule!.maxFiles >= 1);
      assert.ok(rule!.maxAgeDays >= 1);
    }
    assert.ok(resolved.maxTotalBytes > 0);
  });

  test('resolvePrunePolicy applies settings and clamps nonsense to 1', () => {
    const tuned = resolvePrunePolicy({ retentionDays: 7, maxFilesPerKind: 9 });
    assert.strictEqual(tuned.kinds['workitem-cache']!.maxFiles, 9);
    assert.strictEqual(tuned.kinds['workitem-cache']!.maxAgeDays, 7);

    const clamped = resolvePrunePolicy({ retentionDays: -5, maxFilesPerKind: 0 });
    assert.strictEqual(clamped.kinds['workitem-cache']!.maxFiles, 1);
    assert.strictEqual(clamped.kinds['workitem-cache']!.maxAgeDays, 1);
  });

  test('runScheduledPrune stays silent when disabled', () => {
    write(root, '.ado-code/understanding/workitem-1.md', 'x', 10);
    write(root, '.ado-code/understanding/workitem-2.md', 'x', 9);
    const p = policy({ 'workitem-cache': { maxFiles: 1, maxAgeDays: 3650 } });

    assert.strictEqual(runScheduledPrune(root, { enabled: false, policy: p }), null);
    assert.strictEqual(fs.readdirSync(path.join(root, '.ado-code', 'understanding')).length, 2);
    assert.ok(!fs.existsSync(pruneStampPath(root)), 'a disabled prune must not stamp');
  });

  test('runScheduledPrune prunes once per interval', () => {
    write(root, '.ado-code/understanding/workitem-1.md', 'x', 10);
    write(root, '.ado-code/understanding/workitem-2.md', 'x', 9);
    const p = policy({ 'workitem-cache': { maxFiles: 1, maxAgeDays: 3650 } });
    const now = Date.now();

    const first = runScheduledPrune(root, { enabled: true, policy: p, now });
    assert.ok(first, 'first call is due');
    assert.strictEqual(first!.deleted, 1);
    assert.ok(fs.existsSync(pruneStampPath(root)), 'the run must be stamped');

    const throttled = runScheduledPrune(root, { enabled: true, policy: p, now: now + 1000 });
    assert.strictEqual(throttled, null, 'a second call inside the interval is throttled');

    const due = runScheduledPrune(root, {
      enabled: true,
      policy: p,
      now: now + PRUNE_INTERVAL_MS + 1,
    });
    assert.ok(due, 'the interval expiring makes it due again');
  });
});

suite('Context cost report', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-context-cost-'));
  });

  teardown(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* disposable temp dir */
    }
  });

  test('reports per-kind footprints, token estimates and top offenders', () => {
    write(root, '.ado-code/understanding/workitem-1.md', 'a'.repeat(400), 3);
    write(root, '.ado-code/understanding/workitem-2.md', 'b'.repeat(200), 1);
    write(root, '.ado-code/runs/run-1.out.txt', 'c'.repeat(100), 0);
    write(root, 'AGENTS.md', 'd'.repeat(120));

    const report = buildContextCostReport(root, { topN: 2 });
    const cacheRow = report.rows.find(r => r.kind === 'workitem-cache');
    assert.ok(cacheRow, 'work-item caches appear in the report');
    assert.strictEqual(cacheRow!.files, 2);
    assert.strictEqual(cacheRow!.bytes, 600);
    assert.strictEqual(cacheRow!.tokens, Math.ceil(600 / 4));

    assert.ok(report.rows.some(r => r.kind === 'agents-md'), 'AGENTS.md is costed too');
    assert.ok(report.largest.length <= 2, 'top offenders honour topN');
    assert.strictEqual(report.largest[0].relPath, '.ado-code/understanding/workitem-1.md');
    assert.ok(report.largest[0].ageDays >= 2);
  });

  test('flags a budget once usage passes its limit', () => {
    write(root, '.ado-code/memory/one.md', 'x'.repeat(200));
    write(root, '.ado-code/memory/two.md', 'y'.repeat(200));

    const tight = buildContextCostReport(root, {
      limits: { memoryMaxTotalChars: 100 },
    });
    const tightBudget = tight.budgets.find(b => /memory/i.test(b.name));
    assert.ok(tightBudget, 'a memory budget is reported');
    assert.strictEqual(tightBudget!.over, true);
    assert.ok(tightBudget!.used >= 400);

    const roomy = buildContextCostReport(root, {
      limits: { memoryMaxTotalChars: 100000 },
    });
    const roomyBudget = roomy.budgets.find(b => /memory/i.test(b.name));
    assert.strictEqual(roomyBudget!.over, false);
  });

  test('formatContextCostReport renders rows, budgets and a fix pointer', () => {
    write(root, '.ado-code/understanding/workitem-1.md', 'a'.repeat(400), 2);
    write(root, '.ado-code/memory/one.md', 'x'.repeat(200));

    const text = formatContextCostReport(buildContextCostReport(root));
    assert.ok(text.length > 100);
    assert.ok(/understanding/i.test(text), text);
    assert.ok(/memory/i.test(text), text);
    assert.ok(/token/i.test(text), text);
  });
});

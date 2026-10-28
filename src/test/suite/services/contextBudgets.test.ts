/**
 * Regression tests pinning every context/artifact budget of epic 27351
 * (ADO-27362).
 *
 * Each budget in the epic is a silent invariant: the constant reads harmless
 * and a later refactor can relax it without any test going red. This suite
 * therefore asserts the *value* of every budget AND exercises the code path it
 * governs, so both "someone changed the number" and "the code stopped honouring
 * the number" fail loudly.
 *
 * Headless: no Electron, no network, every write inside a temp directory that
 * is removed in teardown.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_MEMORY_BUDGET,
  renderMemoryBlock,
  validateMemoryEntry,
} from '../../../memory/memoryBudget';
import type { MemoryBlockEntry } from '../../../memory/memoryBudget';
import {
  DEFAULT_THREAD_BUDGET,
  DOCS_POLICY_INSTRUCTIONS,
  buildSystemPrompt,
  formatDiscussionThread,
} from '../../../llm/prompts';
import {
  MAX_DIGEST_LINES,
  digestLineCount,
  hasDigest,
  stripDigest,
  withDigest,
} from '../../../shared/docDigest';
import {
  DEFAULT_SKILL_MAX_CHARS,
  SKILL_MAX_CHARS_SETTING,
  capSkillContent,
} from '../../../shared/skillBudget';
import {
  MANAGED_END,
  MANAGED_START,
  MAX_MANAGED_BLOCK_CHARS,
  MAX_UNDERSTANDING_DIGEST_CHARS,
  buildAgentsMdContent,
  stripManagedBlock,
} from '../../../webview/agentsMd';
import {
  DEFAULT_PRUNE_POLICY,
  PRUNE_INTERVAL_MS,
  classifyArtifact,
  planPrune,
  pruneArtifacts,
  scanArtifacts,
} from '../../../services/artifacts/ArtifactStore';

const DIGEST_START = '<!-- ado-code:digest:start -->';
const DIGEST_END = '<!-- ado-code:digest:end -->';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function discussionComment(body: string): { author: string; text: string } {
  return { author: 'Mohd', text: body };
}

suite('Context budgets (epic 27351)', () => {
  suiteTeardown(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort: a lingering handle must not fail the suite */
      }
    }
  });

  // -------------------------------------------------------------------
  // The budgets themselves
  // -------------------------------------------------------------------

  test('every budget constant keeps its pinned value', () => {
    assert.deepStrictEqual(
      { ...DEFAULT_MEMORY_BUDGET },
      { maxEntries: 25, maxCharsPerEntry: 400, maxTotalChars: 4000 },
      'memory injection budget changed — update the epic docs and this pin together'
    );
    assert.deepStrictEqual(
      { ...DEFAULT_THREAD_BUDGET },
      { maxComments: 5, maxCharsPerComment: 600 }
    );
    assert.strictEqual(MAX_DIGEST_LINES, 15, 'digest header must stay short enough to read at a glance');
    assert.strictEqual(MAX_MANAGED_BLOCK_CHARS, 4000);
    assert.strictEqual(MAX_UNDERSTANDING_DIGEST_CHARS, 600);
    assert.strictEqual(DEFAULT_SKILL_MAX_CHARS, 4000);
    assert.strictEqual(SKILL_MAX_CHARS_SETTING, 'adoCode.skills.maxInjectedChars');
    assert.strictEqual(PRUNE_INTERVAL_MS, 24 * 60 * 60 * 1000);
    assert.deepStrictEqual(
      { ...DEFAULT_PRUNE_POLICY.kinds },
      {
        'workitem-cache': { maxFiles: 50, maxAgeDays: 30 },
        'run-log': { maxFiles: 20, maxAgeDays: 14 },
        draft: { maxFiles: 5, maxAgeDays: 7 },
      }
    );
    assert.strictEqual(DEFAULT_PRUNE_POLICY.maxTotalBytes, 4 * 1024 * 1024);
  });

  // -------------------------------------------------------------------
  // 1. Memory injection caps
  // -------------------------------------------------------------------

  test('memory block renders at most maxEntries entries and counts what it dropped', () => {
    const entries: MemoryBlockEntry[] = [];
    for (let i = 0; i < 40; i++) {
      entries.push({ title: `entry ${i}`, body: `body ${i}` });
    }
    const block = renderMemoryBlock('Workspace memory:', entries);

    const rendered = block.split('\n').filter((l) => /^-\s/.test(l));
    assert.strictEqual(
      rendered.length,
      DEFAULT_MEMORY_BUDGET.maxEntries,
      `expected ${DEFAULT_MEMORY_BUDGET.maxEntries} rendered entries`
    );
    assert.ok(/plus 15 more entries/.test(block), `pointer must state the dropped count:\n${block}`);
    assert.ok(block.includes('list_workspace_memory'), 'pointer must say where the rest lives');
  });

  test('memory block cuts each entry at maxCharsPerEntry', () => {
    const body = 'x'.repeat(DEFAULT_MEMORY_BUDGET.maxCharsPerEntry * 5);
    const block = renderMemoryBlock('Workspace memory:', [{ title: 'huge', body }]);
    const line = block.split('\n').find((l) => l.includes('huge')) ?? '';

    assert.ok(line.length > 0, 'the entry must still be rendered');
    assert.ok(
      line.length <= DEFAULT_MEMORY_BUDGET.maxCharsPerEntry + 120,
      `entry line is ${line.length} chars, budget is ${DEFAULT_MEMORY_BUDGET.maxCharsPerEntry}`
    );
    assert.ok(line.includes('…'), 'a cut body must be marked with an ellipsis');
  });

  test('memory block stays within maxTotalChars even with many oversized entries', () => {
    const entries: MemoryBlockEntry[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push({ title: `t${i}`, body: 'y'.repeat(2000) });
    }
    const block = renderMemoryBlock('Workspace memory:', entries);
    assert.ok(
      block.length <= DEFAULT_MEMORY_BUDGET.maxTotalChars,
      `block is ${block.length} chars, budget is ${DEFAULT_MEMORY_BUDGET.maxTotalChars}`
    );
  });

  test('no truncation marker appears while everything fits', () => {
    const block = renderMemoryBlock('Workspace memory:', [
      { title: 'small', body: 'two sentences fit easily.' },
    ]);
    assert.ok(!block.includes('plus '), 'nothing was dropped, so there must be no pointer');
    assert.ok(!block.includes('…'), 'nothing was cut, so there must be no ellipsis');
  });

  test('a single memory entry over the per-entry cap is rejected on write', () => {
    const long = 'z'.repeat(DEFAULT_MEMORY_BUDGET.maxCharsPerEntry + 1);
    const check = validateMemoryEntry(long);
    assert.strictEqual(check.ok, false);
    if (!check.ok) {
      assert.ok(
        check.error.includes('adoCode.memory.maxCharsPerEntry'),
        `the error must name the setting, got: ${check.error}`
      );
    }
  });

  // -------------------------------------------------------------------
  // 2. Work-item discussion thread truncation
  // -------------------------------------------------------------------

  test('60 comments collapse to the newest 5 with an accurate hidden count', () => {
    const comments: Array<{ author: string; text: string }> = [];
    for (let i = 0; i < 60; i++) {
      // ADO returns newest first; caller order is preserved.
      comments.push(discussionComment(`comment ${i}`));
    }
    const lines = formatDiscussionThread(comments, { workItemId: 4242 });
    const rendered = lines.filter((l) => l.includes('Mohd'));
    assert.strictEqual(rendered.length, DEFAULT_THREAD_BUDGET.maxComments);
    assert.ok(rendered[0].includes('comment 0'), 'newest comment must come first');
    assert.ok(
      lines.some((l) => l.includes('55') && l.includes('get_work_item')),
      `the hidden-comment pointer must name the count and the tool:\n${lines.join('\n')}`
    );
    assert.ok(
      lines.some((l) => l.includes('get_work_item(4242)')),
      'the pointer should reference the work item id when it is known'
    );
  });

  test('each rendered comment is cut at maxCharsPerComment', () => {
    const long = discussionComment('w'.repeat(3000));
    const lines = formatDiscussionThread([long], { budget: DEFAULT_THREAD_BUDGET });
    const rendered = lines.find((l) => l.includes('Mohd')) ?? '';
    assert.ok(rendered.length > 0);
    assert.ok(
      rendered.length <= DEFAULT_THREAD_BUDGET.maxCharsPerComment + 40,
      `comment line is ${rendered.length} chars`
    );
    assert.ok(rendered.includes('…'));
  });

  test('a short thread is rendered verbatim with no pointer', () => {
    const lines = formatDiscussionThread([discussionComment('only one')], {});
    assert.strictEqual(lines.filter((l) => l.includes('Mohd')).length, 1);
    assert.ok(!lines.some((l) => /call get_work_item/.test(l)), 'nothing hidden, nothing to point at');
  });

  // -------------------------------------------------------------------
  // 3. Artifact GC defaults, idempotency and hard-keeps
  // -------------------------------------------------------------------

  test('300 work-item caches collapse to the default maxFilesPerKind and a second run deletes nothing', () => {
    const root = tempDir('ado-budget-gc-');
    for (let i = 0; i < 300; i++) {
      const rel = `.ado-code/understanding/workitem-${1000 + i}.md`;
      assert.strictEqual(classifyArtifact(rel), 'workitem-cache', `unexpected kind for ${rel}`);
      write(path.join(root, rel), `cache ${i}\n`);
    }
    // User data must never be pruned, no matter how old.
    write(path.join(root, '.ado-code/memory/ws.md'), 'memory\n');
    write(path.join(root, '.ado-code/sessions/scope.json'), '{}\n');

    const first = pruneArtifacts(root, { policy: DEFAULT_PRUNE_POLICY });
    const remaining = scanArtifacts(root).byKind.find((k) => k.kind === 'workitem-cache');
    assert.strictEqual(remaining?.count, DEFAULT_PRUNE_POLICY.kinds['workitem-cache']!.maxFiles);
    assert.strictEqual(first.deleted, 300 - 50);

    const second = pruneArtifacts(root, { policy: DEFAULT_PRUNE_POLICY });
    assert.strictEqual(second.deleted, 0, 'a second run must be a no-op');
    assert.strictEqual(second.bytesFreed, 0);

    assert.ok(fs.existsSync(path.join(root, '.ado-code/memory/ws.md')));
    assert.ok(fs.existsSync(path.join(root, '.ado-code/sessions/scope.json')));
  });

  test('the newest artifact of a kind survives even when it is over the age cap', () => {
    const root = tempDir('ado-budget-age-');
    const old = path.join(root, '.ado-code/understanding/workitem-1.md');
    write(old, 'only cache\n');
    const stale = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, stale, stale);

    const plan = planPrune(scanArtifacts(root), DEFAULT_PRUNE_POLICY);
    assert.strictEqual(
      plan.filter((c) => c.entry.kind === 'workitem-cache').length,
      0,
      'the newest cache of its kind is always kept'
    );
  });

  test('unrecognised files under .ado-code are never proposed', () => {
    const root = tempDir('ado-budget-unknown-');
    write(path.join(root, '.ado-code/notes/scratch.md'), 'mine\n');
    write(path.join(root, '.ado-code/understanding/workitem-1.md'), 'cache\n');

    const plan = planPrune(scanArtifacts(root), DEFAULT_PRUNE_POLICY);
    assert.ok(!plan.some((c) => c.entry.relPath.includes('scratch.md')));
  });

  // -------------------------------------------------------------------
  // 4. Ephemeral drafts stage in one fixed slot
  // -------------------------------------------------------------------

  test('the draft staging paths are fixed names, not per-call unique ones', () => {
    // A regression pin rather than a behaviour test: the bug was a unique file
    // name per call, so the assertion is on the source of the paths themselves.
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../src/webview/ChatViewProvider.ts'),
      'utf8'
    );
    assert.ok(
      source.includes('task-draft.md') && source.includes('proposed-tasks.md'),
      'both staging slots must keep their fixed names'
    );
    assert.ok(
      !/task-draft-\$\{/.test(source) && !/proposed-tasks-\$\{/.test(source),
      'a sequence- or time-suffixed draft name would leak one file per call'
    );
    assert.ok(source.includes('deleteStagingFile'), 'the staging files must be cleaned up');
  });

  // -------------------------------------------------------------------
  // 5. AGENTS.md managed block budget and idempotent sync
  // -------------------------------------------------------------------

  test('the managed block stays inside its byte budget for a huge derived summary', () => {
    const root = tempDir('ado-budget-agentsmd-');
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    for (const dir of ['src', 'docs', 'scripts']) {
      write(path.join(root, dir, 'index.ts'), 'export {};\n');
    }
    const summary = Array.from({ length: 400 }, (_, i) => `- Detail line ${i} about the repository.`).join('\n');

    const content = buildAgentsMdContent(root, { summary });
    const start = content.indexOf(MANAGED_START);
    const end = content.indexOf(MANAGED_END);
    assert.ok(start !== -1 && end > start, 'the managed block must be delimited');

    const block = content.slice(start, end);
    assert.ok(
      block.length <= MAX_MANAGED_BLOCK_CHARS + 500,
      `managed block is ${block.length} chars, budget is ${MAX_MANAGED_BLOCK_CHARS}`
    );
    assert.ok(
      !block.includes('Detail line 300'),
      'the whole summary must not be inlined — only a digest of it'
    );
  });

  test('syncing twice produces byte-identical AGENTS.md and preserves user text', () => {
    const root = tempDir('ado-budget-sync-');
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    const userText = '# Notes\n\nHand-written guidance that ADO Code must not touch.\n';

    const first = buildAgentsMdContent(root, {});
    write(path.join(root, 'AGENTS.md'), userText + '\n' + first);
    const second = buildAgentsMdContent(root, {});
    const synced = userText + '\n' + second;

    assert.strictEqual(synced, userText + '\n' + first, 'a second sync must not churn the file');
    assert.ok(synced.includes('Hand-written guidance'), 'user-authored text survives');
  });

  test('stripManagedBlock removes every ADO Code-derived section and keeps the rest', () => {
    const root = tempDir('ado-budget-strip-');
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    const mine = '## Team rules\n- Run the suite before pushing.\n';
    const synced = buildAgentsMdContent(root, {}) + '\n' + mine;

    const rest = stripManagedBlock(synced);
    assert.ok(!rest.includes(MANAGED_START) && !rest.includes(MANAGED_END));
    for (const derived of [
      '## What This Is',
      '## Build & Test',
      '## Project Structure',
      '## Documentation Conventions',
      '## Repository Understanding',
    ]) {
      assert.ok(!rest.includes(derived), `${derived} is derived by ADO Code and must be stripped`);
    }
    assert.ok(rest.includes('Run the suite before pushing'), 'user sections survive the strip');
  });

  test('the understanding digest in AGENTS.md respects its own cap', () => {
    const root = tempDir('ado-budget-digest-cap-');
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    const summary = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'q'.repeat(80)}`).join('\n');
    const content = buildAgentsMdContent(root, { summary });

    const sectionIdx = content.indexOf('## Repository Understanding');
    assert.ok(sectionIdx !== -1, 'the section must exist when a summary is present');
    const section = content.slice(sectionIdx);
    assert.ok(
      section.includes('repo.md'),
      'the section must point at the full text in .ado-code/understanding/repo.md'
    );
    // The digest part is capped; the whole section is digest + pointer + notes.
    assert.ok(
      section.length <= MAX_UNDERSTANDING_DIGEST_CHARS * 3,
      `understanding section is ${section.length} chars`
    );
  });

  // -------------------------------------------------------------------
  // 6. Digest-first headers on generated artifacts
  // -------------------------------------------------------------------

  test('a digest block is recognised, counted and idempotent', () => {
    const body = '# Full document\n\n' + 'detail line\n'.repeat(400);
    const digest = [
      DIGEST_START,
      '## Digest',
      '- what this is',
      '- where the detail lives',
      DIGEST_END,
    ].join('\n');

    const once = withDigest(body, digest);
    assert.ok(hasDigest(once), 'the artifact must open with a digest');
    assert.ok(digestLineCount(once) <= MAX_DIGEST_LINES, `digest is ${digestLineCount(once)} lines`);

    const twice = withDigest(once, digest);
    assert.strictEqual(twice, once, 're-applying the digest must not stack blocks');
    assert.strictEqual(stripDigest(once).trim(), body.trim(), 'the body survives a strip');
  });

  test('digestLineCount reports 0 when there is no digest', () => {
    assert.strictEqual(digestLineCount('# plain\n\nbody'), 0);
    assert.strictEqual(hasDigest('# plain\n\nbody'), false);
  });

  // -------------------------------------------------------------------
  // 7. What the system prompt actually says
  // -------------------------------------------------------------------

  test('the system prompt carries the documentation budget policy', () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes(DOCS_POLICY_INSTRUCTIONS.trim().split('\n')[0]), 'docs policy heading missing');
    assert.ok(/generated doc/i.test(DOCS_POLICY_INSTRUCTIONS), 'the policy must talk about generated docs');
    assert.ok(
      prompt.includes(DOCS_POLICY_INSTRUCTIONS.slice(0, 80)),
      'the policy must be inlined in the prompt, not merely defined'
    );
  });

  // -------------------------------------------------------------------
  // 8. Skill injection cap
  // -------------------------------------------------------------------

  test('injected SKILL.md content is capped and points at its sub-files', () => {
    const skill = ['# Big skill', 'See [reference](reference.md) for detail.']
      .concat(Array.from({ length: 600 }, (_, i) => `Instruction line ${i}: do the thing carefully.`))
      .join('\n');
    assert.ok(skill.length > DEFAULT_SKILL_MAX_CHARS * 3);

    const capped = capSkillContent(skill);
    assert.strictEqual(capped.truncated, true);
    assert.ok(
      capped.content.length <= DEFAULT_SKILL_MAX_CHARS + 400,
      `capped content is ${capped.content.length} chars`
    );
    assert.ok(capped.content.includes(SKILL_MAX_CHARS_SETTING), 'the pointer must name the setting');
    assert.ok(capped.subFiles.includes('reference.md'), 'sub-files must be listed as pointers');
  });

  test('a small skill is injected verbatim', () => {
    const skill = '# Tiny\n\nOne instruction.';
    const capped = capSkillContent(skill);
    assert.strictEqual(capped.truncated, false);
    assert.strictEqual(capped.content, skill);
  });
});

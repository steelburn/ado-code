import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DEFAULT_MEMORY_BUDGET,
  MEMORY_SETTINGS,
  flattenMemoryText,
  readMemoryBudget,
  remainingMemoryBudget,
  renderMemoryBlock,
  truncateMemoryText,
  validateMemoryEntry,
} from '../../../memory/memoryBudget';
import { WorkspaceMemory } from '../../../memory/WorkspaceMemory';
import { createToolExecutor } from '../../../llm/tools';

const HEADER = '## Workspace Memory';

/** Write a budgeted value straight to disk, bypassing the tool-level check. */
function writeRaw(memory: WorkspaceMemory, key: string, value: string): void {
  memory.write(key, value);
}

function listKeys(memory: WorkspaceMemory): string[] {
  return memory.list();
}

suite('memory budgets', () => {
  suite('truncateMemoryText', () => {
    test('leaves text at or below the limit untouched', () => {
      assert.strictEqual(truncateMemoryText('short', 100), 'short');
      assert.strictEqual(truncateMemoryText('x'.repeat(100), 100), 'x'.repeat(100));
    });

    test('cuts longer text and marks the cut', () => {
      const out = truncateMemoryText('y'.repeat(500), 50);
      assert.strictEqual(out.length, 50);
      assert.ok(out.endsWith('…'), 'truncated text carries the marker');
    });

    test('preserves line structure (it is used for whole blocks)', () => {
      const out = truncateMemoryText('### one\n\nbody\n\n### two\n\nbody', 400);
      assert.strictEqual(out, '### one\n\nbody\n\n### two\n\nbody');
      assert.ok(out.includes('\n'));
    });

    test('never returns more than the requested characters', () => {
      for (const limit of [1, 2, 10, 41]) {
        assert.ok(truncateMemoryText('z'.repeat(200), limit).length <= limit);
      }
    });
  });

  suite('flattenMemoryText', () => {
    test('collapses every run of whitespace to a single space', () => {
      assert.strictEqual(flattenMemoryText('  one\n\n two\tthree  '), 'one two three');
    });
  });

  suite('renderMemoryBlock', () => {
    test('returns nothing for an empty entry list', () => {
      assert.strictEqual(renderMemoryBlock(HEADER, [], DEFAULT_MEMORY_BUDGET), '');
    });

    test('small memories are rendered verbatim, one line each', () => {
      const block = renderMemoryBlock(HEADER, [
        { title: 'Stack', body: 'Node + TypeScript' },
        { title: 'Tests', body: 'mocha' },
      ]);
      assert.strictEqual(block, `${HEADER}\n\n- **Stack:** Node + TypeScript\n- **Tests:** mocha`);
    });

    test('multi-line values are flattened onto one line', () => {
      const block = renderMemoryBlock(HEADER, [{ title: 'Style', body: 'no semicolons\n2 spaces' }]);
      assert.ok(block.includes('- **Style:** no semicolons 2 spaces'));
      assert.strictEqual(block.split('\n').length, 3, 'header, blank line, one entry line');
    });

    test('per-entry text is cut to maxCharsPerEntry and marked', () => {
      const block = renderMemoryBlock(HEADER, [{ title: 'Big', body: 'q'.repeat(5000) }], {
        maxEntries: 25,
        maxCharsPerEntry: 400,
        maxTotalChars: 4000,
      });
      const line = block.split('\n').find((l) => l.startsWith('- **Big:**')) as string;
      assert.ok(line, 'the entry line is present');
      assert.ok(line.endsWith('…'));
      assert.strictEqual(line.replace('- **Big:** ', '').length, 400);
      assert.ok(!block.includes('plus 1 more'), 'nothing was dropped, only shortened');
    });

    test('caps the entry count and points at the retrieval tools', () => {
      const entries = Array.from({ length: 40 }, (_, i) => ({ title: `k${i}`, body: `v${i}` }));
      const block = renderMemoryBlock(HEADER, entries, DEFAULT_MEMORY_BUDGET);
      const lines = block.split('\n').filter((l) => l.startsWith('- **'));
      assert.strictEqual(lines.length, DEFAULT_MEMORY_BUDGET.maxEntries);
      assert.ok(block.includes('_…plus 15 more entries'), 'leftovers are reported');
      assert.ok(block.includes('call list_workspace_memory'), 'pointer names the tool');
      assert.ok(block.includes('read_workspace_memory'), 'and the full-text reader');
    });

    test('singular wording for exactly one leftover entry', () => {
      const entries = Array.from({ length: 26 }, (_, i) => ({ title: `k${i}`, body: 'v' }));
      const block = renderMemoryBlock(HEADER, entries, DEFAULT_MEMORY_BUDGET);
      assert.ok(block.includes('_…plus 1 more entry'));
    });

    test('AC: 200 entries of 5000 chars inject at most 4000 chars', () => {
      const entries = Array.from({ length: 200 }, (_, i) => ({
        title: `key-${i}`,
        body: `${i}:`.padEnd(10) + 'w'.repeat(5000),
      }));
      const block = renderMemoryBlock(HEADER, entries, DEFAULT_MEMORY_BUDGET);
      assert.ok(block.length <= DEFAULT_MEMORY_BUDGET.maxTotalChars, `got ${block.length} chars`);
      assert.ok(block.length > 0);
      assert.ok(block.includes('call list_workspace_memory'));
    });

    test('honours an explicit total budget', () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({ title: `k${i}`, body: 'v'.repeat(200) }));
      const block = renderMemoryBlock(HEADER, entries, { maxEntries: 25, maxCharsPerEntry: 400, maxTotalChars: 300 });
      assert.ok(block.length <= 300, `got ${block.length} chars`);
    });

    test('returns nothing when the budget is exhausted', () => {
      const entries = [{ title: 'k', body: 'v' }];
      assert.strictEqual(renderMemoryBlock(HEADER, entries, { maxEntries: 25, maxCharsPerEntry: 400, maxTotalChars: 0 }), '');
      assert.strictEqual(renderMemoryBlock(HEADER, entries, { maxEntries: 0, maxCharsPerEntry: 400, maxTotalChars: 4000 }), '');
    });

    test('accepts a custom digest formatter', () => {
      const block = renderMemoryBlock(
        HEADER,
        [{ title: '[instruction] style', body: 's'.repeat(900) }],
        DEFAULT_MEMORY_BUDGET,
        { digest: (title, body) => `- **[${title}]:** ${body}` }
      );
      assert.ok(block.includes('- **[[instruction] style]:** ssss'));
    });

    test('uses the verbose renderer while everything fits', () => {
      const block = renderMemoryBlock(
        HEADER,
        [
          { title: 'architecture', body: '## Architecture\nMonorepo' },
          { title: 'conventions', body: '- strict mode' },
        ],
        DEFAULT_MEMORY_BUDGET,
        { verbose: (list, header) => [header, '', ...list.map((e) => `### ${e.title}\n\n${e.body}`)].join('\n') }
      );
      assert.strictEqual(
        block,
        `${HEADER}\n\n### architecture\n\n## Architecture\nMonorepo\n### conventions\n\n- strict mode`
      );
    });

    test('falls back to the digest once a budget is exceeded', () => {
      const many = Array.from({ length: 30 }, (_, i) => ({ title: `k${i}`, body: 'v' }));
      const block = renderMemoryBlock(HEADER, many, DEFAULT_MEMORY_BUDGET, {
        verbose: (list, header) => [header, '', ...list.map((e) => `### ${e.title}\n\n${e.body}`)].join('\n'),
      });
      assert.ok(!block.includes('### k0'), 'verbose shape is dropped');
      assert.ok(block.includes('- **k0:** v'));
      assert.ok(block.includes('call list_workspace_memory'));
    });
  });

  suite('remainingMemoryBudget', () => {
    test('subtracts what another block already used from the total', () => {
      const left = remainingMemoryBudget(DEFAULT_MEMORY_BUDGET, 1500);
      assert.strictEqual(left.maxTotalChars, DEFAULT_MEMORY_BUDGET.maxTotalChars - 1500);
      assert.strictEqual(left.maxEntries, DEFAULT_MEMORY_BUDGET.maxEntries);
      assert.strictEqual(left.maxCharsPerEntry, DEFAULT_MEMORY_BUDGET.maxCharsPerEntry);
    });

    test('clamps at zero rather than going negative', () => {
      assert.strictEqual(remainingMemoryBudget(DEFAULT_MEMORY_BUDGET, 99999).maxTotalChars, 0);
      assert.strictEqual(remainingMemoryBudget(DEFAULT_MEMORY_BUDGET, -50).maxTotalChars, DEFAULT_MEMORY_BUDGET.maxTotalChars);
    });
  });

  suite('validateMemoryEntry', () => {
    test('accepts an entry at the ceiling', () => {
      assert.deepStrictEqual(validateMemoryEntry('a'.repeat(DEFAULT_MEMORY_BUDGET.maxCharsPerEntry)), { ok: true });
    });

    test('rejects an oversized entry and names the setting', () => {
      const result = validateMemoryEntry('b'.repeat(DEFAULT_MEMORY_BUDGET.maxCharsPerEntry + 1));
      assert.strictEqual(result.ok, false);
      const error = (result as { ok: false; error: string }).error;
      assert.ok(error.includes(String(DEFAULT_MEMORY_BUDGET.maxCharsPerEntry)));
      assert.ok(error.includes(MEMORY_SETTINGS.maxCharsPerEntry));
      assert.ok(error.includes('shorten'), 'the error tells the model what to do');
    });

    test('measures the flattened value', () => {
      // 300 chars of text spread over lines is still under the 400 ceiling.
      const multiLine = ('line\n'.repeat(60)).trim();
      assert.deepStrictEqual(validateMemoryEntry(multiLine), { ok: true });
    });

    test('rejects empty content', () => {
      assert.strictEqual(validateMemoryEntry('   \n  ').ok, false);
    });

    test('honours a custom budget', () => {
      assert.strictEqual(validateMemoryEntry('c'.repeat(60), { maxEntries: 25, maxCharsPerEntry: 100, maxTotalChars: 4000 }).ok, true);
      assert.strictEqual(validateMemoryEntry('c'.repeat(101), { maxEntries: 25, maxCharsPerEntry: 100, maxTotalChars: 4000 }).ok, false);
    });
  });

  suite('readMemoryBudget', () => {
    const section = 'adoCode.memory';

    teardown(async () => {
      const cfg = vscode.workspace.getConfiguration(section);
      for (const key of ['maxEntries', 'maxCharsPerEntry', 'maxTotalChars']) {
        await cfg.update(key, undefined);
      }
    });

    test('falls back to the documented defaults', () => {
      assert.deepStrictEqual(readMemoryBudget(), DEFAULT_MEMORY_BUDGET);
      assert.strictEqual(DEFAULT_MEMORY_BUDGET.maxEntries, 25);
      assert.strictEqual(DEFAULT_MEMORY_BUDGET.maxCharsPerEntry, 400);
      assert.strictEqual(DEFAULT_MEMORY_BUDGET.maxTotalChars, 4000);
    });

    test('reads configured values', async () => {
      const cfg = vscode.workspace.getConfiguration(section);
      await cfg.update('maxEntries', 5);
      await cfg.update('maxCharsPerEntry', 120);
      await cfg.update('maxTotalChars', 900);
      assert.deepStrictEqual(readMemoryBudget(), { maxEntries: 5, maxCharsPerEntry: 120, maxTotalChars: 900 });
    });

    test('ignores nonsensical values', async () => {
      const cfg = vscode.workspace.getConfiguration(section);
      await cfg.update('maxEntries', 0);
      await cfg.update('maxCharsPerEntry', -3);
      await cfg.update('maxTotalChars', Number.NaN);
      const budget = readMemoryBudget();
      assert.ok(budget.maxEntries >= 1);
      assert.ok(budget.maxCharsPerEntry >= 40);
      assert.ok(budget.maxTotalChars >= 200);
    });
  });

  suite('memory write tools', () => {
    let dir: string;
    let memory: WorkspaceMemory;
    let userCalls: Array<{ key: string; category: string; content: string }>;
    let executor: ReturnType<typeof createToolExecutor>;

    setup(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-memory-tool-'));
      memory = new WorkspaceMemory(dir);
      userCalls = [];
      executor = createToolExecutor(
        {
          ado: {},
          git: {},
          changelog: {},
          skills: {},
          memory: {
            set: (key: string, category: string, content: string) => {
              userCalls.push({ key, category, content });
            },
          },
          workspaceMemory: memory,
        } as any,
        {} as any,
        {
          onApprove: async () => true,
          onUpdateState: async () => {},
          onDelegate: async () => 'delegated',
        } as any
      );
      executor.setMode('act');
    });

    teardown(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    test('write_workspace_memory rejects an oversized entry and stores nothing', async () => {
      const long = 'detail '.repeat(300);
      const result = String(await executor.execute('write_workspace_memory', { key: 'big', value: long }));
      assert.ok(result.includes('error'), `expected an error, got: ${result}`);
      assert.ok(result.includes(MEMORY_SETTINGS.maxCharsPerEntry));
      assert.deepStrictEqual(memory.list(), [], 'nothing was written');
    });

    test('write_workspace_memory stores an entry within the budget', async () => {
      const result = String(await executor.execute('write_workspace_memory', { key: 'stack', value: 'Node + TypeScript' }));
      assert.ok(!result.includes('error'), result);
      assert.strictEqual(memory.read('stack'), 'Node + TypeScript');
    });

    test('set_memory rejects an oversized entry and stores nothing', async () => {
      const result = String(
        await executor.execute('set_memory', {
          key: 'big',
          category: 'context',
          content: 'detail '.repeat(300),
        })
      );
      assert.ok(result.includes('error'), `expected an error, got: ${result}`);
      assert.ok(result.includes(MEMORY_SETTINGS.maxCharsPerEntry));
      assert.strictEqual(userCalls.length, 0, 'nothing was stored');
    });

    test('set_memory stores an entry within the budget', async () => {
      const result = String(
        await executor.execute('set_memory', { key: 'style', category: 'preference', content: 'no semicolons' })
      );
      assert.ok(!result.includes('error'), result);
      assert.strictEqual(userCalls.length, 1);
      assert.strictEqual(userCalls[0].content, 'no semicolons');
    });
  });

  suite('WorkspaceMemory injection', () => {
    let dir: string;
    let memory: WorkspaceMemory;

    setup(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-memory-budget-'));
      memory = new WorkspaceMemory(dir);
    });

    teardown(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    test('small memories render unchanged by default', () => {
      memory.write('stack', 'Node + TypeScript');
      memory.write('style', 'no semicolons');
      const prompt = memory.toPromptString();
      assert.ok(prompt.includes('Node + TypeScript'));
      assert.ok(prompt.includes('no semicolons'));
      assert.ok(!prompt.includes('list_workspace_memory'));
    });

    test('an oversized memory is capped', () => {
      for (let i = 0; i < 30; i++) {
        writeRaw(memory, `key-${i}`, 'z'.repeat(5000));
      }
      const prompt = memory.toPromptString(DEFAULT_MEMORY_BUDGET);
      assert.ok(prompt.length <= DEFAULT_MEMORY_BUDGET.maxTotalChars, `got ${prompt.length} chars`);
      assert.ok(prompt.includes('call list_workspace_memory'));
    });

    test('the stored value itself is never truncated', () => {
      const long = 'detail '.repeat(400);
      writeRaw(memory, 'long', long);
      const prompt = memory.toPromptString(DEFAULT_MEMORY_BUDGET);
      assert.ok(!prompt.includes(long), 'injection is a digest');
      assert.strictEqual(memory.read('long'), long, 'retrieval returns everything');
      assert.deepStrictEqual(listKeys(memory), ['long']);
    });

    test('honours an explicit budget', () => {
      memory.write('a', 'x'.repeat(300));
      memory.write('b', 'y'.repeat(300));
      const prompt = memory.toPromptString({ maxEntries: 25, maxCharsPerEntry: 400, maxTotalChars: 200 });
      assert.ok(prompt.length <= 200, `got ${prompt.length} chars`);
    });
  });
});

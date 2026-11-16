import * as assert from 'assert';
import {
  buildWorktreePickItems,
  pickWorktreeForReview,
  WorktreePickSource,
} from '../../../webview/worktreePicker';
import type { Services } from '../../../services';
import type { AgentRun } from '../../../agents/types';

const source = (over: Partial<WorktreePickSource> = {}): WorktreePickSource => ({
  path: '/repo/.ado-code/worktrees/run-1-claude-1',
  branch: 'ado/42-run-1',
  runId: 'run-1',
  changeCount: 0,
  ...over,
});

/** Build a Windows-style path without embedding backslash escapes. */
const windowsPath = (...segments: string[]): string =>
  segments.join(String.fromCharCode(92));

suite('webview/worktreePicker', () => {
  suite('buildWorktreePickItems', () => {
    test('lists the worktree with the most changes first', () => {
      const items = buildWorktreePickItems([
        source({ path: '/wt/run-a', branch: 'br-a', changeCount: 1 }),
        source({ path: '/wt/run-c', branch: 'br-c', changeCount: 7 }),
        source({ path: '/wt/run-b', branch: 'br-b', changeCount: 3 }),
      ]);
      assert.deepStrictEqual(
        items.map((i) => i.label),
        ['br-c', 'br-b', 'br-a']
      );
      assert.deepStrictEqual(
        items.map((i) => i.worktreePath),
        ['/wt/run-c', '/wt/run-b', '/wt/run-a']
      );
    });

    test('prefers the run title, then the branch, then the folder name', () => {
      const windowsTree = windowsPath('C:', 'repo', '.ado-code', 'worktrees', 'run-9-1');
      const items = buildWorktreePickItems([
        source({ path: windowsTree, branch: 'ado/9', runTitle: 'Fix login' }),
        source({ path: '/wt/run-2', branch: 'ado/2', runId: 'run-2' }),
        source({ path: '/wt/run-3', branch: '', runId: 'run-3' }),
      ]);
      const labelOf = (path: string) => items.find((i) => i.worktreePath === path)?.label;
      assert.strictEqual(labelOf(windowsTree), 'Fix login');
      assert.strictEqual(labelOf('/wt/run-2'), 'ado/2');
      assert.strictEqual(labelOf('/wt/run-3'), 'run-3');
    });

    test('reads the folder name from a Windows worktree path', () => {
      const winPath = windowsPath('C:', 'repo', '.ado-code', 'worktrees', 'run-5');
      const [item] = buildWorktreePickItems([source({ path: winPath, branch: '' })]);
      assert.strictEqual(item.label, 'run-5');
      assert.strictEqual(item.detail, winPath);
    });

    test('describes the change count, "no changes" for zero', () => {
      const items = buildWorktreePickItems([
        source({ path: '/wt/a', branch: 'a', changeCount: 0 }),
        source({ path: '/wt/b', branch: 'b', changeCount: 1 }),
        source({ path: '/wt/c', branch: 'c', changeCount: 4 }),
      ]);
      const byLabel = new Map(items.map((i) => [i.label, i]));
      assert.strictEqual(byLabel.get('a')?.description, 'no changes');
      assert.strictEqual(byLabel.get('b')?.description, '1 change');
      assert.strictEqual(byLabel.get('c')?.description, '4 changes');
    });

    test('reports how many changes are already applied', () => {
      const items = buildWorktreePickItems([
        source({ path: '/w/a', branch: 'a', changeCount: 3, appliedCount: 2 }),
        source({ path: '/w/b', branch: 'b', changeCount: 3, appliedCount: 0 }),
      ]);
      const byLabel = new Map(items.map((i) => [i.label, i]));
      assert.strictEqual(byLabel.get('a')?.description, '3 changes · 2 applied');
      assert.strictEqual(byLabel.get('b')?.description, '3 changes');
    });

    test('keeps the absolute path in detail so it stays matchable', () => {
      const [item] = buildWorktreePickItems([
        source({ path: '/repo/.ado-code/worktrees/run-1-claude-1', changeCount: 2 }),
      ]);
      assert.strictEqual(item.detail, '/repo/.ado-code/worktrees/run-1-claude-1');
      assert.strictEqual(item.worktreePath, '/repo/.ado-code/worktrees/run-1-claude-1');
      assert.strictEqual(item.changeCount, 2);
    });

    test('does not mutate the caller array', () => {
      const input = [
        source({ path: '/wt/a', branch: 'a', changeCount: 0 }),
        source({ path: '/wt/b', branch: 'b', changeCount: 5 }),
      ];
      buildWorktreePickItems(input);
      assert.deepStrictEqual(
        input.map((s) => s.path),
        ['/wt/a', '/wt/b']
      );
    });
  });

  suite('pickWorktreeForReview', () => {
    const fakeServices = (over: {
      listWorktrees?: () => Promise<Array<{ runId: string; path: string; branch: string }>>;
      listWorktreeChanges?: (p: string) => Promise<{ base: string; changes: any[] }>;
    }): Services =>
      ({
        git: {
          listWorktrees: over.listWorktrees ?? (async () => []),
          listWorktreeChanges:
            over.listWorktreeChanges ?? (async () => ({ base: 'main', changes: [] })),
        },
      }) as unknown as Services;

    const run = (id: string, title?: string): AgentRun =>
      ({
        id,
        agent: 'claude',
        workdir: '/wt',
        status: 'succeeded',
        startedAt: '2026-08-06T01:00:00.000Z',
        title,
      }) as AgentRun;

    test('returns the picked worktree path', async () => {
      const services = fakeServices({
        listWorktrees: async () => [
          { runId: 'run-1', path: '/wt/one', branch: 'ado/1' },
          { runId: 'run-2', path: '/wt/two', branch: 'ado/2' },
        ],
        listWorktreeChanges: async () => ({
          base: 'main',
          changes: [{ path: 'a.ts', status: 'M', pending: false }],
        }),
      });

      let pickedItems: any[] = [];
      let pickedOptions: any;
      const path = await pickWorktreeForReview(
        services,
        { listRuns: () => [run('run-1', 'First'), run('run-2', 'Second')] },
        'accept',
        {
          showQuickPick: async (items, options) => {
            pickedItems = items;
            pickedOptions = options;
            return items.find((i) => i.worktreePath === '/wt/two');
          },
        }
      );

      assert.strictEqual(path, '/wt/two');
      assert.deepStrictEqual(
        pickedItems.map((i) => i.label),
        ['First', 'Second']
      );
      assert.ok(String(pickedOptions.title).startsWith('Accept all changes'));
      assert.strictEqual(pickedOptions.matchOnDetail, true);
    });

    test('uses reject wording for the reject action', async () => {
      const services = fakeServices({
        listWorktrees: async () => [{ runId: 'run-1', path: '/wt/one', branch: 'ado/1' }],
      });
      let pickedOptions: any;
      await pickWorktreeForReview(services, undefined, 'reject', {
        showQuickPick: async (_items, options) => {
          pickedOptions = options;
          return undefined;
        },
      });
      assert.ok(String(pickedOptions.title).startsWith('Reject all changes'));
      assert.ok(String(pickedOptions.placeHolder).includes('discarded'));
    });

    test('returns undefined when the user cancels', async () => {
      const services = fakeServices({
        listWorktrees: async () => [{ runId: 'run-1', path: '/wt/one', branch: 'ado/1' }],
      });
      assert.strictEqual(
        await pickWorktreeForReview(services, undefined, 'accept', {
          showQuickPick: async () => undefined,
        }),
        undefined
      );
    });

    test('tells the user when there is no worktree to review', async () => {
      const messages: string[] = [];
      assert.strictEqual(
        await pickWorktreeForReview(fakeServices({}), undefined, 'accept', {
          showInformationMessage: async (msg) => {
            messages.push(msg);
            return undefined;
          },
        }),
        undefined
      );
      assert.strictEqual(messages.length, 1);
      assert.ok(messages[0].includes('no agent worktrees'));
    });

    test('surfaces a failure to list worktrees and stops', async () => {
      const errors: string[] = [];
      let pickerOpened = false;
      const path = await pickWorktreeForReview(
        fakeServices({
          listWorktrees: async () => {
            throw new Error('not a git repo');
          },
        }),
        undefined,
        'accept',
        {
          showErrorMessage: async (msg) => {
            errors.push(msg);
            return undefined;
          },
          showQuickPick: async (items) => {
            pickerOpened = true;
            return items[0];
          },
        }
      );
      assert.strictEqual(path, undefined);
      assert.strictEqual(pickerOpened, false);
      assert.ok(errors[0].includes('not a git repo'));
    });

    test('keeps a worktree whose change list fails, counted as zero', async () => {
      const services = fakeServices({
        listWorktrees: async () => [
          { runId: 'run-1', path: '/wt/broken', branch: 'ado/1' },
          { runId: 'run-2', path: '/wt/ok', branch: 'ado/2' },
        ],
        listWorktreeChanges: async (p) => {
          if (p === '/wt/broken') throw new Error('index.lock');
          return { base: 'main', changes: [{ path: 'a.ts', status: 'A', pending: true }] };
        },
      });

      let items: any[] = [];
      await pickWorktreeForReview(services, undefined, 'accept', {
        showQuickPick: async (list) => {
          items = list;
          return undefined;
        },
      });

      assert.deepStrictEqual(
        items.map((i) => [i.worktreePath, i.description]),
        [
          ['/wt/ok', '1 change'],
          ['/wt/broken', 'no changes'],
        ]
      );
    });
  });
});

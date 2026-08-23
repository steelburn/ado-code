import * as assert from 'assert';
import { UserMemory } from '../../../memory/UserMemory';

/**
 * Mock VS Code globalState — in-memory Map that mimics get/update.
 */
function mockGlobalState(): {
  globalState: any;
  store: Map<string, any>;
} {
  const store = new Map<string, any>();
  return {
    store,
    globalState: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: any) => { store.set(key, value); },
    },
  };
}

function createMemory(): { memory: UserMemory; store: Map<string, any> } {
  const { globalState, store } = mockGlobalState();
  return { memory: new UserMemory({ globalState } as any), store };
}

suite('UserMemory', () => {
  test('getAll returns empty array on fresh store', () => {
    const { memory } = createMemory();
    assert.deepStrictEqual(memory.getAll(), []);
  });

  test('set and getAll: creates entry', () => {
    const { memory } = createMemory();
    memory.set('code_style', 'preference', 'Use 2-space indentation');
    const entries = memory.getAll();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].key, 'code_style');
    assert.strictEqual(entries[0].category, 'preference');
    assert.strictEqual(entries[0].content, 'Use 2-space indentation');
    assert.ok(entries[0].timestamp); // timestamp set
  });

  test('set: updates existing entry with same key', () => {
    const { memory } = createMemory();
    memory.set('code_style', 'preference', 'Use tabs');
    memory.set('code_style', 'preference', 'Use 2-space indentation');
    const entries = memory.getAll();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].content, 'Use 2-space indentation');
  });

  test('set: different keys create separate entries', () => {
    const { memory } = createMemory();
    memory.set('code_style', 'preference', 'Use tabs');
    memory.set('commit_fmt', 'instruction', 'Use conventional commits');
    assert.strictEqual(memory.getAll().length, 2);
  });

  test('getByCategory filters correctly', () => {
    const { memory } = createMemory();
    memory.set('style', 'preference', 'tabs');
    memory.set('commit', 'instruction', 'conventional');
    memory.set('fix', 'correction', 'never use var');
    assert.strictEqual(memory.getByCategory('preference').length, 1);
    assert.strictEqual(memory.getByCategory('instruction').length, 1);
    assert.strictEqual(memory.getByCategory('correction').length, 1);
    assert.strictEqual(memory.getByCategory('context').length, 0);
  });

  test('delete removes entry and returns true', () => {
    const { memory } = createMemory();
    memory.set('style', 'preference', 'tabs');
    assert.strictEqual(memory.delete('style'), true);
    assert.strictEqual(memory.getAll().length, 0);
  });

  test('delete returns false for non-existent key', () => {
    const { memory } = createMemory();
    assert.strictEqual(memory.delete('nonexistent'), false);
  });

  test('clear removes all entries', () => {
    const { memory } = createMemory();
    memory.set('a', 'preference', '1');
    memory.set('b', 'instruction', '2');
    memory.set('c', 'correction', '3');
    memory.clear();
    assert.strictEqual(memory.getAll().length, 0);
  });

  test('toPromptString returns empty string when no entries', () => {
    const { memory } = createMemory();
    assert.strictEqual(memory.toPromptString(), '');
  });

  test('toPromptString formats entries as prompt text', () => {
    const { memory } = createMemory();
    memory.set('code_style', 'preference', 'Use 2-space indentation');
    memory.set('no_var', 'correction', 'Never use var, use const/let');
    const prompt = memory.toPromptString();
    assert.ok(prompt.includes('## User Memories'));
    assert.ok(prompt.includes('[preference] code_style:'));
    assert.ok(prompt.includes('Use 2-space indentation'));
    assert.ok(prompt.includes('[correction] no_var:'));
    assert.ok(prompt.includes('Never use var, use const/let'));
  });

  test('toPromptString preserves category in output', () => {
    const { memory } = createMemory();
    memory.set('a', 'instruction', 'Always run tests before committing');
    memory.set('b', 'context', 'Project uses TypeScript strict mode');
    const prompt = memory.toPromptString();
    assert.ok(prompt.includes('[instruction] a:'));
    assert.ok(prompt.includes('[context] b:'));
  });
});

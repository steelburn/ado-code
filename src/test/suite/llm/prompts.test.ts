import * as assert from 'assert';
import { buildSystemPrompt, buildAgentPrompt, wrapMemoryContext } from '../../../llm/prompts';
import { WorkItemContext } from '../../../shared/messages';

const baseItem: WorkItemContext = {
  id: 7,
  title: 'Add feature',
  description: 'desc',
  acceptanceCriteria: 'ac',
  tags: 'web',
  comments: [],
};

suite('Thread-aware prompts', () => {
  test('buildSystemPrompt omits thread section when comments empty', () => {
    const prompt = buildSystemPrompt(baseItem);
    assert.ok(!prompt.includes('Discussion thread'));
  });

  test('buildSystemPrompt includes discussion thread when populated', () => {
    const item = { ...baseItem, comments: [{ author: 'Jane BA', text: 'Please clarify X', date: '2026-08-02' }] };
    const prompt = buildSystemPrompt(item);
    assert.ok(prompt.includes('Discussion thread (latest first)'));
    assert.ok(prompt.includes('Jane BA: Please clarify X'));
  });

  test('thread order is preserved as given (ADO returns newest-first — no reverse)', () => {
    // LIVE-TEST FIX: ADO comments come back NEWEST-FIRST (id 21076637 before
    // 21076636); the prompts must NOT reverse them.
    const item = {
      ...baseItem,
      comments: [
        { author: 'Newer', text: 'second comment', date: '2026-08-02' },
        { author: 'Older', text: 'first comment', date: '2026-08-01' },
      ],
    };
    const sys = buildSystemPrompt(item);
    assert.ok(sys.indexOf('Newer: second comment') < sys.indexOf('Older: first comment'), 'system prompt keeps newest-first order');
    const agent = buildAgentPrompt(item, 'feature/ADO-7-add-feature');
    assert.ok(agent.indexOf('Newer: second comment') < agent.indexOf('Older: first comment'), 'agent prompt keeps newest-first order');
  });

  test('buildAgentPrompt includes clarifications for the agent', () => {
    const item = { ...baseItem, comments: [{ author: 'Jane BA', text: 'Use the cancel flow from spec v2', date: '2026-08-02' }] };
    const prompt = buildAgentPrompt(item, 'feature/ADO-7-add-feature');
    assert.ok(prompt.includes('Discussion thread (clarifications, latest first)'));
    assert.ok(prompt.includes('Use the cancel flow from spec v2'));
    assert.ok(prompt.includes('feature/ADO-7-add-feature'));
    assert.ok(prompt.includes('ADO-7'));
  });

  test('buildAgentPrompt without comments has no thread section', () => {
    const prompt = buildAgentPrompt(baseItem, 'feature/ADO-7-add-feature');
    assert.ok(!prompt.includes('Discussion thread'));
  });

  test('buildAgentPrompt includes memory context as instructions when provided', () => {
    const memory = '## User Memories\n\n### instruction\nAlways run the linter after editing';
    const prompt = buildAgentPrompt(baseItem, 'feature/ADO-7-add-feature', undefined, memory);
    assert.ok(prompt.includes('ADO Code Memory (instructions you MUST honor)'));
    assert.ok(prompt.includes('Always run the linter after editing'));
  });

  test('buildAgentPrompt omits the memory section when memory is empty', () => {
    const prompt = buildAgentPrompt(baseItem, 'feature/ADO-7-add-feature', undefined, '  ');
    assert.ok(!prompt.includes('ADO Code Memory'));
  });

  test('wrapMemoryContext frames memory as instructions', () => {
    const wrapped = wrapMemoryContext('do the thing');
    assert.ok(wrapped.includes('## ADO Code Memory'));
    assert.ok(wrapped.includes('do the thing'));
  });
});

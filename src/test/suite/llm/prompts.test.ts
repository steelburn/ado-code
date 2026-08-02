import * as assert from 'assert';
import { buildSystemPrompt, buildAgentPrompt } from '../../../llm/prompts';
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
});

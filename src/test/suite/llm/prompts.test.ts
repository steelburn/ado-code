import * as assert from 'assert';
import { buildSystemPrompt, buildAgentPrompt, wrapMemoryContext, buildChildChecklist, parseDeliveryReport, extractDeliveryReport } from '../../../llm/prompts';
import { generateSystemPrompt } from '../../../llm/prompts/system';
import { getDefaultMode } from '../../../llm/modes';
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

  test('buildSystemPrompt teaches the merge flow incl. conflict resolution', () => {
    const prompt = buildSystemPrompt(baseItem);
    assert.ok(prompt.includes('commit_worktree(runId)'), 'merge flow present');
    assert.ok(prompt.includes('create_pull_request(runId)'), 'PR step present');
    assert.ok(prompt.includes('resolve_pr_conflicts(runId)'), 'conflict-resolution step present');
    assert.ok(prompt.includes('mergeStatus'), 'LLM told about the mergeStatus field');
    assert.ok(prompt.includes('worktreePath'), 'LLM told the worktree-relative edit path');
  });
});

suite('Parent delegation delivery checklist', () => {
  const children = [
    { id: 101, type: 'Task', state: 'To Do', title: 'Write tests' },
    { id: 102, type: 'Task', state: 'To Do', title: 'Wire UI' },
  ];

  test('buildChildChecklist lists every child with its statuses contract', () => {
    const block = buildChildChecklist(children);
    assert.ok(block.includes('#101 [Task] [To Do] — Write tests'));
    assert.ok(block.includes('#102 [Task] [To Do] — Wire UI'));
    assert.ok(block.includes('## Delivery Report'), 'template report heading present');
    assert.ok(block.includes('DONE = fully implemented and verified'), 'statuses explained');
    assert.ok(block.includes('will be closed in ADO automatically'), 'agent told the consequence of DONE');
  });

  test('parseDeliveryReport resolves every listed child, defaulting missing to INCOMPLETE', () => {
    const report = [
      '## Delivery Report',
      '- #101: DONE',
      '- #102: BLOCKED — waiting on API keys',
    ].join('\n');
    const parsed = parseDeliveryReport(report, [101, 102, 103]);
    assert.strictEqual(parsed[101], 'DONE');
    assert.strictEqual(parsed[102], 'BLOCKED');
    assert.strictEqual(parsed[103], 'INCOMPLETE', 'unmentioned child is never assumed done');
  });

  test('parseDeliveryReport is tolerant of case, checkboxes, and emoji markers', () => {
    const report = [
      '- #101: done',
      '- #102: [x] completed',
      '- #103: [ ] not finished',
      '- #104: ✅',
      '- #105: STUCK',
    ].join('\n');
    const parsed = parseDeliveryReport(report, [101, 102, 103, 104, 105]);
    assert.strictEqual(parsed[101], 'DONE');
    assert.strictEqual(parsed[102], 'DONE');
    assert.strictEqual(parsed[103], 'INCOMPLETE');
    assert.strictEqual(parsed[104], 'DONE');
    assert.strictEqual(parsed[105], 'BLOCKED');
  });

  test('parseDeliveryReport treats "NOT DONE" as incomplete, not done', () => {
    const parsed = parseDeliveryReport('- #101: NOT DONE', [101]);
    assert.strictEqual(parsed[101], 'INCOMPLETE');
  });

  test('extractDeliveryReport returns empty when the agent never emitted one', () => {
    assert.strictEqual(extractDeliveryReport('implemented everything, no report'), '');
  });

  test('extractDeliveryReport captures the section up to the next heading', () => {
    const output = [
      'changed 10 files',
      '## Delivery Report',
      '- #101: DONE',
      '- #102: BLOCKED',
      '',
      '## Summary',
      'done',
    ].join('\n');
    const section = extractDeliveryReport(output);
    assert.ok(section.includes('- #101: DONE'));
    assert.ok(section.includes('- #102: BLOCKED'));
    assert.ok(!section.includes('## Summary'), 'section stops at the next heading');
  });
});

suite('generateSystemPrompt (chat system prompt)', () => {
  test('instructs the chat model to honor AGENTS.md when present', () => {
    const prompt = generateSystemPrompt({
      mode: getDefaultMode(),
      workspacePath: '/workspace',
      os: 'linux',
    });
    assert.ok(prompt.includes('AGENTS.md'), 'chat system prompt mentions AGENTS.md');
    assert.ok(prompt.includes('read it and honor it'), 'instructs to read and honor it');
    assert.ok(prompt.includes('workspace root'), 'scoped to the workspace root');
  });

  test('AGENTS.md instruction is conditional (honor when the file exists)', () => {
    const prompt = generateSystemPrompt({
      mode: getDefaultMode(),
      workspacePath: '/workspace',
      os: 'linux',
    });
    assert.ok(/if an `AGENTS\.md` file exists/i.test(prompt), 'conditional on the file existing');
  });

  test('read guidance: structure + docs first, lazy narrow reads (context economy)', () => {
    const prompt = generateSystemPrompt({
      mode: getDefaultMode(),
      workspacePath: '/workspace',
      os: 'linux',
    });
    assert.ok(prompt.includes('directory structure and documentation FIRST'), 'structure-first exploration taught');
    assert.ok(prompt.includes('README.md'), 'doc files named as first reads');
    assert.ok(prompt.includes('list_workspace'), 'layout mapping tool named');
    assert.ok(prompt.includes('startLine/endLine'), 'targeted read_file ranges taught');
    assert.ok(prompt.includes('avoid reading many files'), 'bulk reads discouraged');
  });

  test('buildAgentPrompt tells the agent to study structure/docs before code', () => {
    const prompt = buildAgentPrompt(baseItem, 'feature/ADO-7-add-feature');
    assert.ok(prompt.includes('directory structure and docs first'), 'delegated agents orient on docs before files');
    assert.ok(prompt.includes('read only the files you actually need'), 'lazy reads for delegated agents');
  });
});

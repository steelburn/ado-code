import * as assert from 'assert';
import {
  ZEN_STANDARDS_END,
  ZEN_STANDARDS_START,
  appendStandardsService,
  ciClauses,
  planStandardsAgentsMd,
  replaceStandardsBlock,
  runtimeClauses,
} from '../../../shared/standardsArtifacts';

/**
 * `AGENTS.md` is the only file every coding agent reads, so it is the one place a
 * clause id can be *enforced by instruction* rather than by a gate. These tests
 * keep the generated file honest: every clause id is present, each is paired with
 * the artifact that satisfies it in this stack, and the managed block is the only
 * thing a regeneration touches.
 */
suite('standardsArtifacts', () => {
  const plan = (stack: string) => ({
    projectName: 'acme',
    description: 'Acme platform',
    stack,
    services: ['users', 'orders'],
    gateway: 'gateway',
  });

  test('the clause catalogue covers every handbook clause', () => {
    assert.strictEqual(runtimeClauses('node').length, 6, 'six §4.2 clauses');
    assert.strictEqual(ciClauses().length, 7, 'seven §4.3 gates');
    const ids = [...runtimeClauses('node'), ...ciClauses()].map((clause) => clause.id);
    assert.deepStrictEqual(new Set(ids).size, ids.length, 'clause ids must be unique');
    for (const id of ids) {
      assert.match(id, /^ZEN-STD-(REPO|CON|CI)-\d\d$/, `${id} is not a clause id`);
    }
  });

  test('every clause id in the catalogue appears in the generated file', () => {
    const text = planStandardsAgentsMd(plan('node-ts'));
    for (const clause of [...runtimeClauses('node'), ...ciClauses()]) {
      assert.ok(text.includes(`\`${clause.id}\``), `AGENTS.md is missing ${clause.id}`);
    }
  });

  test('the managed block appears exactly once and holds the clause table', () => {
    const text = planStandardsAgentsMd(plan('node-ts'));
    assert.strictEqual(text.split(ZEN_STANDARDS_START).length, 2, 'one opening marker');
    assert.strictEqual(text.split(ZEN_STANDARDS_END).length, 2, 'one closing marker');
    assert.ok(
      text.indexOf(ZEN_STANDARDS_START) < text.indexOf(ZEN_STANDARDS_END),
      'markers must be ordered'
    );

    const block = text.slice(text.indexOf(ZEN_STANDARDS_START), text.indexOf(ZEN_STANDARDS_END));
    assert.ok(block.includes('| Clause | Rule | Where it is already true |'), 'the table header');

    // Structure is documented outside the managed block, so a regeneration keeps it.
    assert.ok(!block.includes('## Build & Test'), 'build instructions belong outside the block');
  });

  test('the file names the concrete artifacts of the stack it scaffolds', () => {
    const node = planStandardsAgentsMd(plan('node-ts'));
    assert.ok(node.includes('packages/shared/src/resilience.ts'), 'node stack ships the resilience kit');
    assert.ok(node.includes('packages/shared/src/health.ts'), 'node stack ships the health module');
    assert.ok(node.includes('`npm test`'), 'node test command');

    const python = planStandardsAgentsMd(plan('python'));
    assert.ok(python.includes('app/main.py'), 'python routes live in main.py');
    assert.ok(python.includes('`pytest`'), 'python test command');
    assert.ok(
      python.includes('not scaffolded'),
      'python must not claim a resilience module it does not receive'
    );
    assert.ok(!python.includes('packages/shared/src/resilience.ts'), 'no TS path in a python tree');

    assert.ok(planStandardsAgentsMd(plan('dotnet')).includes('`dotnet test`'));
    assert.ok(planStandardsAgentsMd(plan('php-laravel')).includes('`php artisan test`'));
  });

  test('the gateway and the rule set are stated', () => {
    const text = planStandardsAgentsMd(plan('node-ts'));
    assert.ok(text.includes('services/gateway/'), 'the gateway is named');
    assert.ok(text.includes('/api/v1'), 'the contract prefix is named');
    assert.ok(text.includes('Services: users, orders'), 'the services are listed');
    assert.ok(text.includes('What an agent must not do here'), 'the negative rules are stated');
  });

  test('a project with no gateway says so instead of rendering an empty path', () => {
    const text = planStandardsAgentsMd({ ...plan('node-ts'), gateway: '' });
    assert.ok(text.includes('Gateway: (none — services are exposed directly)'));
    assert.ok(!text.includes('services//'), 'no empty path segment');
  });

  test('replaceStandardsBlock keeps the prose around the managed zone', () => {
    const generated = planStandardsAgentsMd(plan('node-ts'));
    const team = `# AGENTS.md\n\nOur notes.\n\n${generated.slice(
      generated.indexOf(ZEN_STANDARDS_START),
      generated.indexOf(ZEN_STANDARDS_END) + ZEN_STANDARDS_END.length
    )}\n\nMore notes.\n`;

    const fresh = planStandardsAgentsMd(plan('python'));
    const merged = replaceStandardsBlock(team, fresh);
    assert.ok(merged.startsWith('# AGENTS.md\n\nOur notes.'), 'the header survives');
    assert.ok(merged.includes('More notes.'), 'the trailer survives');
    assert.ok(merged.includes('app/main.py'), 'the block is the python one now');
    assert.ok(!merged.includes('packages/shared/src/resilience.ts'), 'the node block is gone');
  });

  test('replaceStandardsBlock leaves an unmarked file alone', () => {
    const unmarked = '# AGENTS.md\n\nWe wrote this ourselves.\n';
    assert.strictEqual(replaceStandardsBlock(unmarked, planStandardsAgentsMd(plan('node-ts'))), unmarked);
  });

  test('appendStandardsService adds exactly one name', () => {
    const file = planStandardsAgentsMd(plan('node-ts'));
    const next = appendStandardsService(file, 'billing');
    assert.ok(next, 'the service should be appended');
    assert.ok(next!.includes('Services: users, orders, billing'));
    assert.strictEqual(appendStandardsService(next!, 'billing'), null, 'already listed, nothing to do');
  });

  test('appendStandardsService refuses to touch a file without a block', () => {
    assert.strictEqual(appendStandardsService('# AGENTS.md\n', 'billing'), null);
    assert.strictEqual(
      appendStandardsService(`${ZEN_STANDARDS_START}\n# no services line\n${ZEN_STANDARDS_END}\n`, 'billing'),
      null
    );
  });
});

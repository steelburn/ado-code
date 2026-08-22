import * as assert from 'assert';
import { WorkItemsTreeProvider } from '../../../ado/WorkItemsTreeProvider';

suite('WorkItemsTreeProvider', () => {
  test('nests expanded items under their parents and marks context nodes', () => {
    const provider = new WorkItemsTreeProvider();
    provider.refresh([
      { id: 3, title: 'My task', state: 'Active', assignedTo: 'me', workItemType: 'Task', parentId: 2, isContext: false },
      { id: 2, title: 'Parent story', state: 'Active', assignedTo: 'other', workItemType: 'User Story', parentId: 1, isContext: true },
      { id: 1, title: 'Feature', state: 'Active', assignedTo: 'other', workItemType: 'Feature', isContext: true },
    ]);

    const roots = provider.getChildren();
    assert.strictEqual(roots.length, 1, 'only the feature is a root');
    assert.strictEqual(roots[0].workItemId, 1);

    const storyNodes = provider.getChildren(roots[0]);
    assert.strictEqual(storyNodes.length, 1, 'story nests under the feature');
    assert.strictEqual(storyNodes[0].workItemId, 2);
    assert.ok(String(storyNodes[0].description).includes('context'), 'context marker on the description');

    const taskNodes = provider.getChildren(storyNodes[0]);
    assert.strictEqual(taskNodes.length, 1, 'task nests under the story');
    assert.strictEqual(taskNodes[0].workItemId, 3);
    assert.ok(!String(taskNodes[0].description).includes('context'), 'base item has no context marker');
  });

  test('filters keep the ancestor chain visible for matching items', () => {
    const provider = new WorkItemsTreeProvider();
    provider.refresh([
      { id: 3, title: 'My task', state: 'Active', assignedTo: 'me', workItemType: 'Task', parentId: 2, isContext: false },
      { id: 2, title: 'Parent story', state: 'Active', assignedTo: 'other', workItemType: 'User Story', parentId: 1, isContext: true },
      { id: 1, title: 'Feature', state: 'New', assignedTo: 'other', workItemType: 'Feature', isContext: true },
    ]);
    // Filter to Active only — the Feature (New) still shows because its
    // descendants match, so the path to the matching task stays visible.
    provider.setFilterState(['Active']);

    const roots = provider.getChildren();
    assert.strictEqual(roots.length, 1, 'feature kept as ancestor of a matching item');
    assert.strictEqual(roots[0].workItemId, 1);
    const storyNodes = provider.getChildren(roots[0]);
    assert.strictEqual(storyNodes.length, 1);
    assert.strictEqual(storyNodes[0].workItemId, 2);
  });

  test('type+title sorting orders Epic < Feature < Story < Task within siblings', () => {
    const provider = new WorkItemsTreeProvider();
    provider.refresh([
      { id: 40, title: 'Z task', state: 'Active', assignedTo: 'me', workItemType: 'Task', parentId: 10, isContext: false },
      { id: 30, title: 'A story', state: 'Active', assignedTo: 'me', workItemType: 'User Story', parentId: 10, isContext: false },
      { id: 20, title: 'B feature', state: 'Active', assignedTo: 'me', workItemType: 'Feature', parentId: 10, isContext: false },
      { id: 10, title: 'Epic', state: 'Active', assignedTo: 'me', workItemType: 'Epic', isContext: false },
    ]);
    const roots = provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].workItemId, 10, 'epic is the only root');
    const children = provider.getChildren(roots[0]);
    assert.deepStrictEqual(
      children.map(c => c.workItemId),
      [20, 30, 40],
      'Feature before Story before Task regardless of title'
    );
  });
});

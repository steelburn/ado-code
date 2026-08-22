import * as assert from 'assert';
import { WorkItemsTreeProvider, WorkItemNode, WorkItemsModeHeader } from '../../../ado/WorkItemsTreeProvider';

/** Root work item nodes, skipping the mode header row. */
function rootsOf(provider: WorkItemsTreeProvider): WorkItemNode[] {
  return provider.getChildren().filter((n): n is WorkItemNode => n instanceof WorkItemNode);
}

/** Child work item nodes of a work item node (the header never has children). */
function childrenOf(provider: WorkItemsTreeProvider, parent: WorkItemNode): WorkItemNode[] {
  return provider.getChildren(parent).filter((n): n is WorkItemNode => n instanceof WorkItemNode);
}

suite('WorkItemsTreeProvider', () => {
  test('shows a visible mode header row as the first node', () => {
    const provider = new WorkItemsTreeProvider();
    provider.refresh([
      { id: 1, title: 'Feature', state: 'Active', assignedTo: 'me', workItemType: 'Feature', isContext: false },
    ]);
    const nodes = provider.getChildren();
    assert.ok(nodes[0] instanceof WorkItemsModeHeader, 'first node is the mode header');
    const header = nodes[0] as WorkItemsModeHeader;
    assert.strictEqual(String(header.label), 'View: My Work Items', 'header shows the current mode');
    assert.strictEqual(header.contextValue, 'workItemsModeHeader', 'no work item commands match the header');
    assert.strictEqual(provider.getChildren(header).length, 0, 'header has no children');
    // Work item roots still follow the header.
    assert.strictEqual((nodes[1] as WorkItemNode).workItemId, 1);
  });

  test('setMode re-labels the header row', () => {
    const provider = new WorkItemsTreeProvider();
    provider.refresh([]);
    assert.strictEqual(provider.getMode(), 'mine', 'defaults to My Work Items');
    provider.setMode('unassigned');
    const header = provider.getChildren()[0] as WorkItemsModeHeader;
    assert.strictEqual(String(header.label), 'View: Unassigned Work Items', 'header follows the mode');
    assert.strictEqual(provider.getMode(), 'unassigned');
  });

  test('nests expanded items under their parents and marks context nodes', () => {
    const provider = new WorkItemsTreeProvider();
    provider.refresh([
      { id: 3, title: 'My task', state: 'Active', assignedTo: 'me', workItemType: 'Task', parentId: 2, isContext: false },
      { id: 2, title: 'Parent story', state: 'Active', assignedTo: 'other', workItemType: 'User Story', parentId: 1, isContext: true },
      { id: 1, title: 'Feature', state: 'Active', assignedTo: 'other', workItemType: 'Feature', isContext: true },
    ]);

    const roots = rootsOf(provider);
    assert.strictEqual(roots.length, 1, 'only the feature is a root');
    assert.strictEqual(roots[0].workItemId, 1);

    const storyNodes = childrenOf(provider, roots[0]);
    assert.strictEqual(storyNodes.length, 1, 'story nests under the feature');
    assert.strictEqual(storyNodes[0].workItemId, 2);
    assert.ok(String(storyNodes[0].description).includes('context'), 'context marker on the description');

    const taskNodes = childrenOf(provider, storyNodes[0]);
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

    const roots = rootsOf(provider);
    assert.strictEqual(roots.length, 1, 'feature kept as ancestor of a matching item');
    assert.strictEqual(roots[0].workItemId, 1);
    const storyNodes = childrenOf(provider, roots[0]);
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
    const roots = rootsOf(provider);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].workItemId, 10, 'epic is the only root');
    const children = childrenOf(provider, roots[0]);
    assert.deepStrictEqual(
      children.map(c => c.workItemId),
      [20, 30, 40],
      'Feature before Story before Task regardless of title'
    );
  });

  test('gates context menus per item: unassigned items get the unassigned menu anywhere', () => {
    const provider = new WorkItemsTreeProvider();
    provider.refresh([
      { id: 1, title: 'My feature', state: 'Active', assignedTo: 'me', workItemType: 'Feature', isContext: false },
      { id: 2, title: 'Orphan task', state: 'Active', assignedTo: '', workItemType: 'Task', parentId: 1, isContext: false },
    ]);
    const roots = rootsOf(provider);
    const feature = roots.find(r => r.workItemId === 1)!;
    assert.strictEqual(feature.contextValue, 'workItemNode', 'assigned item uses the work item menu');
    const orphan = childrenOf(provider, feature).find(c => c.workItemId === 2)!;
    assert.strictEqual(orphan.contextValue, 'unassignedWorkItemNode', 'unassigned child gets Take Ownership menu');
  });
});

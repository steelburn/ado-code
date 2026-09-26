import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { renderMarkdown } from '../../../webview/markdown';
import { WorkItemDetailPanel } from '../../../webview/WorkItemDetailPanel';
import { AgentSummaryPanel } from '../../../webview/AgentSummaryPanel';

suite('Mermaid Chart Rendering & Integration', () => {
  test('renderMarkdown preserves language class on code blocks including mermaid', () => {
    const input = '```mermaid\ngraph TD\n  A --> B\n```';
    const output = renderMarkdown(input);
    assert.ok(output.includes('<code class="language-mermaid">'), 'Output should contain language-mermaid class');
    assert.ok(output.includes('A --&gt; B') || output.includes('A --> B'), 'Output should contain diagram code');
  });

  test('renderMarkdown preserves other language classes', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const output = renderMarkdown(input);
    assert.ok(output.includes('<code class="language-typescript">'), 'Output should contain language-typescript class');
  });

  test('WorkItemDetailPanel renderAdoHtml converts markdown mermaid fences to code blocks', () => {
    const input = '<p>Here is the diagram:</p>```mermaid\nflowchart LR\n  Start --> End\n```';
    const output = (WorkItemDetailPanel as any).renderAdoHtml(input);
    assert.ok(output.includes('<pre><code class="language-mermaid">'), 'Output should contain pre with language-mermaid code block');
    assert.ok(output.includes('Start --> End'), 'Output should preserve mermaid syntax');
  });

  test('WorkItemDetailPanel renderHtml includes mermaid script and updated CSP', () => {
    const html = (WorkItemDetailPanel as any).renderHtml({
      workItemId: 1234,
      title: 'Test Work Item',
      type: 'Task',
      state: 'Active',
      stateColor: '#2196f3',
      assignedTo: 'Developer',
      creator: 'Lead',
      areaPath: 'Project\\Area',
      iterationPath: 'Project\\Iteration 1',
      createdDate: '2026-01-01',
      changedDate: '2026-01-02',
      description: '```mermaid\ngraph TD\n  A-->B\n```',
      acceptanceCriteria: '',
      tags: 'tag1;tag2',
      commentsHtml: '',
      bugFieldsHtml: '',
      mermaidScriptUri: 'vscode-webview-resource://test/mermaid.js',
      cspSource: 'vscode-webview-resource:',
    });

    assert.ok(html.includes('<script src="vscode-webview-resource://test/mermaid.js"></script>'), 'HTML should include mermaid.js script');
    assert.ok(html.includes("script-src 'unsafe-inline' vscode-webview-resource:"), 'CSP should allow script from cspSource');
  });

  test('AgentSummaryPanel renderHtml includes mermaid script and updated CSP', () => {
    const mockWebview: any = {
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: (uri: vscode.Uri) => uri.toString(),
    };
    const mockContext: any = {
      extensionUri: vscode.Uri.file('/mock/extension'),
    };
    const mockRun: any = {
      id: 'run-123',
      agent: 'claude',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
    };

    const summary = '## Summary\n```mermaid\ngraph TD\n  X-->Y\n```';
    const html = (AgentSummaryPanel as any).renderHtml(mockRun, summary, mockWebview, mockContext);

    assert.ok(html.includes('mermaid.js'), 'HTML should reference mermaid.js');
    assert.ok(html.includes("script-src 'unsafe-inline' vscode-webview-resource:"), 'CSP should allow script from cspSource');
  });

  test('ensureXmlDeclaration prepends XML header when missing', async () => {
    const { ensureXmlDeclaration } = await import('../../../webview/svgExport');
    const rawSvg = '<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>';
    const result = ensureXmlDeclaration(rawSvg);
    assert.ok(result.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'Should start with XML declaration');
    assert.ok(result.includes(rawSvg), 'Should preserve SVG content');
  });

  test('ensureXmlDeclaration keeps existing XML header intact', async () => {
    const { ensureXmlDeclaration } = await import('../../../webview/svgExport');
    const existing = '<?xml version="1.0" encoding="UTF-8"?>\n<svg></svg>';
    const result = ensureXmlDeclaration(existing);
    assert.strictEqual(result, existing);
  });

  test('promptAndSaveSvg writes file when user confirms save dialog', async () => {
    const { promptAndSaveSvg } = await import('../../../webview/svgExport');
    const origShowSaveDialog = vscode.window.showSaveDialog;

    const tmpPath = path.join(os.tmpdir(), `test-diagram-${Date.now()}.svg`);
    const tmpUri = vscode.Uri.file(tmpPath);
    (vscode.window as any).showSaveDialog = async () => tmpUri;

    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
      const success = await promptAndSaveSvg(svg, 'my-diagram');

      assert.strictEqual(success, true, 'promptAndSaveSvg should return true on success');
      const data = await vscode.workspace.fs.readFile(tmpUri);
      const text = Buffer.from(data).toString('utf8');
      assert.ok(text.startsWith('<?xml'), 'Written content should include XML declaration');
      assert.ok(text.includes('<rect/>'), 'Written content should include SVG elements');
    } finally {
      (vscode.window as any).showSaveDialog = origShowSaveDialog;
      try {
        await vscode.workspace.fs.delete(tmpUri);
      } catch {
        // ignore cleanup error
      }
    }
  });

  test('promptAndSaveSvg returns false when user cancels save dialog', async () => {
    const { promptAndSaveSvg } = await import('../../../webview/svgExport');
    const origShowSaveDialog = vscode.window.showSaveDialog;

    (vscode.window as any).showSaveDialog = async () => undefined;

    try {
      const svg = '<svg><path/></svg>';
      const success = await promptAndSaveSvg(svg, 'cancelled-diagram.svg');
      assert.strictEqual(success, false, 'promptAndSaveSvg should return false on cancellation');
    } finally {
      (vscode.window as any).showSaveDialog = origShowSaveDialog;
    }
  });

  test('AgentSummaryPanel registers onDidReceiveMessage handler for saveSvg', async () => {
    const origCreateWebviewPanel = vscode.window.createWebviewPanel;
    let messageHandler: ((msg: any) => Promise<void>) | undefined;

    (vscode.window as any).createWebviewPanel = () => ({
      webview: {
        html: '',
        cspSource: 'vscode-webview-resource:',
        asWebviewUri: (uri: vscode.Uri) => uri.toString(),
        onDidReceiveMessage: (handler: any) => {
          messageHandler = handler;
        },
      },
      reveal: () => {},
      onDidDispose: () => {},
    });

    try {
      const mockContext: any = { extensionUri: vscode.Uri.file('/mock/extension') };
      const mockRun: any = { id: `test-run-${Date.now()}`, agent: 'claude', status: 'succeeded' };
      AgentSummaryPanel.show(mockContext, mockRun, '## Summary\n```mermaid\ngraph TD\nA-->B\n```');

      assert.ok(messageHandler, 'Should have registered onDidReceiveMessage handler');

      const origShowSaveDialog = vscode.window.showSaveDialog;
      let promptCalled = false;
      (vscode.window as any).showSaveDialog = async () => {
        promptCalled = true;
        return undefined;
      };
      try {
        await messageHandler!({ type: 'saveSvg', content: '<svg></svg>' });
        assert.strictEqual(promptCalled, true, 'saveSvg message should trigger save prompt');
      } finally {
        (vscode.window as any).showSaveDialog = origShowSaveDialog;
      }
    } finally {
      (vscode.window as any).createWebviewPanel = origCreateWebviewPanel;
    }
  });

  test('WorkItemDetailPanel registers onDidReceiveMessage handler for saveSvg', async () => {
    const origCreateWebviewPanel = vscode.window.createWebviewPanel;
    let messageHandler: ((msg: any) => Promise<void>) | undefined;

    (vscode.window as any).createWebviewPanel = () => ({
      webview: {
        html: '',
        onDidReceiveMessage: (handler: any) => {
          messageHandler = handler;
        },
      },
      reveal: () => {},
      onDidDispose: () => {},
    });

    try {
      const mockContext: any = { extensionUri: vscode.Uri.file('/mock/extension') };
      const mockAdo: any = { getWorkItemWithDiscussion: async () => ({ detail: { fields: {} }, comments: [], creator: '' }) };
      WorkItemDetailPanel.show(mockContext, mockAdo, 9999);

      assert.ok(messageHandler, 'Should have registered onDidReceiveMessage handler');

      const origShowSaveDialog = vscode.window.showSaveDialog;
      let promptCalled = false;
      (vscode.window as any).showSaveDialog = async () => {
        promptCalled = true;
        return undefined;
      };
      try {
        await messageHandler!({ type: 'saveSvg', content: '<svg><rect/></svg>' });
        assert.strictEqual(promptCalled, true, 'saveSvg message should trigger save prompt in WorkItemDetailPanel');
      } finally {
        (vscode.window as any).showSaveDialog = origShowSaveDialog;
      }
    } finally {
      (vscode.window as any).createWebviewPanel = origCreateWebviewPanel;
    }
  });
});

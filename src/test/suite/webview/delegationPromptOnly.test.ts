import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';
import { runAgenticChat } from '../../../llm/agentic';
import { LlmClient } from '../../../llm/client';
import { LlmConfig, LlmMessage } from '../../../llm/types';

// AD-06 end-to-end regression: a delegation with NO active work item and NO
// selected project must run the full agentic path
//   agentic loop -> delegate_to_agent tool -> ChatViewProvider.delegateToAgent
//   -> AgentRunner.delegate(undefined, …)
// and must issue ZERO ADO API calls. The same file covers the
// `adoCode.agents.requireWorkItem` opt-out (ON = legacy guard, OFF = allowed).

const config: LlmConfig = {
  provider: 'openai',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

/** Fake ExtensionContext whose workspaceState backs a Map (like the real one). */
function makeSessionContext(): any {
  const data = new Map<string, any>();
  return {
    workspaceState: {
      get: (k: string, d?: any) => (data.has(k) ? data.get(k) : d),
      update: async (k: string, v: any) => { data.set(k, v); },
    },
  };
}

/**
 * Minimal Services bundle for the delegation path. `ado` records every call it
 * receives so the prompt-only tests can prove that NO ADO request happens.
 */
function makeServices(adoCalls: string[]): any {
  return {
    todos: {
      setActiveSession() { /* noop */ },
      rename() { /* noop */ },
      removeSession() { /* noop */ },
      removeAll() { /* noop */ },
      setGoal() { /* noop */ },
    },
    memory: { toPromptString: () => '' },
    workspaceMemory: { list: () => [], read: () => null },
    understanding: undefined,
    git: {},
    ado: {
      getDescendantWorkItems: async () => { adoCalls.push('getDescendantWorkItems'); return []; },
      getWorkItemWithDiscussion: async () => {
        adoCalls.push('getWorkItemWithDiscussion');
        return { detail: { id: 0, fields: {} }, comments: [] };
      },
      addComment: async () => { adoCalls.push('addComment'); return { id: 0 }; },
      updateWorkItem: async () => { adoCalls.push('updateWorkItem'); },
      createPullRequest: async () => { adoCalls.push('createPullRequest'); return { pullRequestId: 0, url: '' }; },
    },
  };
}

function makeProvider(adoCalls: string[]): any {
  const provider: any = new ChatViewProvider({} as any, makeServices(adoCalls), makeSessionContext());
  provider._view = { webview: { postMessage: () => { /* noop */ } } };
  return provider;
}

/** Records each delegate() call and returns a started run. */
function makeFakeRunner(calls: any[]): any {
  return {
    delegate: async (
      workItemId: number | undefined,
      prompt: string,
      agent?: string,
      title?: string,
      childIds?: number[],
    ) => {
      calls.push({ workItemId, prompt, agent, title, childIds });
      return {
        id: 'run-prompt-1',
        workItemId,
        agent: agent ?? 'fake-agent',
        title: title ?? 'Agent delegation',
        workdir: '/tmp',
        status: 'running' as const,
        startedAt: new Date().toISOString(),
      };
    },
    listRuns: () => [],
    getRunOutput: () => '',
  };
}

suite('ChatViewProvider — prompt-only delegation (AD-06)', () => {
  test('project-less path: loop → delegate_to_agent → AgentRunner(undefined) with zero ADO calls', async () => {
    const ado: string[] = [];
    const delegateCalls: any[] = [];
    const provider = makeProvider(ado);
    provider.setAgentRunner(makeFakeRunner(delegateCalls));
    // yolo mode keeps the mutating delegate_to_agent tool from popping a
    // consent card (there is no webview approval round-trip in a headless test).
    provider.executor.beginTurn();
    provider.executor.setMode('yolo');

    const fetchStub = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const sawToolResult = body.messages.some((m: any) => m.role === 'tool');
      if (!sawToolResult) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'delegate_to_agent', arguments: JSON.stringify({ prompt: 'Add a dark-mode toggle' }) },
                }],
              },
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'done' } }] }) };
    };

    const previousFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchStub;
    try {
      const messages: LlmMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'delegate this to an agent' },
      ];
      const result = await runAgenticChat(new LlmClient(config), provider.executor, messages);
      assert.strictEqual(result.text, 'done');
      assert.strictEqual(result.toolCalls.length, 1, 'the loop executed the delegate_to_agent tool');
    } finally {
      (globalThis as any).fetch = previousFetch;
    }

    assert.strictEqual(delegateCalls.length, 1, 'AgentRunner.delegate was reached exactly once');
    assert.strictEqual(delegateCalls[0].workItemId, undefined, 'prompt-only runs carry no workItemId');
    assert.ok(String(delegateCalls[0].prompt).includes('Add a dark-mode toggle'), delegateCalls[0].prompt);
    assert.deepStrictEqual(ado, [], 'the project-less path must make NO ADO API call');
  });

  test('requireWorkItem = true restores the legacy "select a work item first" guard', async () => {
    const ado: string[] = [];
    const delegateCalls: any[] = [];
    const provider = makeProvider(ado);
    provider.setAgentRunner(makeFakeRunner(delegateCalls));

    const cfg = vscode.workspace.getConfiguration('adoCode');
    await cfg.update('agents.requireWorkItem', true);
    try {
      await assert.rejects(
        () => provider.delegateToAgent('Add a dark-mode toggle'),
        /select a work item first/,
      );
      assert.strictEqual(delegateCalls.length, 0, 'the run must not start while the guard is on');
      assert.deepStrictEqual(ado, [], 'the blocked path makes no ADO call either');
    } finally {
      await cfg.update('agents.requireWorkItem', undefined);
    }
  });

  test('requireWorkItem = false (default) starts a prompt-only run', async () => {
    const ado: string[] = [];
    const delegateCalls: any[] = [];
    const provider = makeProvider(ado);
    provider.setAgentRunner(makeFakeRunner(delegateCalls));

    const cfg = vscode.workspace.getConfiguration('adoCode');
    await cfg.update('agents.requireWorkItem', false);
    try {
      const result = await provider.delegateToAgent('Add a dark-mode toggle');
      assert.strictEqual(JSON.parse(result).ok, true, 'delegation succeeded');
      assert.strictEqual(delegateCalls.length, 1);
      assert.strictEqual(delegateCalls[0].workItemId, undefined);
      assert.deepStrictEqual(ado, [], 'no ADO call on the prompt-only path');
    } finally {
      await cfg.update('agents.requireWorkItem', undefined);
    }
  });
});

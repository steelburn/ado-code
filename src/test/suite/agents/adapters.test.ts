import * as assert from 'assert';
import * as cp from 'child_process';
import { ClaudeAdapter } from '../../../agents/adapters/ClaudeAdapter';
import { GeminiAdapter } from '../../../agents/adapters/GeminiAdapter';
import { GenericAdapter } from '../../../agents/adapters/GenericAdapter';
import { AgentRun } from '../../../agents/types';

function makeRun(agent: any): AgentRun {
  return {
    id: 'run-1',
    agent,
    workdir: '/tmp/work',
    status: 'running',
    startedAt: new Date().toISOString(),
  };
}

// Stub child_process.spawn with a fake EventEmitter child
function stubSpawn(stdoutData: string, exitCode: number) {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const fakeChild: any = {
    stdout: { on: (e: string, cb: any) => { (listeners[`stdout:${e}`] ??= []).push(cb); } },
    stderr: { on: (e: string, cb: any) => { (listeners[`stderr:${e}`] ??= []).push(cb); } },
    on: (e: string, cb: any) => { (listeners[e] ??= []).push(cb); },
  };
  (cp as any).spawn = (_bin: string, args: string[], _opts: any) => {
    fakeChild.args = args;
    fakeChild.bin = _bin;
    // emit asynchronously
    setTimeout(() => {
      (listeners['stdout:data'] ?? []).forEach(cb => cb(stdoutData));
      (listeners['close'] ?? []).forEach(cb => cb(exitCode));
    }, 0);
    return fakeChild;
  };
  return fakeChild;
}

suite('AgentAdapters', () => {
  test('claude adapter builds -p args and parses session_id from JSON output', async () => {
    const child = stubSpawn(JSON.stringify({ session_id: 'sess-123', result: 'done' }), 0);
    const adapter = new ClaudeAdapter();
    const result = await adapter.runTask(makeRun('claude'), 'do the thing');
    assert.deepStrictEqual(child.args.slice(0, 2), ['-p', 'do the thing']);
    assert.ok(child.args.includes('--output-format'));
    assert.strictEqual(adapter.extractSessionId?.(JSON.stringify({ session_id: 'sess-123' })), 'sess-123');
    assert.strictEqual(result.exitCode, 0);
  });

  test('claude resumeTask requires a session id', async () => {
    const adapter = new ClaudeAdapter();
    await assert.rejects(adapter.resumeTask!(makeRun('claude'), 'follow up'), /no session id/);
  });

  test('gemini adapter builds -p and -c resume args', async () => {
    const child = stubSpawn('ok', 0);
    const adapter = new GeminiAdapter();
    await adapter.runTask(makeRun('gemini'), 'hello');
    assert.deepStrictEqual(child.args, ['-p', 'hello']);
    await adapter.resumeTask!(makeRun('gemini'), 'more');
    assert.deepStrictEqual(child.args, ['-c', 'more']);
  });

  test('generic aider adapter appends --no-git', async () => {
    const child = stubSpawn('ok', 0);
    const adapter = new GenericAdapter('aider');
    await adapter.runTask(makeRun('aider'), 'refactor');
    assert.ok(child.args.includes('--message'));
    assert.ok(child.args.includes('--no-git'));
  });

  test('generic pi adapter uses -p', async () => {
    const child = stubSpawn('ok', 0);
    const adapter = new GenericAdapter('pi');
    await adapter.runTask(makeRun('pi'), 'hi');
    assert.deepStrictEqual(child.args, ['-p', 'hi']);
  });

  test('spawn failure resolves exitCode 1 with message', async () => {
    (cp as any).spawn = (_bin: string, _args: string[], _opts: any) => {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const fakeChild: any = {
        stdout: { on: (_e: string, cb: any) => { (listeners['stdout:data'] ??= []).push(cb); } },
        stderr: { on: (_e: string, cb: any) => { (listeners['stderr:data'] ??= []).push(cb); } },
        on: (e: string, cb: any) => { (listeners[e] ??= []).push(cb); },
      };
      setTimeout(() => { (listeners['error'] ?? []).forEach(cb => cb(new Error('ENOENT'))); }, 0);
      return fakeChild;
    };
    const adapter = new GenericAdapter('pi');
    const result = await adapter.runTask(makeRun('pi'), 'x');
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.output.includes('ENOENT'));
  });
});

import * as assert from 'assert';
import { ClaudeAdapter } from '../../../agents/adapters/ClaudeAdapter';
import { GeminiAdapter } from '../../../agents/adapters/GeminiAdapter';
import { GenericAdapter } from '../../../agents/adapters/GenericAdapter';
import { AgentName, AgentRun } from '../../../agents/types';

function makeRun(agent: AgentName): AgentRun {
  return {
    id: 'run-1',
    agent,
    workdir: '/tmp/work',
    status: 'running',
    startedAt: new Date().toISOString(),
  };
}

/** Build a fake spawn function capturing args and emitting canned output. */
function fakeSpawn(stdoutData: string, exitCode: number) {
  const captured: { bin: string; args: string[] } = { bin: '', args: [] };
  const spawnFn = (bin: string, args: string[], _opts: any) => {
    captured.bin = bin;
    captured.args = args;
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const child: any = {
      stdout: { on: (e: string, cb: any) => { (listeners[`stdout:${e}`] ??= []).push(cb); } },
      stderr: { on: (e: string, cb: any) => { (listeners[`stderr:${e}`] ??= []).push(cb); } },
      on: (e: string, cb: any) => { (listeners[e] ??= []).push(cb); },
    };
    setTimeout(() => {
      (listeners['stdout:data'] ?? []).forEach(cb => cb(stdoutData));
      (listeners['close'] ?? []).forEach(cb => cb(exitCode));
    }, 0);
    return child;
  };
  return { spawnFn, captured };
}

function fakeSpawnError(message: string) {
  const spawnFn = (_bin: string, _args: string[], _opts: any) => {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const child: any = {
      stdout: { on: (_e: string, cb: any) => { (listeners['stdout:data'] ??= []).push(cb); } },
      stderr: { on: (_e: string, cb: any) => { (listeners['stderr:data'] ??= []).push(cb); } },
      on: (e: string, cb: any) => { (listeners[e] ??= []).push(cb); },
    };
    setTimeout(() => { (listeners['error'] ?? []).forEach(cb => cb(new Error(message))); }, 0);
    return child;
  };
  return spawnFn;
}

suite('AgentAdapters', () => {
  test('claude adapter builds -p args and parses session_id from JSON output', async () => {
    const { spawnFn, captured } = fakeSpawn(JSON.stringify({ session_id: 'sess-123', result: 'done' }), 0);
    const adapter = new ClaudeAdapter(spawnFn);
    const result = await adapter.runTask(makeRun('claude'), 'do the thing');
    assert.strictEqual(captured.bin, 'claude');
    assert.deepStrictEqual(captured.args.slice(0, 2), ['-p', 'do the thing']);
    assert.ok(captured.args.includes('--output-format'));
    assert.strictEqual(adapter.extractSessionId?.(JSON.stringify({ session_id: 'sess-123' })), 'sess-123');
    assert.strictEqual(result.exitCode, 0);
  });

  test('claude resumeTask requires a session id', async () => {
    const { spawnFn } = fakeSpawn('', 0);
    const adapter = new ClaudeAdapter(spawnFn);
    await assert.rejects(adapter.resumeTask!(makeRun('claude'), 'follow up'), /no session id/);
  });

  test('gemini adapter builds -p and -c resume args', async () => {
    const { spawnFn, captured } = fakeSpawn('ok', 0);
    const adapter = new GeminiAdapter(spawnFn);
    await adapter.runTask(makeRun('gemini'), 'hello');
    assert.deepStrictEqual(captured.args, ['-p', 'hello']);
    await adapter.resumeTask!(makeRun('gemini'), 'more');
    assert.deepStrictEqual(captured.args, ['-c', 'more']);
  });

  test('generic aider adapter appends --no-git', async () => {
    const { spawnFn, captured } = fakeSpawn('ok', 0);
    const adapter = new GenericAdapter('aider', spawnFn);
    await adapter.runTask(makeRun('aider'), 'refactor');
    assert.ok(captured.args.includes('--message'));
    assert.ok(captured.args.includes('--no-git'));
  });

  test('generic pi adapter uses -p', async () => {
    const { spawnFn, captured } = fakeSpawn('ok', 0);
    const adapter = new GenericAdapter('pi', spawnFn);
    await adapter.runTask(makeRun('pi'), 'hi');
    assert.deepStrictEqual(captured.args, ['-p', 'hi']);
  });

  test('spawn failure resolves exitCode 1 with message', async () => {
    const adapter = new GenericAdapter('pi', fakeSpawnError('ENOENT'));
    const result = await adapter.runTask(makeRun('pi'), 'x');
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.output.includes('ENOENT'));
  });
});

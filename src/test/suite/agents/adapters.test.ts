import * as assert from 'assert';
import { ClaudeAdapter } from '../../../agents/adapters/ClaudeAdapter';
import { DshAdapter } from '../../../agents/adapters/DshAdapter';
import { GeminiAdapter } from '../../../agents/adapters/GeminiAdapter';
import { GenericAdapter } from '../../../agents/adapters/GenericAdapter';
import { HermesAdapter } from '../../../agents/adapters/HermesAdapter';
import { PiAdapter } from '../../../agents/adapters/PiAdapter';
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
    // Throws synchronously (guard before returning the promise) — use assert.throws.
    assert.throws(() => adapter.resumeTask!(makeRun('claude'), 'follow up'), /no session id/);
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

  test('dsh adapter builds headless profile args and streams via onChunk', async () => {
    const { spawnFn, captured } = fakeSpawn('final answer', 0);
    const adapter = new DshAdapter(spawnFn);
    const chunks: string[] = [];
    const result = await adapter.runTask(makeRun('dsh'), 'implement the feature', undefined, (c) => chunks.push(c));
    assert.strictEqual(captured.bin, 'dsh');
    // `--` guard: prompts starting with `-` must not be parsed as flags.
    assert.deepStrictEqual(captured.args, ['--profile', 'headless', '--', 'implement the feature']);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output, 'final answer');
    assert.ok(chunks.join('').includes('final answer'), 'onChunk should stream output');
  });

  test('dsh adapter surfaces stderr and non-zero exit as failed output', async () => {
    const { spawnFn, captured } = fakeSpawn('', 1);
    const adapter = new DshAdapter(spawnFn);
    const result = await adapter.runTask(makeRun('dsh'), 'task');
    assert.strictEqual(captured.bin, 'dsh');
    assert.strictEqual(result.exitCode, 1);
  });

  test('dsh adapter spawn failure resolves exitCode 1 with message', async () => {
    const adapter = new DshAdapter(fakeSpawnError('ENOENT'));
    const result = await adapter.runTask(makeRun('dsh'), 'x');
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.output.includes('ENOENT'));
  });

  test('spawn failure resolves exitCode 1 with message', async () => {
    const adapter = new GenericAdapter('pi', fakeSpawnError('ENOENT'));
    const result = await adapter.runTask(makeRun('pi'), 'x');
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.output.includes('ENOENT'));
  });

  test('hermes adapter builds chat -q args and streams via onChunk', async () => {
    const { spawnFn, captured } = fakeSpawn('streaming output', 0);
    const adapter = new HermesAdapter(spawnFn);
    const chunks: string[] = [];
    const result = await adapter.runTask(makeRun('hermes'), 'hello', undefined, (c) => chunks.push(c));
    assert.strictEqual(captured.bin, 'hermes');
    assert.deepStrictEqual(captured.args, ['chat', '-q', 'hello']);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(chunks.length > 0, 'onChunk should have been called');
    assert.ok(chunks.join('').includes('streaming output'));
  });

  test('hermes resumeTask builds --continue args and streams via onChunk', async () => {
    const { spawnFn, captured } = fakeSpawn('resumed', 0);
    const adapter = new HermesAdapter(spawnFn);
    const chunks: string[] = [];
    const run = makeRun('hermes');
    run.sessionId = 'sess-456';
    await adapter.resumeTask!(run, 'follow up', undefined, (c) => chunks.push(c));
    assert.deepStrictEqual(captured.args, ['chat', '-q', 'follow up', '--continue']);
    assert.ok(chunks.join('').includes('resumed'));
  });

  test('pi adapter uses json mode and streams live progress, returns clean final text', async () => {
    const events = [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'agent_end' },
    ].map(e => JSON.stringify(e)).join('\n');
    const { spawnFn, captured } = fakeSpawn(events, 0);
    const adapter = new PiAdapter(spawnFn);
    const chunks: string[] = [];
    const result = await adapter.runTask(makeRun('pi'), 'hi', undefined, (c) => chunks.push(c));
    assert.strictEqual(captured.bin, 'pi');
    assert.deepStrictEqual(captured.args, ['-p', '--mode', 'json', 'hi']);
    assert.strictEqual(result.exitCode, 0);
    // output is the CLEAN final answer — no JSON, no progress lines
    assert.strictEqual(result.output, 'Hello');
    const live = chunks.join('');
    assert.ok(live.includes('⟳ pi: starting'), 'agent_start progress line');
    assert.ok(live.includes('⟳ thinking'), 'thinking indicator');
    assert.ok(live.includes('Hel') && live.includes('lo'), 'text deltas streamed live');
    assert.ok(!live.includes('"type"'), 'no raw JSON in the panel stream');
  });

  test('pi adapter surfaces tool execution progress and non-JSON noise', async () => {
    const events = [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 'c1', result: 'ok' },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\nplain noise line';
    const { spawnFn } = fakeSpawn(events, 0);
    const adapter = new PiAdapter(spawnFn);
    const chunks: string[] = [];
    const result = await adapter.runTask(makeRun('pi'), 'ls', undefined, (c) => chunks.push(c));
    assert.strictEqual(result.output, 'done');
    const live = chunks.join('');
    assert.ok(live.includes('⟳ tool bash'), 'tool start line');
    assert.ok(live.includes('✓ bash done'), 'tool end line');
    assert.ok(live.includes('plain noise line'), 'non-JSON line forwarded raw');
  });

  test('pi adapter surfaces LLM error as output when no text answer', async () => {
    const events = [
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' } },
    ].map(e => JSON.stringify(e)).join('\n');
    const { spawnFn } = fakeSpawn(events, 0);
    const adapter = new PiAdapter(spawnFn);
    const result = await adapter.runTask(makeRun('pi'), 'hi');
    assert.strictEqual(result.output, 'rate limited');
  });
});

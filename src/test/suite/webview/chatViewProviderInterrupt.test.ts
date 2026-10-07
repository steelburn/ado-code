import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

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

function makeServices(overrides: Record<string, any> = {}): any {
  return {
    todos: {
      setActiveSession() { /* noop */ },
      rename() { /* noop */ },
      removeSession() { /* noop */ },
      removeAll() { /* noop */ },
      setGoal() { /* noop */ },
    },
    ...overrides,
  };
}

function makeProvider(): any {
  const provider: any = new ChatViewProvider({} as any, makeServices(), makeSessionContext());
  provider._view = { webview: { postMessage: () => { /* noop */ } } };
  return provider;
}

suite('ChatViewProvider — interrupt-on-message', () => {
  test('interruptRunningTool aborts the in-flight tool signal', () => {
    const provider = makeProvider();
    const ctrl = new AbortController();
    provider.toolInterrupt = ctrl;
    assert.strictEqual(ctrl.signal.aborted, false);
    provider.interruptRunningTool();
    assert.strictEqual(ctrl.signal.aborted, true);
  });

  test('interruptRunningTool is a no-op when no tool is in flight', () => {
    const provider = makeProvider();
    provider.toolInterrupt = undefined;
    assert.doesNotThrow(() => provider.interruptRunningTool());
  });

  test('toolSignalForRun reuses the signal, then recreates it after an interrupt', () => {
    const provider = makeProvider();
    provider.toolInterrupt = new AbortController();
    const first = provider.toolSignalForRun();
    assert.strictEqual(provider.toolSignalForRun(), first, 'same signal while not aborted');
    provider.interruptRunningTool();
    const second = provider.toolSignalForRun();
    assert.notStrictEqual(second, first, 'a fresh signal after the interrupt');
    assert.strictEqual(second.aborted, false, 'the new signal is not pre-aborted');
  });

  test('a steer message buffers the text AND interrupts the in-flight tool', async () => {
    const provider = makeProvider();
    const ctrl = new AbortController();
    provider.toolInterrupt = ctrl;
    await provider.handleWebviewMessage({ type: 'steerMessage', content: 'stop that' });
    assert.strictEqual(ctrl.signal.aborted, true);
    assert.deepStrictEqual(provider.pendingSteer, ['stop that']);
  });
});

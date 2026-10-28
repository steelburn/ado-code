import * as assert from 'assert';

import type { Services } from '../../../services';
import { StatusPanelProvider } from '../../../webview/StatusPanelProvider';

/**
 * R-P1-09 — the STATUS tree gains one "Remote Access" row.
 *
 * The row reads the *runtime* state off RemoteControl rather than the setting
 * alone, because the setting says what the user asked for while the state says
 * what is actually listening.
 */

function fakeServices(): Services {
  // The provider wraps every block in try/catch, so a shell with only the
  // members the remote row needs is enough: absent services simply contribute
  // no rows.
  return {
    agents: { detect: async () => [] },
    memory: { getAll: () => [] },
    workspaceMemory: { list: () => [] },
    mcp: { getConnectedServers: () => [] },
  } as unknown as Services;
}

function findRemoteRow(items: Array<{ label?: unknown }>): Array<{ label?: unknown }> {
  return items.filter((item) => String(item.label ?? '').startsWith('Remote Access'));
}

suite('statusPanelRemote', () => {
  test('the row is present and reads Off before Remote Access starts', async () => {
    const provider = new StatusPanelProvider(fakeServices());
    provider.setRemoteAccess({ currentState: 'off', deviceCount: 0 });

    const rows = findRemoteRow(await provider.getChildren());
    assert.strictEqual(rows.length, 1, 'exactly one Remote Access row');
    const row = rows[0] as Record<string, unknown>;
    assert.strictEqual(row.label, 'Remote Access: Off');
    assert.strictEqual(row.contextValue, 'remoteAccessOff');
    assert.strictEqual(row.description, undefined);
    assert.strictEqual((row.iconPath as { id?: string }).id, 'radio-tower');
  });

  test('an enabled control maps to On with the device count as description', async () => {
    const provider = new StatusPanelProvider(fakeServices());
    provider.setRemoteAccess({ currentState: 'on', deviceCount: 2 });

    const row = findRemoteRow(await provider.getChildren())[0] as Record<string, unknown>;
    assert.strictEqual(row.label, 'Remote Access: On');
    assert.strictEqual(row.contextValue, 'remoteAccessOn');
    assert.strictEqual(row.description, '2 device(s)');
    assert.strictEqual((row.iconPath as { id?: string }).id, 'broadcast');
  });

  test('a starting or failed control still reads Off', async () => {
    for (const state of ['starting', 'error'] as const) {
      const provider = new StatusPanelProvider(fakeServices());
      provider.setRemoteAccess({ currentState: state, deviceCount: 0 });
      const row = findRemoteRow(await provider.getChildren())[0] as Record<string, unknown>;
      assert.strictEqual(row.label, 'Remote Access: Off', `state ${state} reads Off`);
      assert.strictEqual(row.contextValue, 'remoteAccessOff');
    }
  });

  test('clicking the row opens the QR panel', async () => {
    const provider = new StatusPanelProvider(fakeServices());
    provider.setRemoteAccess({ currentState: 'on', deviceCount: 1 });
    const row = findRemoteRow(await provider.getChildren())[0] as Record<string, unknown>;
    const command = row.command as { command: string };
    assert.strictEqual(command.command, 'adoCode.remote.showQr');
  });
});

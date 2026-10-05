import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

/**
 * Minimal workspaceState mock with `keys()` so the project-scoped session
 * migration path can be exercised (unlike the plain mock in conversation.test.ts).
 */
function makeProvider(saved: Record<string, any> = {}) {
  const provider = new ChatViewProvider(
    { fsPath: '/tmp/x' } as any,
    // Minimal Services-shaped stub: the To-do store is out of scope for these tests.
    { todos: { setActiveSession() {}, rename() {}, setGoal() {} } } as any,
    {
      workspaceState: {
        get: (k: string, defaultVal?: any) => saved[k] ?? defaultVal,
        update: async (k: string, v: any) => {
          if (v === undefined) delete saved[k];
          else saved[k] = v;
        },
        keys: () => Object.keys(saved),
      },
    } as any
  );
  (provider as any).postMessage = () => undefined;
  return provider;
}

suite('Session scoping (folder-scoped key)', () => {
  test('sessionKey is folder-scoped and excludes the active project', () => {
    // In the test env vscode.workspace.workspaceFolders is undefined → folder = 'default'.
    const provider = makeProvider();
    assert.strictEqual(
      (provider as any).sessionKey,
      'default',
      'sessionKey must not include the active ADO project'
    );
  });

  test('switching the active ADO project does NOT mint a new session id', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);

    (provider as any).activeProject = () => 'ProjectA';
    await provider.createNewSession();
    const idAfterCreate = (provider as any).getActiveSessionId();
    assert.ok(idAfterCreate, 'a session id was created');

    // Simulate the active project changing (org switch / work-item open / settings settle).
    (provider as any).activeProject = () => 'ProjectB';
    await (provider as any).ensureSession('next turn');

    assert.strictEqual(
      (provider as any).getActiveSessionId(),
      idAfterCreate,
      'the same session id must remain active across a project switch'
    );
  });

  test('the active session id is persisted under a project-independent key', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);

    (provider as any).activeProject = () => 'ProjectA';
    await provider.createNewSession();

    assert.ok(
      saved['adoCode.activeSessionId:default'],
      'active id persisted under the folder-scoped key'
    );
    assert.strictEqual(
      Object.keys(saved).some(k => k.startsWith('adoCode.activeSessionId:default:')),
      false,
      'no project-scoped active-id key is written'
    );
  });

  test('a new session records the active project as an attribute', async () => {
    const provider = makeProvider();
    (provider as any).activeProject = () => 'ProjectA';

    await provider.createNewSession();

    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].project, 'ProjectA');
  });

  test('migrateProjectScopedSessions folds legacy project buckets into the folder bucket', async () => {
    const legacySession = {
      id: '2020-01-01T00:00:00.000Z',
      name: 'Old chat',
      createdAt: '2020-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const saved: Record<string, any> = {
      'adoCode.sessions:default:ProjectA': [legacySession],
      'adoCode.activeSessionId:default:ProjectA': legacySession.id,
    };
    const provider = makeProvider(saved);

    await (provider as any).migrateProjectScopedSessions();

    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].id, legacySession.id);

    // Legacy keys are gone after migration.
    assert.strictEqual(saved['adoCode.sessions:default:ProjectA'], undefined);
    assert.strictEqual(saved['adoCode.activeSessionId:default:ProjectA'], undefined);
  });
});

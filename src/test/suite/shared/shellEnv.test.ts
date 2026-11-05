import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  createShellEnvCache,
  extractPath,
  findOnPath,
  isOnPath,
  lookupCommand,
  mergePathValues,
  resolveShellEnv,
  pathValueOf,
  withPath,
} from '../../../shared/shellEnv';

// Guards the /new-project dependency check running WITHOUT a VS Code restart.
//
// A toolchain installed after VS Code started only appears on the PATH of a
// *new* process, so `shellEnv.ts` asks a fresh shell (win32: the persisted
// registry values) and merges the result into the inherited block. Every piece
// below is pure or stub-driven: no test here spawns a shell.

suite('shellEnv — reading the fresh PATH out of a chatty shell', () => {
  test('extracts the marked value and ignores banner noise', () => {
    const output = [
      'Now using node v20.11.0 (npm v10.2.4)',
      'bash: no job control in this shell',
      '__ADO_PATH__/home/me/.nvm/versions/node/v20/bin:/usr/bin__ADO_END__',
    ].join('\n');
    assert.strictEqual(extractPath(output), '/home/me/.nvm/versions/node/v20/bin:/usr/bin');
  });

  test('a shell running with set -x echoes the command; the real value wins', () => {
    const output = [
      "+ printf '__ADO_PATH__%s__ADO_END__' /usr/bin:/bin",
      '__ADO_PATH__/usr/bin:/bin__ADO_END__',
    ].join('\n');
    assert.strictEqual(extractPath(output), '/usr/bin:/bin');
  });

  test('no marker, empty value or truncated output yields undefined', () => {
    assert.strictEqual(extractPath(''), undefined);
    assert.strictEqual(extractPath('command not found: powershell.exe'), undefined);
    assert.strictEqual(extractPath('__ADO_PATH__   __ADO_END__'), undefined);
    assert.strictEqual(extractPath('__ADO_PATH__/usr/bin'), undefined);
  });
});

suite('shellEnv — lookup command per platform', () => {
  test('win32 reads Machine + User PATH from the registry', () => {
    const command = lookupCommand('win32');
    assert.ok(command, 'a command is produced');
    assert.strictEqual(command!.cmd, 'powershell.exe');
    const script = command!.args[command!.args.length - 1];
    assert.ok(script.includes("GetEnvironmentVariable('Path','Machine')"), script);
    assert.ok(script.includes("GetEnvironmentVariable('Path','User')"), script);
    assert.ok(command!.args.includes('-NoProfile'), 'no profile: a slow lookup would time out');
    assert.ok(command!.args.includes('-NonInteractive'));
  });

  test('posix uses the login + interactive shell so profiles are re-read', () => {
    const command = lookupCommand('linux', { SHELL: '/usr/bin/zsh' });
    assert.ok(command, 'a command is produced');
    assert.strictEqual(command!.cmd, '/usr/bin/zsh');
    assert.deepStrictEqual(command!.args.slice(0, 3), ['-l', '-i', '-c']);
    assert.ok(command!.args[3].includes('$PATH'), command!.args[3]);
  });

  test('posix falls back to /bin/sh when SHELL is missing', () => {
    assert.strictEqual(lookupCommand('darwin', {})!.cmd, '/bin/sh');
  });
});

suite('shellEnv — merging a fresh PATH into the inherited one', () => {
  test('fresh entries lead, inherited-only entries are kept, duplicates dropped', () => {
    const merged = mergePathValues(
      '/home/me/.local/bin:/usr/bin',
      '/usr/bin:/opt/vscode-cli',
      'linux',
    );
    assert.strictEqual(merged, '/home/me/.local/bin:/usr/bin:/opt/vscode-cli');
  });

  test('win32 dedupes case-insensitively and unwraps quoted entries', () => {
    const merged = mergePathValues(
      '"C:\\Program Files\\nodejs";C:\\Windows',
      'c:\\program files\\NODEJS;D:\\tools',
      'win32',
    );
    assert.strictEqual(merged, 'C:\\Program Files\\nodejs;C:\\Windows;D:\\tools');
  });

  test('separator follows the platform', () => {
    assert.strictEqual(mergePathValues('/a', '/b', 'linux'), '/a:/b');
    assert.strictEqual(mergePathValues('C:\\a', 'C:\\b', 'win32'), 'C:\\a;C:\\b');
  });
});

suite('shellEnv — collapsing PATH-ish keys', () => {
  test('one key survives, holding the merged value; the rest is untouched', () => {
    const out = withPath({ Path: 'C:\\old', FOO: 'bar' }, 'C:\\new', 'win32');
    assert.strictEqual(out.Path, 'C:\\new');
    assert.strictEqual(out.FOO, 'bar');
    assert.deepStrictEqual(Object.keys(out).filter(k => /^path$/i.test(k)), ['Path']);
  });

  test('a case variant does not survive as a second key', () => {
    const out = withPath({ PATH: '/old' } as NodeJS.ProcessEnv, '/new', 'win32');
    assert.strictEqual(Object.keys(out).filter(k => /^path$/i.test(k)).length, 1);
    assert.strictEqual(out.PATH, '/new');
  });
});

suite('shellEnv — resolveShellEnv', () => {
  const base = { SHELL: '/bin/bash', PATH: '/usr/bin', HOME: '/home/me' };

  test('returns the base environment with the fresh PATH merged in', async () => {
    const env = await resolveShellEnv({
      platform: 'linux',
      base,
      run: async () => '__ADO_PATH__/home/me/.local/bin:/usr/bin__ADO_END__',
    });
    assert.ok(env, 'resolved');
    assert.strictEqual(env!.PATH, '/home/me/.local/bin:/usr/bin');
    assert.strictEqual(env!.HOME, '/home/me');
    assert.strictEqual(env!.SHELL, '/bin/bash');
  });

  test('a silent lookup falls back to undefined (the inherited block)', async () => {
    assert.strictEqual(await resolveShellEnv({ platform: 'linux', base, run: async () => '' }), undefined);
  });

  test('a throwing runner never escapes', async () => {
    const env = await resolveShellEnv({
      platform: 'linux',
      base,
      run: async () => {
        throw new Error('spawn failed');
      },
    });
    assert.strictEqual(env, undefined);
  });

  test('win32 expands %VAR% left in the registry value', async () => {
    const env = await resolveShellEnv({
      platform: 'win32',
      base: { Path: 'D:\\vscode-cli', SystemRoot: 'C:\\Windows' } as NodeJS.ProcessEnv,
      run: async () => '__ADO_PATH__%SystemRoot%\\system32;C:\\tools__ADO_END__',
    });
    assert.ok(env, 'resolved');
    // Expanded (a new process would expand it too) and the inherited entry kept.
    assert.strictEqual(env!.Path, 'C:\\Windows\\system32;C:\\tools;D:\\vscode-cli');
  });
});

suite('pathValueOf / findOnPath / isOnPath', () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ado-shellenv-'));
  }

  test('pathValueOf matches the key case-insensitively', () => {
    assert.strictEqual(pathValueOf({ Path: 'C:\\a' } as NodeJS.ProcessEnv), 'C:\\a');
    assert.strictEqual(pathValueOf({ PATH: '/a' } as NodeJS.ProcessEnv), '/a');
    assert.strictEqual(pathValueOf({ PATH: '   ' } as NodeJS.ProcessEnv), undefined);
    assert.strictEqual(pathValueOf({} as NodeJS.ProcessEnv), undefined);
  });

  // The whole point: a binary only a *new* process can see is still found.
  test('finds an executable in a fresh-PATH directory', () => {
    const dir = tempDir();
    try {
      const bin = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
      fs.writeFileSync(path.join(dir, bin), '');
      const env = { Path: dir } as NodeJS.ProcessEnv;
      assert.strictEqual(isOnPath(env, 'cloudflared'), true);
      assert.strictEqual(isOnPath(env, 'somethingelse'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('win32 tries the .cmd / .bat / bare candidates', () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'tool.cmd'), '');
      const env = { Path: dir } as NodeJS.ProcessEnv;
      assert.strictEqual(isOnPath(env, 'tool', 'win32'), true);
      assert.strictEqual(isOnPath(env, 'tool', 'linux'), false, 'no extensionless file exists');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty or missing PATH is false, not a throw', () => {
    assert.strictEqual(isOnPath({} as NodeJS.ProcessEnv, 'cloudflared'), false);
    assert.strictEqual(isOnPath({ PATH: '' } as NodeJS.ProcessEnv, 'cloudflared'), false);
  });

  test('findOnPath returns the file it found, so a caller can spawn it by path', () => {
    const dir = tempDir();
    try {
      const bin = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
      const target = path.join(dir, bin);
      fs.writeFileSync(target, '');
      const env = { Path: dir } as NodeJS.ProcessEnv;
      assert.strictEqual(findOnPath(env, 'cloudflared'), target);
      assert.strictEqual(findOnPath(env, 'nope'), undefined);
      assert.strictEqual(findOnPath({} as NodeJS.ProcessEnv, 'cloudflared'), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('createShellEnvCache', () => {
  const OUTPUT = 'banner\n__ADO_PATH__/fresh/bin__ADO_END__\n';

  function rig(opts: { throws?: boolean; ttlMs?: number; clock?: () => number } = {}) {
    const state = { calls: 0, clock: opts.clock ?? (() => 0) };
    const cache = createShellEnvCache({
      platform: 'linux',
      base: { SHELL: '/bin/sh', PATH: '/inherited/bin' } as NodeJS.ProcessEnv,
      ttlMs: opts.ttlMs ?? 1_000,
      now: () => state.clock(),
      run: async () => {
        state.calls += 1;
        if (opts.throws) {
          throw new Error('shell exploded');
        }
        return OUTPUT;
      },
    });
    return { cache, state };
  }

  test('resolves the fresh PATH once and merges the inherited block', async () => {
    const { cache, state } = rig();
    const env = await cache.get();
    assert.strictEqual(state.calls, 1);
    assert.ok(env?.PATH?.includes('/fresh/bin'), 'fresh entry present');
    assert.ok(env?.PATH?.includes('/inherited/bin'), 'inherited entry kept');
    assert.strictEqual(cache.peek(), env, 'peek() exposes the resolved value');
  });

  test('concurrent callers share one lookup', async () => {
    const { cache, state } = rig();
    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
    assert.strictEqual(state.calls, 1);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  test('a lookup inside the TTL is reused, one after it is redone', async () => {
    let clock = 0;
    const { cache, state } = rig({ clock: () => clock });
    await cache.get();
    assert.strictEqual(state.calls, 1);
    clock = 900;
    await cache.get();
    assert.strictEqual(state.calls, 1, 'within the TTL: cached');
    clock = 1_500;
    await cache.get();
    assert.strictEqual(state.calls, 2, 'after the TTL: a binary installed meanwhile is found');
  });

  test('clear() forces the next get() to resolve again', async () => {
    const { cache, state } = rig();
    await cache.get();
    cache.clear();
    assert.strictEqual(cache.peek(), undefined);
    await cache.get();
    assert.strictEqual(state.calls, 2);
  });

  test('a failed lookup resolves undefined instead of throwing', async () => {
    const { cache, state } = rig({ throws: true });
    assert.strictEqual(await cache.get(), undefined);
    assert.strictEqual(cache.peek(), undefined);
    await cache.get();
    assert.strictEqual(state.calls, 2, 'a failure is not cached as success');
  });
});

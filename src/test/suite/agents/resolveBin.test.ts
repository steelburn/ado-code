import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentBinCandidates, isCmdShim, resolveSpawn } from '../../../agents/resolveBin';

suite('resolveBin (agent detection + spawn resolution)', () => {
  test('win32 probes .cmd then .exe then the bare name; other platforms probe the bare name only', () => {
    assert.deepStrictEqual(agentBinCandidates('claude', 'win32'), ['claude.cmd', 'claude.exe', 'claude']);
    assert.deepStrictEqual(agentBinCandidates('codex', 'win32'), ['codex.cmd', 'codex.exe', 'codex']);
    assert.deepStrictEqual(agentBinCandidates('claude', 'linux'), ['claude']);
    assert.deepStrictEqual(agentBinCandidates('dsh', 'darwin'), ['dsh']);
  });

  test('isCmdShim detects .cmd/.bat case-insensitively', () => {
    assert.ok(isCmdShim('claude.cmd'));
    assert.ok(isCmdShim('CLAUDE.BAT'));
    assert.ok(!isCmdShim('claude.exe'));
    assert.ok(!isCmdShim('claude'));
  });

  test('non-win32 and non-shim spawns pass through unchanged', () => {
    assert.deepStrictEqual(resolveSpawn('claude', ['-p', 'hi'], 'linux', undefined, null), { bin: 'claude', args: ['-p', 'hi'] });
    assert.deepStrictEqual(resolveSpawn('claude', ['-p', 'hi'], 'darwin', undefined, null), { bin: 'claude', args: ['-p', 'hi'] });
    // .exe (and bare-name) spawns directly — CreateProcess resolves them, no shell needed.
    assert.deepStrictEqual(resolveSpawn('claude', ['-p', 'hi'], 'win32', undefined, null), { bin: 'claude', args: ['-p', 'hi'] });
    assert.deepStrictEqual(resolveSpawn('claude.exe', ['--version'], 'win32', undefined, null), { bin: 'claude.exe', args: ['--version'] });
  });

  test('win32 .cmd shims run through cmd.exe with a verbatim cmd-grammar line', () => {
    const r = resolveSpawn(
      'claude.cmd',
      ['-p', 'say "hi"', '--output-format', 'json'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
      null,
    );
    assert.strictEqual(r.bin, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepStrictEqual(r.opts, { windowsVerbatimArguments: true });
    assert.deepStrictEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    // Outer quote pair is what cmd's /s handling strips; every inner argument
    // is quoted with embedded double quotes doubled (cmd grammar).
    assert.strictEqual(r.args[3], '""claude.cmd" "-p" "say ""hi""" "--output-format" "json""');
  });

  test('defaults the comspec from the environment on win32', () => {
    const r = resolveSpawn('dsh.cmd', ['-p', 'x'], 'win32', undefined, null);
    assert.strictEqual(r.bin, process.env.ComSpec ?? process.env.comspec ?? 'cmd.exe');
    assert.strictEqual(r.args[3], '""dsh.cmd" "-p" "x""');
  });

  test('a fresh env makes the spawn target the file that env resolves, not a bare name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-spawn-'));
    try {
      // The host may not see the CLI at all — only the fresh env does.
      const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
      const target = path.join(dir, name);
      fs.writeFileSync(target, '');
      const env = { PATH: dir } as NodeJS.ProcessEnv;
      const r = resolveSpawn('claude', ['-p', 'x'], process.platform, undefined, env);
      assert.strictEqual(r.bin, target, 'spawned by absolute path');
      assert.deepStrictEqual(r.opts, { env }, 'and the child inherits the fresh PATH');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a .cmd shim found on the fresh PATH still runs through cmd.exe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-shim-'));
    try {
      const shim = path.join(dir, 'claude.cmd');
      fs.writeFileSync(shim, '');
      const env = { Path: dir } as NodeJS.ProcessEnv;
      const r = resolveSpawn('claude', ['-p', 'x'], 'win32', 'C:\\Windows\\System32\\cmd.exe', env);
      assert.strictEqual(r.bin, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepStrictEqual(r.opts, { windowsVerbatimArguments: true, env });
      assert.ok(r.args[3].includes(shim), 'the absolute shim path is in the command line');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no fresh env nothing leaks into the spawn options (old behaviour)', () => {
    assert.deepStrictEqual(resolveSpawn('claude', ['-p', 'hi'], 'linux', undefined, null), {
      bin: 'claude',
      args: ['-p', 'hi'],
    });
  });

});

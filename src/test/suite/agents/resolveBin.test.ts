import * as assert from 'assert';
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
    assert.deepStrictEqual(resolveSpawn('claude', ['-p', 'hi'], 'linux'), { bin: 'claude', args: ['-p', 'hi'] });
    assert.deepStrictEqual(resolveSpawn('claude', ['-p', 'hi'], 'darwin'), { bin: 'claude', args: ['-p', 'hi'] });
    // .exe (and bare-name) spawns directly — CreateProcess resolves them, no shell needed.
    assert.deepStrictEqual(resolveSpawn('claude', ['-p', 'hi'], 'win32'), { bin: 'claude', args: ['-p', 'hi'] });
    assert.deepStrictEqual(resolveSpawn('claude.exe', ['--version'], 'win32'), { bin: 'claude.exe', args: ['--version'] });
  });

  test('win32 .cmd shims run through cmd.exe with a verbatim cmd-grammar line', () => {
    const r = resolveSpawn(
      'claude.cmd',
      ['-p', 'say "hi"', '--output-format', 'json'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    );
    assert.strictEqual(r.bin, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepStrictEqual(r.opts, { windowsVerbatimArguments: true });
    assert.deepStrictEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    // Outer quote pair is what cmd's /s handling strips; every inner argument
    // is quoted with embedded double quotes doubled (cmd grammar).
    assert.strictEqual(r.args[3], '""claude.cmd" "-p" "say ""hi""" "--output-format" "json""');
  });

  test('defaults the comspec from the environment on win32', () => {
    const r = resolveSpawn('dsh.cmd', ['-p', 'x'], 'win32');
    assert.strictEqual(r.bin, process.env.ComSpec ?? process.env.comspec ?? 'cmd.exe');
    assert.strictEqual(r.args[3], '""dsh.cmd" "-p" "x""');
  });
});

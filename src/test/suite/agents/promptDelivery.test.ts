import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PROMPT_ARGV_BUDGET,
  PROMPT_ARGV_BUDGET_POSIX,
  PROMPT_FILE_REL,
  clearPromptFile,
  deliverPromptArg,
  promptArgvBudget,
  promptFilePath,
  promptPointerText,
} from '../../../agents/promptDelivery';
import { cleanTempDir } from '../utils/cleanTempDir';

suite('promptDelivery', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-prompt-'));
  });

  teardown(() => {
    cleanTempDir(tmpDir);
  });

  test('a short prompt travels on argv and leaves no file behind', () => {
    const arg = deliverPromptArg('Summarise the work item', tmpDir);
    assert.strictEqual(arg, 'Summarise the work item');
    assert.ok(!fs.existsSync(promptFilePath(tmpDir)), 'nothing spilled');
  });

  test('a prompt at exactly the budget still travels on argv', () => {
    const prompt = 'z'.repeat(PROMPT_ARGV_BUDGET);
    assert.strictEqual(deliverPromptArg(prompt, tmpDir), prompt);
  });

  test('an oversized prompt is spilled to .ado-code and replaced by a pointer', () => {
    const prompt = 'x'.repeat(PROMPT_ARGV_BUDGET + 1);
    const arg = deliverPromptArg(prompt, tmpDir);
    const file = path.join(tmpDir, PROMPT_FILE_REL);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), prompt);
    assert.notStrictEqual(arg, prompt);
    assert.ok(arg.includes(file), 'the pointer names the prompt file');
    assert.ok(/read that file/i.test(arg), 'the pointer tells the agent to read it first');
  });

  test('the pointer stays far below the cmd.exe limit however big the prompt is', () => {
    const arg = deliverPromptArg('y'.repeat(400_000), tmpDir);
    assert.ok(arg.length < PROMPT_ARGV_BUDGET, `pointer is ${arg.length} chars`);
  });

  test('the spilled file is dropped once a run fits on argv again', () => {
    deliverPromptArg('x'.repeat(PROMPT_ARGV_BUDGET + 1), tmpDir);
    assert.ok(fs.existsSync(promptFilePath(tmpDir)));
    deliverPromptArg('short again', tmpDir);
    assert.ok(!fs.existsSync(promptFilePath(tmpDir)), 'stale prompt removed');
  });

  test('the pointer is three non-empty lines — no placeholder junk', () => {
    const arg = deliverPromptArg('x'.repeat(PROMPT_ARGV_BUDGET + 1), tmpDir);
    const lines = arg.split('\n');
    assert.strictEqual(lines.length, 3, JSON.stringify(arg));
    assert.ok(lines.every(l => l.trim().length > 0), JSON.stringify(arg));
    assert.strictEqual(lines[1], promptFilePath(tmpDir));
  });

  test('the win32 budget is the cmd.exe-sized one', () => {
    assert.strictEqual(promptArgvBudget('win32'), PROMPT_ARGV_BUDGET);
    assert.strictEqual(promptArgvBudget('linux'), PROMPT_ARGV_BUDGET_POSIX);
    assert.ok(promptArgvBudget('win32') < 8191, 'win32 budget leaves room for bin + flags');
  });

  test('without a working directory the prompt stays on argv', () => {
    const prompt = 'x'.repeat(PROMPT_ARGV_BUDGET + 1);
    assert.strictEqual(deliverPromptArg(prompt, undefined), prompt);
    assert.strictEqual(deliverPromptArg(prompt, ''), prompt);
  });

  test('clearPromptFile is a no-op when there is nothing to remove', () => {
    clearPromptFile(tmpDir);
    clearPromptFile(undefined);
    assert.ok(!fs.existsSync(promptFilePath(tmpDir)));
  });

  test('the pointer text names the file it points at', () => {
    const text = promptPointerText('C:/repo/.ado-code/delegation-prompt.md');
    assert.ok(text.includes('C:/repo/.ado-code/delegation-prompt.md'), text);
  });
});

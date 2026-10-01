import * as assert from 'assert';
import {
  groupToolActivity,
  toolActivityLabel,
  toolActivityPreview,
} from '../../../shared/toolActivity';

suite('shared/toolActivity', () => {
  suite('groupToolActivity', () => {
    test('collapses consecutive tool calls into ONE activity segment', () => {
      const entries = [
        { kind: 'tool', call: { name: 'read_file' } },
        { kind: 'tool', call: { name: 'edit_file' } },
      ] as any;

      const groups = groupToolActivity(entries);

      assert.strictEqual(groups.length, 1);
      assert.strictEqual(groups[0].kind, 'activity');
      assert.deepStrictEqual(
        (groups[0] as any).calls.map((c: any) => c.name),
        ['read_file', 'edit_file'],
      );
    });

    test('keeps thinking in place and splits tool runs around it', () => {
      const entries = [
        { kind: 'tool', call: { name: 'a' } },
        { kind: 'thinking', text: 'why' },
        { kind: 'tool', call: { name: 'b' } },
        { kind: 'tool', call: { name: 'c' } },
      ] as any;

      const groups = groupToolActivity(entries);

      assert.deepStrictEqual(groups.map((g) => g.kind), ['activity', 'thinking', 'activity']);
      assert.strictEqual((groups[0] as any).calls.length, 1);
      assert.strictEqual((groups[2] as any).calls.length, 2);
      assert.strictEqual((groups[1] as any).text, 'why');
    });

    test('returns an empty array for no entries', () => {
      assert.deepStrictEqual(groupToolActivity([]), []);
    });
  });

  suite('toolActivityLabel', () => {
    test('singular for exactly one tool', () => {
      assert.strictEqual(toolActivityLabel(1), 'Ran 1 tool');
    });
    test('plural for several tools', () => {
      assert.strictEqual(toolActivityLabel(3), 'Ran 3 tools');
    });
  });

  suite('toolActivityPreview', () => {
    test('single tool shows its name', () => {
      assert.strictEqual(toolActivityPreview([{ name: 'read_file' }]), 'read_file');
    });
    test('two tools are listed', () => {
      assert.strictEqual(
        toolActivityPreview([{ name: 'read_file' }, { name: 'edit_file' }]),
        'read_file, edit_file',
      );
    });
    test('extra tools collapse into a +N counter, deduping', () => {
      assert.strictEqual(
        toolActivityPreview([
          { name: 'read_file' },
          { name: 'edit_file' },
          { name: 'run_terminal_command' },
          { name: 'read_file' },
        ]),
        'read_file, edit_file +1',
      );
    });
    test('unnamed tools read as "tool"', () => {
      assert.strictEqual(toolActivityPreview([{}, {}]), 'tool');
    });
  });
});

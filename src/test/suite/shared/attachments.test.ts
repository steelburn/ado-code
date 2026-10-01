import * as assert from 'assert';
import {
  splitAttachments,
  attachmentChipLabel,
} from '../../../shared/attachments';

suite('shared/attachments', () => {
  suite('splitAttachments', () => {
    test('returns an untouched body when there are no attachments', () => {
      const { names, body } = splitAttachments('hello world');
      assert.deepStrictEqual(names, []);
      assert.strictEqual(body, 'hello world');
    });

    test('extracts one compact `[Attached: name]` marker', () => {
      const { names, body } = splitAttachments('[Attached: notes.md]');
      assert.deepStrictEqual(names, ['notes.md']);
      assert.strictEqual(body, '');
    });

    test('extracts several markers and keeps the surrounding body', () => {
      const { names, body } = splitAttachments(
        'please review\n\n[Attached: a.ts] [Attached: b.ts]\n\nthanks'
      );
      assert.deepStrictEqual(names, ['a.ts', 'b.ts']);
      assert.strictEqual(body, 'please review\n\nthanks');
    });

    test('folds a legacy `[File: name]` block (body discarded) to a name', () => {
      const { names, body } = splitAttachments(
        '[File: config.json]\n{\n  "a": 1\n}\n[/file]\n\nupdate this'
      );
      assert.deepStrictEqual(names, ['config.json']);
      assert.strictEqual(body, 'update this');
    });

    test('folds a mix of legacy blocks and compact markers, in order', () => {
      const { names, body } = splitAttachments(
        '[File: old.txt]\ncontents\n[/file]\n[Attached: new.txt]\n\nboth'
      );
      assert.deepStrictEqual(names, ['old.txt', 'new.txt']);
      assert.strictEqual(body, 'both');
    });

    test('drops empty names rather than emitting blank chips', () => {
      const { names } = splitAttachments('[Attached:   ]');
      assert.deepStrictEqual(names, []);
    });

    test('handles empty content', () => {
      assert.deepStrictEqual(splitAttachments(''), { names: [], body: '' });
    });
  });

  suite('attachmentChipLabel', () => {
    test('is empty with no attachments', () => {
      assert.strictEqual(attachmentChipLabel([]), '');
    });
    test('is singular for one file', () => {
      assert.strictEqual(attachmentChipLabel(['a.ts']), '1 file');
    });
    test('is plural for many files', () => {
      assert.strictEqual(attachmentChipLabel(['a', 'b', 'c']), '3 files');
    });
  });
});

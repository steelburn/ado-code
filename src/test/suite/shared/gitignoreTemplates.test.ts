import * as assert from 'assert';
import {
  GITIGNORE_TEMPLATES,
  GitignoreLabel,
  gitignoreContent,
  gitignoreLabelForStack,
  isGitignoreLabel,
} from '../../../shared/gitignoreTemplates';
import { MONOREPO_STACKS, MonorepoStackId } from '../../../shared/monorepoStacks';

/**
 * The ignore-file label space is the fix for finding F2 (docs/project-scaffolding.md):
 * `writeGitignore` used to be keyed by a free-form `templateId: string` with a
 * `|| 'node_modules/'` fallback, so a wrong label produced a plausible-looking but
 * wrong `.gitignore` with nothing to catch it. These tests pin the two properties
 * that make the fallback unnecessary — every label has a real body, and every value
 * that used to be passed as a label still resolves to one — plus the two cases the
 * fallback used to get wrong.
 */
suite('shared/gitignoreTemplates', () => {
  const labels = Object.keys(GITIGNORE_TEMPLATES) as GitignoreLabel[];

  suite('the label space', () => {
    test('every label has a body that is a real file', () => {
      assert.ok(labels.length > 0, 'the record must not be empty');
      for (const label of labels) {
        const content = gitignoreContent(label);
        assert.ok(content.length > 0, `${label} must not be empty`);
        assert.ok(content.endsWith('\n'), `${label} must end with a newline`);
        assert.ok(!content.startsWith('\n'), `${label} must not start with a blank line`);
        assert.ok(!content.includes('\r'), `${label} must be LF — .gitignore is written verbatim`);
        assert.ok(
          !content.split('\n').some((line, i, all) => line === '' && i < all.length - 1),
          `${label} must not contain blank lines`
        );
      }
    });

    test('isGitignoreLabel accepts exactly the record keys', () => {
      for (const label of labels) {
        assert.ok(isGitignoreLabel(label), `${label} is a label`);
      }
      // A string that is not a label must be rejected rather than defaulting.
      assert.strictEqual(isGitignoreLabel('not-a-template'), false);
      assert.strictEqual(isGitignoreLabel(''), false);
      assert.strictEqual(isGitignoreLabel('Node-Ts'), false, 'labels are case-sensitive');
    });

    test('the old template-id/label confusion no longer resolves', () => {
      // `scaffoldStackMonorepo` passed this template id as if it were a label; the
      // fallback turned it into the Node body for a .NET monorepo.
      assert.strictEqual(isGitignoreLabel('dotnet-webapi'), false);
      assert.ok(
        !gitignoreContent('dotnet').includes('node_modules/'),
        'the .NET body must not ignore node_modules — that was the F2 bug'
      );
      assert.ok(gitignoreContent('dotnet').includes('/bin/'), '.NET ignores /bin/');
    });

    test('the standalone test-automation template gets tooling, not a borrowed body', () => {
      // The suite appends its own IGNORE_LINES (node_modules/, dist/, reports), so
      // the base body only carries the tooling files it does not own.
      const content = gitignoreContent('test-automation');
      assert.ok(content.includes('.env'));
      assert.ok(!content.includes('node_modules/'), 'the suite owns that line');
    });

    test('`empty` keeps a minimal body', () => {
      const content = gitignoreContent('empty');
      assert.ok(content.includes('.env'));
      assert.ok(!content.includes('node_modules/'));
    });
  });

  suite('monorepo stacks', () => {
    test('every stack maps to a label with a stack-appropriate body', () => {
      const expected: Record<MonorepoStackId, string> = {
        'node-ts': 'node_modules/',
        dotnet: '/bin/',
        'php-laravel': '/vendor/',
        python: '__pycache__/',
      };
      const stacks = MONOREPO_STACKS.map((stack) => stack.id);
      assert.deepStrictEqual(
        stacks.slice().sort(),
        (Object.keys(expected) as MonorepoStackId[]).sort(),
        'the test must cover every MonorepoStackId'
      );
      for (const stack of stacks) {
        const content = gitignoreContent(gitignoreLabelForStack(stack));
        assert.ok(
          content.includes(expected[stack]),
          `${stack} must ignore ${expected[stack]} (got ${JSON.stringify(content)})`
        );
      }
    });

    test('dotnet does not silently receive the node body', () => {
      // Regression: the ternary used to pass `dotnet-webapi`, which fell through to
      // the `node_modules/` default.
      const content = gitignoreContent(gitignoreLabelForStack('dotnet'));
      assert.ok(!content.includes('node_modules/'));
      assert.notStrictEqual(gitignoreLabelForStack('dotnet'), gitignoreLabelForStack('node-ts'));
    });
  });
});

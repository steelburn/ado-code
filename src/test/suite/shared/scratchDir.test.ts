import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkoutRoot,
  isInsideCheckout,
  makeDirOutsideRepo,
  makeScratchDir,
  scratchRoot,
} from '../utils/scratchDir';

// Guards the helper every suite now uses for its throwaway directories. The
// default root is `.ado-code/test-scratch` inside the checkout - the only place
// the sandboxed Electron host lets the suite write - so any suite that shells out
// to git must `git init` its scratch dir first; `isInsideCheckout` is how it knows
// that the guard is needed.
suite('test utils · scratchDir', () => {
  test('scratchRoot resolves to the checkout-local .ado-code/test-scratch', () => {
    const root = scratchRoot();
    assert.ok(fs.statSync(root).isDirectory(), `scratch root must exist (${root})`);
    assert.strictEqual(scratchRoot(), root, 'the root is resolved once and cached');
    if (!process.env.ADO_CODE_TEST_SCRATCH) {
      assert.strictEqual(
        path.resolve(root),
        path.resolve(path.join(checkoutRoot(), '.ado-code', 'test-scratch')),
        'default scratch root sits inside the checkout'
      );
    }
  });

  test('makeScratchDir hands out a fresh, empty, writable directory each call', () => {
    const a = makeScratchDir('ado-scratch-a-');
    const b = makeScratchDir('ado-scratch-b-');
    try {
      assert.notStrictEqual(a, b);
      assert.ok(fs.statSync(a).isDirectory());
      fs.writeFileSync(path.join(a, 'probe.txt'), 'ok', 'utf8');
      assert.strictEqual(fs.readdirSync(a).length, 1);
      assert.strictEqual(fs.readdirSync(b).length, 0, 'sibling dirs stay independent');
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('isInsideCheckout separates the checkout from the system temp dir', () => {
    assert.strictEqual(isInsideCheckout(checkoutRoot()), true);
    assert.strictEqual(isInsideCheckout(__dirname), true, 'the suite itself lives in the checkout');
    assert.strictEqual(isInsideCheckout(path.join(os.tmpdir(), 'ado-probe')), false);
  });

  test('makeDirOutsideRepo never returns a path inside a work tree', () => {
    const dir = makeDirOutsideRepo('ado-outside-');
    if (!dir) {
      console.log('SKIP: no writable directory outside the checkout on this host');
      return;
    }
    try {
      assert.strictEqual(isInsideCheckout(dir), false, `outside dir was inside the checkout (${dir})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

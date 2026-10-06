import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, '.vscodeignore'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('could not locate repository root from ' + __dirname);
}

/**
 * Guards the packaged artifact's file list: development-only metadata
 * (CI workflows, git hooks) must never ship inside the .vsix.
 */
suite('Packaging hygiene', () => {
  function ignorePatterns(): string[] {
    const raw = fs.readFileSync(path.join(findRepoRoot(), '.vscodeignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  const developmentOnlyDirs = ['.github', '.husky'];

  for (const dir of developmentOnlyDirs) {
    test(`.vscodeignore excludes the ${dir} directory`, () => {
      assert.ok(
        ignorePatterns().includes(`${dir}/**`),
        `.vscodeignore does not exclude "${dir}/**" - development-only files would ship in the .vsix`
      );
      assert.ok(
        fs.existsSync(path.join(findRepoRoot(), dir)),
        `expected "${dir}" to exist in the repo; the guard is stale`
      );
    });
  }
});

/**
 * Guards the marketplace icon. VS Code and Open VSX both advertise a PNG at
 * package.json#icon; a JPEG renamed to .png renders by content sniffing but
 * is not a valid PNG, so nothing downstream can be trusted to decode it.
 */
suite('Extension icon', () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function iconBytes(): Buffer {
    return fs.readFileSync(path.join(findRepoRoot(), 'resources', 'icon.png'));
  }

  test('resources/icon.png carries the PNG signature, not a JPEG header', () => {
    const bytes = iconBytes();
    assert.ok(
      bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
      `resources/icon.png is not a PNG (first bytes: ${bytes.subarray(0, 4).toString('hex')})`
    );
  });

  test('resources/icon.png declares its dimensions in an IHDR chunk', () => {
    const bytes = iconBytes();
    assert.strictEqual(
      bytes.toString('ascii', 12, 16),
      'IHDR',
      'resources/icon.png has no IHDR chunk, so it is not a valid PNG'
    );
    assert.strictEqual(bytes.readUInt32BE(16), 256, 'unexpected icon width');
    assert.strictEqual(bytes.readUInt32BE(20), 256, 'unexpected icon height');
  });

  test('package.json points its marketplace icon at resources/icon.png', () => {
    const root = findRepoRoot();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.strictEqual(manifest.icon, 'resources/icon.png');
    assert.ok(
      fs.existsSync(path.join(root, manifest.icon)),
      `package.json#icon points at a missing file: ${manifest.icon}`
    );
  });
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the repository's licensing metadata so the public distribution
 * (Marketplace .vsix and the GitHub repo) can never drift back into the
 * unlicensed state it was in before.
 */
suite('Licensing metadata', () => {
  function findRepoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (
        fs.existsSync(path.join(dir, 'package.json')) &&
        fs.existsSync(path.join(dir, 'src', 'llm', 'types.ts'))
      ) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    throw new Error('could not locate the repository root from ' + __dirname);
  }

  test('package.json declares the MIT SPDX identifier', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(findRepoRoot(), 'package.json'), 'utf8'));
    assert.strictEqual(pkg.license, 'MIT', 'package.json "license" field must be "MIT"');
  });

  test('a LICENSE file exists and contains the MIT license text', () => {
    const licensePath = path.join(findRepoRoot(), 'LICENSE');
    assert.ok(fs.existsSync(licensePath), 'LICENSE file is missing from the repository root');
    const text = fs.readFileSync(licensePath, 'utf8');
    assert.ok(/MIT License/i.test(text), 'LICENSE does not name the MIT License');
    assert.ok(
      text.includes('Permission is hereby granted, free of charge'),
      'LICENSE is missing the MIT permission grant',
    );
    assert.ok(
      text.includes('THE SOFTWARE IS PROVIDED "AS IS"'),
      'LICENSE is missing the MIT warranty disclaimer',
    );
  });

  test('README documents the license', () => {
    const readme = fs.readFileSync(path.join(findRepoRoot(), 'README.md'), 'utf8');
    assert.ok(/^## License\s*$/m.test(readme), 'README has no "## License" section');
    assert.ok(/\[MIT\]|MIT License/.test(readme), 'README License section does not identify MIT');
  });
});

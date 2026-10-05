#!/usr/bin/env node
const { execSync } = require('child_process');

// git sets GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE etc. for hooks; the test
// suite shells out to git in temp repos and would inherit them, corrupting
// every git call ("Unable to create .../.git/index.lock: Not a directory").
for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX']) {
  delete process.env[key];
}

function run(cmd) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: __dirname + '/..' });
    return true;
  } catch {
    return false;
  }
}

console.log('=== ADO Code pre-commit checks ===');
// Cheap invariant first: a stale EXTENSION_VERSION fails loudly and
// instantly, before the expensive VS Code test boot even starts.
const version = run('npm run check:version');
const compile = run('npm run compile');
const test = run('npm test');

if (!version || !compile || !test) {
  console.error('\n❌ Pre-commit checks failed.');
  process.exit(1);
}
console.log('\n✅ All pre-commit checks passed.');

#!/usr/bin/env node
const { execSync } = require('child_process');

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
const compile = run('npm run compile');
const test = run('npm test');

if (!compile || !test) {
  console.error('\n❌ Pre-commit checks failed.');
  process.exit(1);
}
console.log('\n✅ All pre-commit checks passed.');

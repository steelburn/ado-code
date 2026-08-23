import * as fs from 'fs';
import * as path from 'path';

/**
 * Build the AGENTS.md template for a workspace root.
 *
 * Commands in the Build & Test section are derived from the real
 * package.json "scripts", so the generated file never tells agents to run a
 * command that doesn't exist (a hardcoded `npm run build` broke projects
 * that only have build:all/build:webview). File-presence detection is used
 * only for fallbacks — `npx tsc --noEmit` when tsconfig.json exists without
 * a compile script, `npx eslint .` when an eslint config exists (legacy
 * .eslintrc* or ESLint 9 flat config) without a lint script — and to name a
 * detected test runner (Jest/Vitest/Mocha) when there is no `test` script.
 */
export function buildAgentsMdContent(root: string): string {
  const pkgPath = path.join(root, 'package.json');
  let pkgName = 'project';
  let pkgDesc = '';
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      name?: string;
      description?: string;
      scripts?: Record<string, string>;
    };
    pkgName = pkg.name || 'project';
    pkgDesc = pkg.description || '';
    if (pkg.scripts && typeof pkg.scripts === 'object') scripts = pkg.scripts;
  } catch { /* no package.json */ }

  const hasScript = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(scripts, name);
  const exists = (name: string): boolean => fs.existsSync(path.join(root, name));

  const buildLines: string[] = [];

  // Type check / compile.
  if (hasScript('compile')) {
    buildLines.push('- `npm run compile` — TypeScript compilation');
  } else if (exists('tsconfig.json')) {
    buildLines.push('- `npx tsc --noEmit` — Type check');
  }

  // Build — prefer the conventional name, then build:all, then build:webview.
  if (hasScript('build')) {
    buildLines.push('- `npm run build` — Production build');
  } else if (hasScript('build:all')) {
    buildLines.push('- `npm run build:all` — Full build');
  } else if (hasScript('build:webview')) {
    buildLines.push('- `npm run build:webview` — Webview bundle');
  }

  // Tests — only emit `npm test` when the script exists; otherwise name a
  // detected runner or note that tests exist.
  const testDirs = ['test', 'tests', '__tests__', 'spec', 'src/test', 'src/__tests__', 'src/spec'];
  const testConfigs = [
    'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts',
    'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs',
    '.mocharc.json', '.mocharc.js', '.mocharc.cjs', '.mocharc.yml', '.mocharc.yaml',
  ];
  const hasTests = hasScript('test') || testDirs.some(exists) || testConfigs.some(exists);
  if (hasScript('test')) {
    buildLines.push('- `npm test` — Run test suite');
  } else if (hasTests) {
    // Only name a runner whose config file actually exists in the workspace.
    if (testConfigs.some((f) => f.startsWith('jest') && exists(f))) {
      buildLines.push('- `npx jest` — Run test suite (Jest)');
    } else if (testConfigs.some((f) => f.startsWith('vitest') && exists(f))) {
      buildLines.push('- `npx vitest run` — Run test suite (Vitest)');
    } else if (testConfigs.some((f) => f.includes('.mocharc') && exists(f))) {
      buildLines.push('- `npx mocha` — Run test suite (Mocha)');
    } else {
      buildLines.push("- Tests exist under a test directory — run them with the project's configured runner");
    }
  }

  // Lint — prefer the script; fall back to npx eslint when any config exists
  // (legacy .eslintrc* or ESLint 9 flat config).
  const eslintConfigs = [
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml',
    'eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs', 'eslint.config.ts',
  ];
  const hasLint = hasScript('lint') || eslintConfigs.some(exists);
  if (hasScript('lint')) {
    buildLines.push('- `npm run lint` — Linting');
  } else if (hasLint) {
    buildLines.push('- `npx eslint .` — Linting');
  }

  // Honest fallback when nothing recognizable exists.
  if (buildLines.length === 0) {
    buildLines.push('- See `package.json` → `scripts` for available build/test commands');
  }

  const lines = [
    `# AGENTS.md — ${pkgName}`,
    '',
    '## What This Is',
    pkgDesc || 'Project workspace.',
    '',
    '## Build & Test',
    ...buildLines,
    '',
    '## Project Structure',
  ];

  try {
    const dirEntries = fs.readdirSync(root, { withFileTypes: true });
    const dirs = dirEntries.filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'
    );
    for (const d of dirs) {
      lines.push(`- \`${d.name}/\` — project directory`);
    }
  } catch { /* ignore */ }

  const conventions = ['- Follow existing code patterns in the project'];
  if (hasTests) conventions.push('- Run tests before committing');
  if (hasLint) conventions.push('- Check lint passes');

  lines.push('', '## Conventions', ...conventions, '', '## What NOT to Do');
  const donts = ['- Do not add unnecessary dependencies'];
  if (hasTests) donts.unshift('- Do not commit without running tests');
  lines.push(...donts);

  return lines.join('\n');
}

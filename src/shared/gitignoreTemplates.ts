/**
 * The ignore-file label space — the one typed home for every `.gitignore` body the
 * scaffolder can write.
 *
 * `writeGitignore` used to take a free-form `templateId: string` and fall back to
 * `node_modules/` for anything it did not recognise. That is how a .NET monorepo
 * ended up shipping a Node ignore file (`scaffoldStackMonorepo` passed the label
 * `dotnet-webapi`, which is a template id, not an ignore label) and how the
 * standalone test-automation template got one by accident. The union turns a wrong
 * label into a compile error and the exhaustive record turns a forgotten template
 * into one too, so there is no fallback and no silently wrong bytes
 * (docs/project-scaffolding.md, finding F2).
 */
import type { MonorepoStackId } from './monorepoStacks';

/** Every ignore-file body the scaffolder can write. */
export type GitignoreLabel =
  | 'node-ts'
  | 'node-js'
  | 'python'
  | 'php-laravel'
  | 'php'
  | 'dotnet'
  | 'react-native'
  | 'flutter'
  | 'dotnet-maui'
  | 'monorepo-microservices'
  | 'test-automation'
  | 'empty';

/**
 * Label → file body, exhaustive by type: adding a label without a body fails the
 * build instead of producing an empty or borrowed `.gitignore`.
 *
 * `php` and `dotnet` are shared labels: the deprecated `php` alias and the two
 * .NET templates (`dotnet-webapi`, `dotnet-console`) reuse them rather than
 * carrying near-identical copies.
 */
export const GITIGNORE_TEMPLATES: Record<GitignoreLabel, string> = {
  'node-ts': 'node_modules/\ndist/\n.env\n.env.local\n',
  'node-js': 'node_modules/\n.env\n.env.local\n',
  python: '__pycache__/\n*.pyc\n.env\nvenv/\n.venv/\n*.egg-info/\n',
  'php-laravel':
    '/vendor/\n.env\n.env.backup\n.phpunit.result.cache\nHomestead.json\nHomestead.yaml\nauth.json\nnpm-debug.log\nyarn-error.log\n/.fleet\n/.idea\n/.vscode\n',
  php: '/vendor/\ncomposer.lock\n.phpunit.result.cache\n',
  dotnet: '/bin/\n/obj/\n/user/\n*.user\n*.suo\n*.userosscache\n*.sln.docstates\n',
  'react-native':
    'node_modules/\n.expo/\ndist/\n*.log\n.env\n.env.local\nios/Pods/\nandroid/.gradle/\nandroid/app/build/\n*.jks\n*.p8\n*.p12\n*.key\n*.mobileprovision\n',
  flutter:
    '**/build/\n.dart_tool/\n.packages\n.env\n*.iml\n.idea/\n.vscode/\nandroid/local.properties\nios/Pods/\n',
  'dotnet-maui': '/bin/\n/obj/\n**/bin/\n**/obj/\n*.user\n*.suo\n.vs/\n',
  'monorepo-microservices':
    'node_modules/\ndist/\n**/dist/\n.env\n.env.local\n*.log\ncoverage/\n.turbo/\n.nx/\n',
  // The suite adds node_modules/, dist/ and the report folders itself
  // (`IGNORE_LINES` in testAutomationSuite.ts), so the base set is tooling only.
  'test-automation': '.env\n.env.local\n*.log\ncoverage/\n',
  empty: '.env\n.DS_Store\n',
};

/** The body for a label. Total by construction — there is no fallback body. */
export function gitignoreContent(label: GitignoreLabel): string {
  return GITIGNORE_TEMPLATES[label];
}

/**
 * Whether a free-form string names an ignore label. Callers that only have a
 * string (a persisted option, an id read back from disk) narrow with this instead
 * of relying on the old silent `node_modules/` default.
 */
export function isGitignoreLabel(value: string): value is GitignoreLabel {
  return Object.prototype.hasOwnProperty.call(GITIGNORE_TEMPLATES, value);
}

/**
 * The ignore set that matches a monorepo's stack. The per-stack writers used a
 * hand-rolled ternary that passed `dotnet-webapi` for .NET, so .NET monorepos
 * silently received the Node body; an exhaustive record cannot drift that way.
 */
const BY_MONOREPO_STACK: Record<MonorepoStackId, GitignoreLabel> = {
  'node-ts': 'node-ts',
  dotnet: 'dotnet',
  'php-laravel': 'php-laravel',
  python: 'python',
};

/** The ignore label for a monorepo stack. */
export function gitignoreLabelForStack(stack: MonorepoStackId): GitignoreLabel {
  return BY_MONOREPO_STACK[stack];
}

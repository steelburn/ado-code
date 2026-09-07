import * as fs from 'fs';
import * as path from 'path';

/**
 * AGENTS.md generation + sync.
 *
 * The generated file has two zones:
 *  - a MANAGED block (between MANAGED_START / MANAGED_END markers) holding the
 *    sections ADO Code derives: `## What This Is`, `## Build & Test`,
 *    `## Project Structure` and — when the repository-understanding cache
 *    (.ado-code/understanding) holds an LLM summary — `## Repository
 *    Understanding`. This block is the unit of staleness: when it no longer
 *    matches what the current repository + understanding would produce, the
 *    file is outdated and ADO Code offers to sync it IN PLACE (everything
 *    outside the markers — Conventions, What NOT to Do, user notes — is
 *    preserved untouched).
 *  - user-owned content outside the markers, written once at generation.
 *
 * Build & Test commands are derived from the real package.json "scripts", so
 * the generated file never tells agents to run a command that doesn't exist
 * (a hardcoded `npm run build` broke projects that only have
 * build:all/build:webview). File-presence detection is used only for
 * fallbacks — `npx tsc --noEmit` when tsconfig.json exists without a compile
 * script, `npx eslint .` when an eslint config exists (legacy .eslintrc* or
 * ESLint 9 flat config) without a lint script — and to name a detected test
 * runner (Jest/Vitest/Mocha) when there is no `test` script.
 *
 * Everything here is pure Node (no vscode import) so the drift evaluation
 * is unit-testable.
 */

// ---------------------------------------------------------------------------
// Managed-block markers
// ---------------------------------------------------------------------------

export const MANAGED_START = '<!-- ado-code:managed -->';
export const MANAGED_END = '<!-- ado-code:managed-end -->';

const STRUCTURE_SECTION = '## Project Structure';
const BUILD_SECTION = '## Build & Test';
const UNDERSTANDING_SECTION = '## Repository Understanding';

/** Directory bullets that lack a summary-derived description fall back to this. */
const DIR_FALLBACK_DESC = 'project directory';

// ---------------------------------------------------------------------------
// Deterministic facts derived from the workspace
// ---------------------------------------------------------------------------

interface DerivedFacts {
  pkgName: string;
  pkgDesc: string;
  scripts: Record<string, string>;
  dirs: string[];
  /** Human lines already formatted for the Build & Test section. */
  buildLines: string[];
  hasTests: boolean;
  hasLint: boolean;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deriveFacts(root: string): DerivedFacts {
  const pkg = readJson(path.join(root, 'package.json'));
  const pkgName = typeof pkg?.name === 'string' ? pkg.name : 'project';
  const pkgDesc = typeof pkg?.description === 'string' ? pkg.description : '';
  const scripts: Record<string, string> =
    pkg?.scripts && typeof pkg.scripts === 'object'
      ? (pkg.scripts as Record<string, string>)
      : {};

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
    buildLines.push(
      pkg
        ? 'See `package.json` → `scripts` for available build/test commands'
        : 'See the README or project tooling for build & test commands'
    );
  }

  // Top-level directories (sorted for a deterministic managed block) — dot
  // dirs and node_modules are tooling noise, not project structure.
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort();
  } catch { /* root unreadable */ }

  return { pkgName, pkgDesc, scripts, dirs, buildLines, hasTests, hasLint };
}

// ---------------------------------------------------------------------------
// Summary → directory descriptions
// ---------------------------------------------------------------------------

/**
 * Pull a one-line description for a top-level directory out of the cached
 * LLM repo summary, when the summary describes it as a bullet like
 * `- \`src/\` — extension host code` or `- src/: UI components`. Only
 * explicit list-item mentions with a delimiter qualify — bare prose
 * mentions never produce a description, so a summary can't mislabel a dir.
 */
function describeDir(dir: string, summary: string): string | null {
  if (!summary) return null;
  const variants = [`\`${dir}/\``, `\`${dir}\``, `${dir}/`];
  for (const line of summary.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // Only list-item lines (or lines that backtick the dir) qualify.
    const isListItem = /^[-*+]\s+/.test(t);
    for (const token of variants) {
      const pos = t.indexOf(token);
      if (pos < 0) continue;
      const before = pos > 0 ? t[pos - 1] : '';
      if (/[A-Za-z0-9_]/.test(before)) continue; // word boundary (e.g. not "resources/")
      if (!isListItem && !t.includes('`')) continue;
      const rest = t.slice(pos + token.length).trim();
      // Require an explicit delimiter so prose can't leak in.
      const m = rest.match(/^(?:—|–|:|-)\s*(.+)$/);
      if (!m) continue;
      let desc = m[1].trim().replace(/`/g, '');
      if (desc.length < 2 || desc.length > 140) continue;
      desc = desc.replace(/[.!?]+$/, '');
      return desc;
    }
  }
  return null;
}

/** Cap applied to the LLM summary when embedded into AGENTS.md. */
const MAX_SUMMARY_CHARS = 2800;

// ---------------------------------------------------------------------------
// Managed block (the drift-checked, syncable region)
// ---------------------------------------------------------------------------

export interface AgentsMdBuildOptions {
  /**
   * LLM repository summary from the understanding cache
   * (`.ado-code/understanding/repo.md` → `### LLM Summary`). When present it
   * enriches the Project Structure bullets with per-directory one-liners and
   * adds the `## Repository Understanding` section. Omit for deterministic-
   * only output.
   */
  summary?: string;
}

/** The inner managed block for the current workspace state. Deterministic. */
export function computeManagedBlock(root: string, options?: AgentsMdBuildOptions): string {
  return managedBlockText(deriveFacts(root), options?.summary?.trim() ?? '');
}

/** Inner content of the managed block in an existing AGENTS.md, or null. */
export function extractManagedBlock(content: string): string | null {
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END);
  if (start < 0 || end < 0 || end <= start) return null;
  return content.slice(start + MANAGED_START.length, end).trim() || null;
}

/**
 * Replace the managed block inside an existing AGENTS.md with `block`,
 * preserving everything outside the markers (title, Conventions, user
 * notes). Returns the original content when no managed block exists.
 */
export function replaceManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start < 0 || end < 0 || end <= start) return existing;
  return (
    existing.slice(0, start) +
    `${MANAGED_START}\n${block.trim()}\n${MANAGED_END}` +
    existing.slice(end + MANAGED_END.length)
  );
}

/** Index of an exact `## Heading` line in `text` (from `from` on), or -1. */
function headingIndex(text: string, heading: string, from = 0): number {
  const m = text.slice(from).search(
    new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
  );
  return m < 0 ? -1 : m + from;
}

/**
 * Upgrade a legacy ADO Code-generated AGENTS.md (pre-marker era) to the
 * managed format WITHOUT a full rewrite: the title stays, the derived
 * sections (What This Is / Build & Test / Project Structure) are replaced by
 * the managed block, and everything from the first non-derived `##` heading
 * (Conventions / What NOT to Do / later user sections) is preserved as-is.
 * Returns null when the file does not look like our own legacy template —
 * hand-authored files take the wholesale path instead (with a Preview).
 */
export function migrateLegacyAgentsMd(existing: string, block: string): string | null {
  const whatIdx = headingIndex(existing, 'What This Is');
  if (whatIdx < 0) return null;
  let tailIdx = headingIndex(existing, 'Conventions', whatIdx + 1);
  if (tailIdx < 0) tailIdx = headingIndex(existing, 'What NOT to Do', whatIdx + 1);
  if (tailIdx < 0) return null;
  const head = existing.slice(0, whatIdx);
  const tail = existing.slice(tailIdx);
  return `${head}${MANAGED_START}\n${block.trim()}\n${MANAGED_END}\n\n${tail}`;
}

/** Stable non-crypto hash — used to remember which candidate was declined. */
export function hashBlock(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function managedBlockText(facts: DerivedFacts, summary: string): string {
  const lines: string[] = [];

  lines.push('## What This Is');
  lines.push(facts.pkgDesc || 'Project workspace.');

  lines.push('', '## Build & Test');
  lines.push(...facts.buildLines);

  if (facts.dirs.length > 0) {
    lines.push('', '## Project Structure');
    for (const d of facts.dirs) {
      const desc = describeDir(d, summary) ?? DIR_FALLBACK_DESC;
      lines.push(`- \`${d}/\` — ${desc}`);
    }
  }

  if (summary) {
    lines.push('', UNDERSTANDING_SECTION);
    lines.push(
      '> Distilled from the ADO Code repository-understanding cache (`.ado-code/understanding/`).',
      '> Refreshed automatically as the repository changes and via "ADO Code: Refresh Repository Understanding".',
      '> This section and the other generated sections above are rewritten when ADO Code syncs AGENTS.md — edits anywhere else are preserved.',
      '',
      // The summary's own ## headings would sit at the same level as the
      // managed sections — demote them so the document tree stays clean.
      summary.slice(0, MAX_SUMMARY_CHARS).replace(/^## /gm, '### '),
    );
  }

  return lines.join('\n');
}

/**
 * Full generated AGENTS.md: title, managed block, then user-owned defaults
 * (Conventions / What NOT to Do) that survive later in-place syncs.
 */
export function buildAgentsMdContent(root: string, options?: AgentsMdBuildOptions): string {
  const facts = deriveFacts(root);
  const block = managedBlockText(facts, options?.summary?.trim() ?? '');

  const conventions = ['- Follow existing code patterns in the project'];
  if (facts.hasTests) conventions.push('- Run tests before committing');
  if (facts.hasLint) conventions.push('- Check lint passes');

  const donts = ['- Do not add unnecessary dependencies'];
  if (facts.hasTests) donts.unshift('- Do not commit without running tests');

  return [
    `# AGENTS.md — ${facts.pkgName}`,
    '',
    MANAGED_START,
    block,
    MANAGED_END,
    '',
    '## Conventions',
    ...conventions,
    '',
    '## What NOT to Do',
    ...donts,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sync evaluation (is AGENTS.md outdated? and if so, how to fix it)
// ---------------------------------------------------------------------------

/** Prior offer memory (persisted per workspace) — stops re-offering the same candidate. */
export interface AgentsMdSyncPrior {
  /** Signature of the candidate managed block last offered / declined. */
  blockSig?: string;
  /** Signature of the deterministic-only block (facts) at that time. */
  factsSig?: string;
  /** How many times the user declined the current facts state in a row. */
  declines: number;
}

export type AgentsMdSyncKind = 'none' | 'missing' | 'update' | 'adopt';

export interface AgentsMdSyncDecision {
  kind: AgentsMdSyncKind;
  /** Human-readable reasons — shown in the offer card. */
  reasons: string[];
  /**
   * kind 'missing' | 'adopt' → full file content to write;
   * kind 'update'        → the managed-block replacement (use replaceManagedBlock).
   */
  candidate: string;
  /** Signature of the candidate managed block. */
  blockSig: string;
  /** Signature of the deterministic-only managed block (structure facts). */
  factsSig: string;
}

const DECLINE_LIMIT = 2;

/**
 * Decide whether AGENTS.md needs attention, given the current repository and
 * the cached understanding summary. Pure over the filesystem — used by the
 * webview's workspace-init check and after a manual understanding refresh.
 *
 *   missing  → no AGENTS.md yet; offer to generate the starter file.
 *   update   → file has a managed block whose content drifted from what the
 *              repository + understanding now produce (build commands changed,
 *              structure changed, LLM summary refreshed, …).
 *   adopt    → file was authored outside ADO Code (no markers) but the cache
 *              holds an LLM summary worth folding in; offer a one-time sync.
 *   none     → fresh, or already offered/declined for this exact state.
 *
 * A `prior` with the same blockSig suppresses the offer (that exact content
 * was already declined); once the user has declined DECLINE_LIMIT times for
 * the same deterministic facts, only a real structural change re-offers —
 * regenerated LLM-summary wording alone stops nagging.
 */
export function evaluateAgentsMdSync(
  root: string,
  options: AgentsMdBuildOptions,
  prior?: AgentsMdSyncPrior,
): AgentsMdSyncDecision {
  const summary = options?.summary?.trim() ?? '';
  const facts = deriveFacts(root);
  const currentBlock = managedBlockText(facts, summary);
  const factsBlock = managedBlockText(facts, '');
  const blockSig = hashBlock(currentBlock);
  const factsSig = hashBlock(factsBlock);

  const declinedSameCandidate = Boolean(prior && prior.blockSig === blockSig);
  const overDeclinedForFacts =
    Boolean(prior && (prior.declines ?? 0) >= DECLINE_LIMIT && prior.factsSig === factsSig);
  const suppressed = declinedSameCandidate || overDeclinedForFacts;

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  } catch { /* absent */ }

  if (!existing) {
    // A declined starter offer is remembered too — no re-ask until the
    // candidate (or the underlying facts) actually changes.
    if (suppressed) {
      return { kind: 'none', reasons: [], candidate: '', blockSig, factsSig };
    }
    return {
      kind: 'missing',
      reasons: ['No AGENTS.md exists yet.'],
      candidate: buildAgentsMdContent(root, { summary }),
      blockSig,
      factsSig,
    };
  }

  const managed = extractManagedBlock(existing);

  if (managed === null) {
    // Authored outside ADO Code (no markers). Only offer to take over when
    // the cache adds real value an agent file doesn't have: the LLM summary.
    if (!summary || suppressed) {
      return { kind: 'none', reasons: [], candidate: '', blockSig, factsSig };
    }
    // Legacy files WE generated (pre-marker era) upgrade in place, preserving
    // everything from the first user-owned heading onward. Anything else is a
    // hand-authored file → wholesale rewrite, behind a Preview.
    const migrated = migrateLegacyAgentsMd(existing, currentBlock);
    const reasons = migrated
      ? [
          'AGENTS.md was generated by an older version of ADO Code without sync markers, so it cannot be kept in sync automatically.',
          'Syncing upgrades it to the managed format and folds in the current repository understanding — everything from "## Conventions" onward (your edits included) is preserved.',
        ]
      : [
          'AGENTS.md was not generated by ADO Code, so it cannot be kept in sync automatically.',
          'The repository understanding (.ado-code/understanding) now has an LLM summary that AGENTS.md does not contain.',
          'Syncing rewrites the file from the current repository + understanding — review with Preview first.',
        ];
    return {
      kind: 'adopt',
      reasons,
      candidate: migrated ?? buildAgentsMdContent(root, { summary }),
      blockSig,
      factsSig,
    };
  }

  if (managed === currentBlock || suppressed) {
    return { kind: 'none', reasons: [], candidate: '', blockSig, factsSig };
  }

  return {
    kind: 'update',
    reasons: managedDriftReasons(managed, currentBlock),
    candidate: currentBlock,
    blockSig,
    factsSig,
  };
}

/** Human-readable drift summary between the old and new managed blocks. */
function managedDriftReasons(oldBlock: string, newBlock: string): string[] {
  const oldSections = splitSections(oldBlock);
  const newSections = splitSections(newBlock);
  const reasons: string[] = [];
  const all = Array.from(new Set([...Object.keys(oldSections), ...Object.keys(newSections)]));
  for (const name of all) {
    const oldText = oldSections[name] ?? '';
    const newText = newSections[name] ?? '';
    if (oldText === newText) continue;
    if (!oldText) {
      reasons.push(`New section "${name}" added`);
    } else if (!newText) {
      reasons.push(`Section "${name}" removed`);
    } else if (name === BUILD_SECTION) {
      reasons.push('Build/test/lint commands changed');
    } else if (name === STRUCTURE_SECTION) {
      const drift = structureBulletDrift(oldText, newText);
      reasons.push(drift.length > 0 ? `Project structure changed (${drift.join(', ')})` : 'Project structure changed');
    } else if (name === UNDERSTANDING_SECTION) {
      reasons.push('Repository understanding refreshed (LLM summary regenerated)');
    } else {
      reasons.push(`Section "${name}" changed`);
    }
  }
  if (reasons.length === 0) reasons.push('Generated sections no longer match the repository');
  return reasons;
}

/** Split a managed block into section name → raw content (markers-free input). */
function splitSections(block: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = '';
  let currentName = '';
  for (const line of block.split('\n')) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      if (currentName) sections[currentName] = current.trim();
      currentName = `## ${m[1]}`;
      current = '';
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (currentName) sections[currentName] = current.trim();
  return sections;
}

/** "added x, removed y" for the dir bullets of the Project Structure section. */
function structureBulletDrift(oldText: string, newText: string): string[] {
  const dirs = (text: string): string[] => {
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^-\s*`?([^`\s/]+)\/?`?\s*—/);
      if (m) out.push(m[1]);
    }
    return out;
  };
  const oldDirs = dirs(oldText);
  const newDirs = dirs(newText);
  const added = newDirs.filter((d) => !oldDirs.includes(d));
  const removed = oldDirs.filter((d) => !newDirs.includes(d));
  const bits: string[] = [];
  if (added.length > 0) bits.push(`added ${added.join(', ')}`);
  if (removed.length > 0) bits.push(`removed ${removed.join(', ')}`);
  return bits;
}

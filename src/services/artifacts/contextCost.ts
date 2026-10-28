// Context cost diagnostics (ADO-27361).
//
// The bloat this epic fixed was invisible until someone noticed hundreds of
// large `.md` files in an unrelated project. This module makes the cost of what
// ADO Code keeps on disk observable: files and bytes per kind, estimated prompt
// tokens (chars / 4), the largest offenders, the age of the oldest artifact,
// and the configured budget each category is measured against — so the next
// feature that quietly writes more files shows up in one command.
//
// Pure Node (no vscode import) so the report is unit-testable; the command that
// renders it reads the user's settings and passes them in.

import * as fs from 'fs';
import * as path from 'path';

import { extractManagedBlock, MAX_MANAGED_BLOCK_CHARS } from '../../webview/agentsMd';
import {
  ArtifactKind,
  formatBytes,
  scanArtifacts,
  estimateTokens,
} from './ArtifactStore';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Budgets reported alongside actual usage. Resolved from settings by the caller. */
export interface ContextCostLimits {
  memoryMaxTotalChars: number;
  memoryMaxEntries: number;
  understandingMaxEntries: number;
  agentsMdManagedMaxChars: number;
  skillsMaxInjectedChars: number;
}

export const DEFAULT_CONTEXT_COST_LIMITS: ContextCostLimits = {
  memoryMaxTotalChars: 4000,
  memoryMaxEntries: 25,
  understandingMaxEntries: 200,
  agentsMdManagedMaxChars: MAX_MANAGED_BLOCK_CHARS,
  skillsMaxInjectedChars: 4000,
};

export interface ContextCostRow {
  kind: string;
  label: string;
  files: number;
  bytes: number;
  tokens: number;
}

export interface LargestArtifact {
  relPath: string;
  kind: string;
  bytes: number;
  tokens: number;
  ageDays: number;
}

export interface BudgetUsage {
  name: string;
  used: number;
  limit: number;
  /** 'files' | 'entries' | 'chars' */
  unit: string;
  over: boolean;
  detail: string;
}

export interface ContextCostReport {
  generatedAt: string;
  root: string;
  rows: ContextCostRow[];
  totalFiles: number;
  totalBytes: number;
  totalTokens: number;
  largest: LargestArtifact[];
  oldest: { relPath: string; ageDays: number } | null;
  budgets: BudgetUsage[];
  warnings: string[];
}

export interface ContextCostOptions {
  now?: number;
  limits?: Partial<ContextCostLimits>;
  /** Max offenders listed. */
  topN?: number;
}

const KIND_LABELS: Partial<Record<ArtifactKind, string>> = {
  'workitem-cache': 'Work-item caches',
  'understanding-map': 'Repository map',
  'understanding-index': 'Understanding index',
  draft: 'Task drafts',
  'run-log': 'Delegated run output',
  memory: 'Workspace memory',
  session: 'Session mirrors',
  checkpoint: 'Checkpoints',
  worktree: 'Git worktrees',
  state: 'State files',
  other: 'Other / unrecognised',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind as ArtifactKind] ?? kind;
}

function safeSize(absPath: string): number {
  try {
    const stat = fs.statSync(absPath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function readText(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** `docs/*.md` at the workspace root only — never a recursive workspace walk. */
function listDocFiles(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, 'docs'), { withFileTypes: true })
      .filter(d => d.isFile() && /\.md$/i.test(d.name))
      .map(d => path.join('docs', d.name));
  } catch {
    return [];
  }
}

/** Memory entries under `.ado-code/memory`, as `<key>.md` files. */
function listMemoryFiles(root: string): string[] {
  const dir = path.join(root, '.ado-code', 'memory');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && /\.(md|txt)$/i.test(d.name))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Count entries recorded in the understanding index, falling back to the number
 * of work-item cache files when the index is missing or unreadable.
 */
function readUnderstandingEntryCount(root: string, fallback: number): number {
  const raw = readText(path.join(root, '.ado-code', 'understanding', 'index.json'));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (Array.isArray(parsed.entries)) {
        return parsed.entries.length;
      }
    } catch {
      /* fall through to the file count */
    }
  }
  return fallback;
}

/** Largest SKILL.md under any `skills` directory within two levels of the root. */
function largestSkillFile(root: string): { relPath: string; bytes: number } | null {
  const candidates: string[] = [];
  try {
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name === 'node_modules' || dirent.name.startsWith('.')) {
        continue;
      }
      const nested = path.join(root, dirent.name);
      let children: fs.Dirent[] = [];
      try {
        children = fs.readdirSync(nested, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.isDirectory() && child.name === 'skills') {
          candidates.push(path.join(nested, child.name));
        }
      }
      if (dirent.name === 'skills') {
        candidates.push(nested);
      }
    }
  } catch {
    return null;
  }

  let best: { relPath: string; bytes: number } | null = null;
  for (const dir of candidates) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dir, name, 'SKILL.md');
      const bytes = safeSize(abs);
      if (bytes > 0 && (!best || bytes > best.bytes)) {
        best = { relPath: path.relative(root, abs).replace(/\\/g, '/'), bytes };
      }
    }
  }
  return best;
}

export function buildContextCostReport(
  root: string,
  options: ContextCostOptions = {}
): ContextCostReport {
  const now = options.now ?? Date.now();
  const limits: ContextCostLimits = { ...DEFAULT_CONTEXT_COST_LIMITS, ...options.limits };
  const topN = options.topN ?? 10;
  const warnings: string[] = [];

  const inventory = scanArtifacts(root);
  if (inventory.truncated) {
    warnings.push('The artifact scan hit its entry cap — totals below are a lower bound.');
  }

  const rows: ContextCostRow[] = inventory.byKind.map(summary => ({
    kind: summary.kind,
    label: kindLabel(summary.kind),
    files: summary.count,
    bytes: summary.bytes,
    tokens: estimateTokens(summary.bytes),
  }));

  const largest: LargestArtifact[] = inventory.entries.map(entry => ({
    relPath: entry.relPath,
    kind: entry.kind,
    bytes: entry.bytes,
    tokens: estimateTokens(entry.bytes),
    ageDays: Math.max(0, Math.floor((now - entry.mtimeMs) / DAY_MS)),
  }));

  let oldest = inventory.oldestMtimeMs;
  let oldestRel =
    inventory.entries
      .slice()
      .sort((a, b) => a.mtimeMs - b.mtimeMs)[0]?.relPath ?? null;

  // AGENTS.md and docs/*.md are generated/curated documentation, not artifacts,
  // but they cost prompt and disk exactly the same way.
  const agentsMdAbs = path.join(root, 'AGENTS.md');
  const agentsMd = readText(agentsMdAbs);
  if (agentsMd !== null) {
    const bytes = safeSize(agentsMdAbs);
    rows.push({
      kind: 'agents-md',
      label: 'AGENTS.md',
      files: 1,
      bytes,
      tokens: estimateTokens(bytes),
    });
    const stat = fs.statSync(agentsMdAbs);
    largest.push({
      relPath: 'AGENTS.md',
      kind: 'agents-md',
      bytes,
      tokens: estimateTokens(bytes),
      ageDays: Math.max(0, Math.floor((now - stat.mtimeMs) / DAY_MS)),
    });
    if (oldest === null || stat.mtimeMs < oldest) {
      oldest = stat.mtimeMs;
      oldestRel = 'AGENTS.md';
    }
  }

  const docs = listDocFiles(root);
  if (docs.length > 0) {
    let bytes = 0;
    for (const rel of docs) {
      const abs = path.join(root, rel);
      const size = safeSize(abs);
      bytes += size;
      let mtime = 0;
      try {
        mtime = fs.statSync(abs).mtimeMs;
      } catch {
        mtime = 0;
      }
      largest.push({
        relPath: rel,
        kind: 'docs',
        bytes: size,
        tokens: estimateTokens(size),
        ageDays: Math.max(0, Math.floor((now - (mtime ?? 0)) / DAY_MS)),
      });
      if (mtime && (oldest === null || mtime < oldest)) {
        oldest = mtime;
        oldestRel = rel;
      }
    }
    rows.push({
      kind: 'docs',
      label: 'docs/*.md',
      files: docs.length,
      bytes,
      tokens: estimateTokens(bytes),
    });
  }

  const budgets: BudgetUsage[] = [];

  const memoryFiles = listMemoryFiles(root);
  let memoryChars = 0;
  for (const name of memoryFiles) {
    memoryChars += readText(path.join(root, '.ado-code', 'memory', name))?.length ?? 0;
  }
  budgets.push({
    name: 'Workspace memory (chars)',
    used: memoryChars,
    limit: limits.memoryMaxTotalChars,
    unit: 'chars',
    over: memoryChars > limits.memoryMaxTotalChars,
    detail: `${memoryFiles.length} entr${memoryFiles.length === 1 ? 'y' : 'ies'} injected as a digest above the cap`,
  });
  budgets.push({
    name: 'Workspace memory (entries)',
    used: memoryFiles.length,
    limit: limits.memoryMaxEntries,
    unit: 'entries',
    over: memoryFiles.length > limits.memoryMaxEntries,
    detail: 'adoCode.memory.maxEntries',
  });

  const workItemCaches = inventory.entries.filter(e => e.kind === 'workitem-cache').length;
  const understandingEntries = readUnderstandingEntryCount(root, workItemCaches);
  budgets.push({
    name: 'Understanding cache entries',
    used: understandingEntries,
    limit: limits.understandingMaxEntries,
    unit: 'entries',
    over: understandingEntries > limits.understandingMaxEntries,
    detail: 'adoCode.understanding.maxEntries — LRU eviction past the cap',
  });

  const managedBlock = agentsMd ? extractManagedBlock(agentsMd) : null;
  budgets.push({
    name: 'AGENTS.md managed block',
    used: managedBlock?.length ?? 0,
    limit: limits.agentsMdManagedMaxChars,
    unit: 'chars',
    over: (managedBlock?.length ?? 0) > limits.agentsMdManagedMaxChars,
    detail: managedBlock
      ? 'generated sections ADO Code rewrites on sync'
      : 'no managed block found',
  });

  const skill = largestSkillFile(root);
  budgets.push({
    name: 'Largest injected SKILL.md',
    used: skill?.bytes ?? 0,
    limit: limits.skillsMaxInjectedChars,
    unit: 'chars',
    over: (skill?.bytes ?? 0) > limits.skillsMaxInjectedChars,
    detail: skill ? `${skill.relPath} — adoCode.skills.maxInjectedChars` : 'no SKILL.md found',
  });

  const totalFiles = rows.reduce((sum, row) => sum + row.files, 0);
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);

  largest.sort((a, b) => b.bytes - a.bytes || a.relPath.localeCompare(b.relPath));

  return {
    generatedAt: new Date(now).toISOString(),
    root,
    rows,
    totalFiles,
    totalBytes,
    totalTokens: estimateTokens(totalBytes),
    largest: largest.slice(0, topN),
    oldest:
      oldest !== null && oldestRel
        ? { relPath: oldestRel, ageDays: Math.max(0, Math.floor((now - oldest) / DAY_MS)) }
        : null,
    budgets,
    warnings,
  };
}

/** Rendered into the output channel and offered as markdown by the command. */
export function formatContextCostReport(report: ContextCostReport): string {
  const lines: string[] = [];
  lines.push('ADO Code context cost');
  lines.push(`workspace: ${report.root}`);
  lines.push(
    `totals: ${report.totalFiles} file(s), ${formatBytes(report.totalBytes)}, ~${report.totalTokens} tokens (chars / 4)`
  );
  lines.push('');
  lines.push('By kind');
  const rows = report.rows.slice().sort((a, b) => b.bytes - a.bytes);
  if (rows.length === 0) {
    lines.push('  (no artifacts)');
  }
  const labelWidth = Math.max(...rows.map(r => r.label.length), 12);
  for (const row of rows) {
    lines.push(
      `  ${row.label.padEnd(labelWidth)}  ${String(row.files).padStart(5)} file(s)  ${formatBytes(row.bytes).padStart(9)}  ~${row.tokens} tokens`
    );
  }
  lines.push('');
  lines.push(`Largest ${report.largest.length}`);
  for (const entry of report.largest) {
    lines.push(
      `  ${formatBytes(entry.bytes).padStart(9)}  ~${String(entry.tokens).padStart(7)} tokens  ${entry.ageDays}d  ${entry.relPath}`
    );
  }
  if (report.oldest) {
    lines.push('');
    lines.push(`oldest artifact: ${report.oldest.relPath} (${report.oldest.ageDays} days)`);
  }
  lines.push('');
  lines.push('Budgets');
  for (const budget of report.budgets) {
    const mark = budget.over ? 'OVER ' : 'ok   ';
    lines.push(
      `  ${mark}${budget.name}: ${budget.used} / ${budget.limit} ${budget.unit} — ${budget.detail}`
    );
  }
  if (report.warnings.length > 0) {
    lines.push('');
    for (const warning of report.warnings) {
      lines.push(`warning: ${warning}`);
    }
  }
  return lines.join('\n');
}

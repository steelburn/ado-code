import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../logger';
import { WorkItemContext } from '../../shared/messages';
import { formatWorkItemContext } from '../../llm/prompts';

/**
 * Repository Understanding — a durable, fingerprinted cache of what ADO Code
 * "knows" about the active repository and the selected ADO work item, shared
 * across chat sessions AND injected into every external-agent handoff.
 *
 * Storage layout (mirrors the existing `.ado-code/` convention):
 *   .ado-code/understanding/
 *     meta.json        — fingerprints + generation timestamps
 *     repo.md          — deterministic repo facts (+ optional LLM summary)
 *     workitem-<id>.md — cached context for a selected ADO work item
 *     knowledge.md     — distilled session knowledge (condensation output)
 *
 * Invalidation is fingerprint-based, never TTL-based:
 *   - repo.md     → git HEAD/branch + mtimes of watched files (AGENTS.md,
 *                   package.json, README, tsconfig.json)
 *   - workitem-*  → the work item's System.ChangedDate (rev)
 *   - knowledge   → append-only, rotated when over budget
 *
 * Reads are synchronous fs reads (cheap, never block a chat turn);
 * regeneration happens on fingerprint mismatch only, and the LLM summary is
 * generated async so a turn is never blocked on a paid model call.
 */

// ---------------------------------------------------------------------------
// Structural interfaces (GitService / WorkspaceMemory satisfy these)
// ---------------------------------------------------------------------------

/** The git surface the understanding cache needs. */
export interface UnderstandingGit {
  getCurrentBranch(): Promise<string | null>;
  getShortCommitHash(): Promise<string | null>;
  getRemoteOriginUrl(): Promise<string | null>;
}

/** The workspace-memory surface used to list memory keys into the facts. */
export interface UnderstandingMemory {
  list(): string[];
  read(key: string): string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIR_NAME = '.ado-code/understanding';
const REPO_FILE = 'repo.md';
const KNOWLEDGE_FILE = 'knowledge.md';
const META_FILE = 'meta.json';

/** Files whose mtime (plus git identity) invalidate the repo understanding. */
const WATCHED_FILES = ['AGENTS.md', 'package.json', 'README.md', 'README', 'tsconfig.json'];

/** Top-level entries never listed as repo facts. */
const EXCLUDED_TREE = new Set([
  '.git', '.ado-code', '.vscode', '.vscode-test', 'node_modules',
  'out', 'dist', 'build', 'coverage', 'webview-ui-dist', '.hermes', '.husky',
]);

const MAX_TREE_ENTRIES = 40;
const MAX_AGENTS_MD_CHARS = 1500;
const MAX_README_CHARS = 1500;
const MAX_README_LINES = 30;
const MAX_PKG_SCRIPTS = 20;
const MAX_DEPS = 20;
/** Per-section caps keep the injected block bounded (≈ tokens / 4). */
const MAX_FACTS_CHARS = 3500;
const MAX_SUMMARY_CHARS = 2800;
const MAX_KNOWLEDGE_CHARS = 5000;
const MAX_TOTAL_CHARS = 12000;

/** System prompt for the LLM repo-summary generator. */
const SUMMARY_SYSTEM_PROMPT =
  'You analyze a software repository for an AI coding assistant that helps with Azure DevOps work items. ' +
  'Produce a concise repository understanding in Markdown covering: architecture and how the pieces fit together; ' +
  'key modules/directories and their responsibilities; conventions (naming, structure, error handling, testing); ' +
  'how to build, test, and lint; common gotchas. Keep it under 600 words. Do not invent facts — only describe what the repository actually shows.';

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

interface RepoMeta {
  fingerprint: string;
  generatedAt: string;
  hasSummary: boolean;
  summaryGeneratedAt?: string;
}

interface UnderstandingMeta {
  repo?: RepoMeta;
  workitems?: Record<string, { fingerprint: string; generatedAt: string }>;
  knowledge?: { updatedAt: string; entries: number };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class UnderstandingService {
  private readonly root: string;
  private readonly dir: string;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after any mutation (repo facts, summary, work item, knowledge). */
  readonly onDidChange = this._onDidChange.event;

  /** Optional LLM summarizer — wired by the host (extension.ts) so the
   *  service itself stays provider-agnostic and testable. */
  private summarizeFn?: (text: string) => Promise<string>;

  /** Guards against overlapping summary generations (activation + chat turn). */
  private summaryInFlight = false;

  /** Id of the work item whose cached context `toPromptString()` includes. */
  private currentWorkItemId?: number;

  constructor(
    workspaceRoot: string,
    private readonly git?: UnderstandingGit,
    private readonly memory?: UnderstandingMemory,
  ) {
    this.root = workspaceRoot;
    this.dir = path.join(workspaceRoot, DIR_NAME);
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /** Wire the LLM summarizer (fresh client from current settings upstream). */
  setSummarizer(fn: (text: string) => Promise<string>): void {
    this.summarizeFn = fn;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Absolute path to the understanding directory. */
  getDir(): string {
    return this.dir;
  }

  /** Current meta snapshot (tests / status panel). */
  getMeta(): UnderstandingMeta {
    return this.readMeta();
  }

  /**
   * Ensure the cached repo understanding is fresh. Fingerprint mismatch (or
   * `force`) rebuilds the deterministic facts synchronously-ish (fs + git
   * reads only) and kicks the LLM summary generation async — never blocks
   * the caller on a paid model call.
   */
  async ensureFresh(force = false): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      const fingerprint = await this.computeRepoFingerprint();
      const meta = this.readMeta();
      const cached = meta.repo;
      if (!force && cached && cached.fingerprint === fingerprint && fs.existsSync(this.repoFile())) {
        return true;
      }

      const facts = await this.buildRepoFacts();
      // A changed fingerprint invalidates the old LLM summary (it describes
      // the previous code). Only `force` keeps nothing; a fingerprint match
      // with a missing/partial file reuses the summary.
      let summary = '';
      if (!force && cached && cached.fingerprint === fingerprint && cached.hasSummary) {
        summary = this.readSummarySection(this.readFileIfExists(this.repoFile()) ?? '');
      }
      let content = facts;
      if (summary) {
        content += `\n\n### LLM Summary\n\n${summary}`;
      }
      this.init();
      fs.writeFileSync(this.repoFile(), content, 'utf8');
      meta.repo = {
        fingerprint,
        generatedAt: new Date().toISOString(),
        hasSummary: Boolean(summary),
        summaryGeneratedAt: summary ? cached?.summaryGeneratedAt : undefined,
      };
      this.writeMeta(meta);
      this._onDidChange.fire();

      if (!force && this.shouldAutoSummarize() && !summary && this.summarizeFn) {
        void this.refreshRepoSummary();
      }
      return true;
    } catch (err) {
      logger.debug('Understanding: ensureFresh failed', err);
      return false;
    }
  }

  /**
   * Regenerate the LLM repo summary from the cached facts. No-op without a
   * wired summarizer or cached facts, or while another generation is in
   * flight. Never throws.
   */
  async refreshRepoSummary(): Promise<void> {
    if (!this.summarizeFn) {
      logger.debug('Understanding: no summarizer wired — skipping LLM summary');
      return;
    }
    if (this.summaryInFlight) return;
    const facts = this.stripSummarySection(this.readFileIfExists(this.repoFile()) ?? '');
    if (!facts.trim()) {
      logger.debug('Understanding: no repo facts cached — skipping LLM summary');
      return;
    }
    this.summaryInFlight = true;
    try {
      const summary = (await this.summarizeFn(`${SUMMARY_SYSTEM_PROMPT}\n\n${facts}`)).trim();
      if (!summary) return;
      const content = `${facts}\n\n### LLM Summary\n\n${summary.slice(0, MAX_SUMMARY_CHARS)}`;
      fs.writeFileSync(this.repoFile(), content, 'utf8');
      const meta = this.readMeta();
      meta.repo = {
        ...(meta.repo ?? { fingerprint: '', generatedAt: '' }),
        hasSummary: true,
        summaryGeneratedAt: new Date().toISOString(),
      };
      this.writeMeta(meta);
      this._onDidChange.fire();
      logger.info(`Understanding: repository summary regenerated (${summary.length} chars)`);
    } catch (err) {
      logger.debug('Understanding: LLM summary failed', err);
    } finally {
      this.summaryInFlight = false;
    }
  }

  /**
   * Cache the given work item context. Writes only when the fingerprint
   * (System.ChangedDate / rev) changed, so re-selecting the same item is a
   * no-op. The cached item becomes the one `toPromptString()` includes.
   */
  setWorkItem(workItem: WorkItemContext, fingerprint?: string): void {
    if (!workItem || !workItem.id) return;
    const idKey = String(workItem.id);
    const fp = fingerprint && fingerprint.trim() ? fingerprint.trim() : idKey;
    const meta = this.readMeta();
    const prev = meta.workitems?.[idKey];
    const file = this.workItemFile(workItem.id);
    if (prev && prev.fingerprint === fp && fs.existsSync(file)) {
      this.currentWorkItemId = workItem.id;
      return;
    }
    this.init();
    fs.writeFileSync(file, `### Work Item\n\n${formatWorkItemContext(workItem)}`, 'utf8');
    meta.workitems = {
      ...(meta.workitems ?? {}),
      [idKey]: { fingerprint: fp, generatedAt: new Date().toISOString() },
    };
    this.writeMeta(meta);
    this.currentWorkItemId = workItem.id;
    this._onDidChange.fire();
  }

  /** Drop the current work item (called on unselect). */
  clearWorkItem(): void {
    this.currentWorkItemId = undefined;
  }

  /** The cached LLM repository summary (`### LLM Summary` in repo.md), or ''. */
  getRepoSummary(): string {
    const repo = this.readFileIfExists(this.repoFile());
    return repo ? this.readSummarySection(repo) : '';
  }

  /** The durable prior-session knowledge (knowledge.md), or ''. */
  getKnowledge(): string {
    return (this.readFileIfExists(this.knowledgeFile()) ?? '').trim();
  }

  /**
   * Append a dated knowledge entry (e.g. a conversation-condensation
   * summary) to the durable knowledge store. Entries are stored as bare
   * `## <date>` blocks (the section header is added by toPromptString);
   * rotation drops the OLDEST whole entries while the file exceeds its char
   * budget, so at least the most recent entry always survives intact.
   */
  appendKnowledge(text: string): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    this.init();
    const entry = `## ${new Date().toISOString()}\n\n${trimmed}`;
    const file = this.knowledgeFile();
    const existing = this.readFileIfExists(file) ?? '';
    let combined = existing ? `${existing}\n\n${entry}` : entry;
    if (combined.length > MAX_KNOWLEDGE_CHARS) {
      // Drop oldest entries (each starts at a '\n## ' boundary) until the
      // file fits — or until only one entry remains (never leave nothing).
      const parts = combined.split('\n## ');
      while (combined.length > MAX_KNOWLEDGE_CHARS && parts.length > 1) {
        parts.shift();
        combined = `## ${parts.join('\n## ')}`;
      }
    }
    fs.writeFileSync(file, combined, 'utf8');
    const meta = this.readMeta();
    meta.knowledge = {
      updatedAt: new Date().toISOString(),
      entries: (meta.knowledge?.entries ?? 0) + 1,
    };
    this.writeMeta(meta);
    this._onDidChange.fire();
  }

  /**
   * The complete understanding block for injection into a system prompt or an
   * external-agent handoff: repo facts (+ summary), current work item, and
   * prior session knowledge — bounded to a total char budget. Empty string
   * when nothing is cached yet.
   */
  toPromptString(): string {
    const parts: string[] = [];
    const repo = this.readFileIfExists(this.repoFile());
    if (repo) parts.push(repo);
    if (this.currentWorkItemId !== undefined) {
      const wi = this.readFileIfExists(this.workItemFile(this.currentWorkItemId));
      if (wi) parts.push(wi);
    }
    const knowledge = this.readFileIfExists(this.knowledgeFile());
    if (knowledge) parts.push(`### Prior Session Knowledge\n\n${knowledge}`);
    if (parts.length === 0) return '';

    const header =
      '## Repository Understanding\n\n' +
      '> Cached understanding — regenerated automatically when the repository or work item changes. Verify critical facts before relying on them.\n';
    let body = `${header}\n${parts.join('\n\n')}`;
    if (body.length > MAX_TOTAL_CHARS) {
      body = body.slice(0, MAX_TOTAL_CHARS) + '\n\n…(understanding truncated to stay within token budget)';
    }
    return body;
  }

  /** Force a full refresh (facts + LLM summary). Used by the refresh command. */
  async refreshNow(): Promise<void> {
    await this.ensureFresh(true);
    await this.refreshRepoSummary();
  }

  // -----------------------------------------------------------------------
  // Fingerprints
  // -----------------------------------------------------------------------

  /**
   * Repo fingerprint: git identity (branch + HEAD) plus mtimes of watched
   * files. Branch switch, new commit, or an edited AGENTS.md/package.json/
   * README all invalidate the cache.
   */
  private async computeRepoFingerprint(): Promise<string> {
    const parts: string[] = [];
    if (this.git) {
      try {
        const branch = await this.git.getCurrentBranch();
        if (branch) parts.push(`branch:${branch}`);
      } catch { /* not a git repo */ }
      try {
        const sha = await this.git.getShortCommitHash();
        if (sha) parts.push(`sha:${sha}`);
      } catch { /* not a git repo */ }
    }
    for (const rel of WATCHED_FILES) {
      const abs = path.join(this.root, rel);
      try {
        const st = fs.statSync(abs);
        parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
      } catch {
        // File absent — note it so its later creation invalidates too.
        parts.push(`${rel}:absent`);
      }
    }
    return parts.join('|');
  }

  // -----------------------------------------------------------------------
  // Deterministic repo facts
  // -----------------------------------------------------------------------

  private async buildRepoFacts(): Promise<string> {
    const lines: string[] = ['### Repository Facts', ''];
    lines.push(`Root: ${this.root}`);
    if (this.git) {
      try {
        const branch = await this.git.getCurrentBranch();
        if (branch) lines.push(`Branch: ${branch}`);
      } catch { /* ignore */ }
      try {
        const sha = await this.git.getShortCommitHash();
        if (sha) lines.push(`HEAD: ${sha}`);
      } catch { /* ignore */ }
      try {
        const remote = await this.git.getRemoteOriginUrl();
        if (remote) lines.push(`Remote: ${remote}`);
      } catch { /* ignore */ }
    }
    lines.push('');

    const entries = this.readTopLevelEntries();
    if (entries.length > 0) {
      lines.push('## Top-Level Structure', '');
      for (const e of entries) lines.push(`- ${e}`);
      lines.push('');
    }

    const agentsMd = this.readFileCapped(path.join(this.root, 'AGENTS.md'), MAX_AGENTS_MD_CHARS);
    if (agentsMd) {
      lines.push('## AGENTS.md', '', '```', agentsMd, '```', '');
    }

    const pkgBlock = this.readPackageJsonBlock();
    if (pkgBlock) {
      lines.push('## package.json', '', '```json', pkgBlock, '```', '');
    }

    const readme = this.readReadmeHead();
    if (readme) {
      lines.push('## README (head)', '', '```', readme, '```');
    }

    const keys = this.memory?.list() ?? [];
    if (keys.length > 0) {
      lines.push('', `## Workspace Memory Keys (${keys.length})`, '');
      lines.push(keys.map(k => `- \`${k}\``).join('\n'));
    }

    let out = lines.join('\n').trim();
    if (out.length > MAX_FACTS_CHARS) {
      out = out.slice(0, MAX_FACTS_CHARS) + '\n…(repo facts truncated)';
    }
    return out;
  }

  private readTopLevelEntries(): string[] {
    try {
      const names = fs.readdirSync(this.root).sort();
      const dirs: string[] = [];
      const files: string[] = [];
      for (const n of names) {
        if (EXCLUDED_TREE.has(n)) continue;
        let isDir = false;
        try {
          isDir = fs.statSync(path.join(this.root, n)).isDirectory();
        } catch {
          continue;
        }
        (isDir ? dirs : files).push(n);
      }
      return [...dirs.map(d => `${d}/`), ...files].slice(0, MAX_TREE_ENTRIES);
    } catch {
      return [];
    }
  }

  private readPackageJsonBlock(): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'));
      const out: string[] = [];
      if (pkg.name) out.push(`"name": "${pkg.name}"`);
      if (pkg.version) out.push(`"version": "${pkg.version}"`);
      const scripts = pkg.scripts ? Object.entries(pkg.scripts).slice(0, MAX_PKG_SCRIPTS) : [];
      if (scripts.length > 0) {
        out.push('"scripts": {');
        for (const [k, v] of scripts) out.push(`  "${k}": "${String(v).slice(0, 100)}"`);
        out.push('}');
      }
      const depCount = (n: string): number => (pkg[n] ? Object.keys(pkg[n]).length : 0);
      const depNames = (n: string): string => (pkg[n] ? Object.keys(pkg[n]).slice(0, MAX_DEPS).join(', ') : '');
      out.push(`"dependencies": ${depCount('dependencies')} (${depNames('dependencies')})`);
      out.push(`"devDependencies": ${depCount('devDependencies')} (${depNames('devDependencies')})`);
      return out.join('\n');
    } catch {
      return '';
    }
  }

  private readReadmeHead(): string {
    for (const name of ['README.md', 'README']) {
      const content = this.readFileCapped(path.join(this.root, name), MAX_README_CHARS);
      if (content) {
        return content.split('\n').slice(0, MAX_README_LINES).join('\n');
      }
    }
    return '';
  }

  // -----------------------------------------------------------------------
  // Meta + file helpers
  // -----------------------------------------------------------------------

  private repoFile(): string {
    return path.join(this.dir, REPO_FILE);
  }

  private knowledgeFile(): string {
    return path.join(this.dir, KNOWLEDGE_FILE);
  }

  private workItemFile(id: number): string {
    return path.join(this.dir, `workitem-${id}.md`);
  }

  private metaFile(): string {
    return path.join(this.dir, META_FILE);
  }

  private init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private readMeta(): UnderstandingMeta {
    const content = this.readFileIfExists(this.metaFile());
    if (!content) return {};
    try {
      return JSON.parse(content) as UnderstandingMeta;
    } catch {
      return {};
    }
  }

  private writeMeta(meta: UnderstandingMeta): void {
    this.init();
    fs.writeFileSync(this.metaFile(), JSON.stringify(meta, null, 2), 'utf8');
  }

  private readFileIfExists(file: string): string | null {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  private readFileCapped(file: string, cap: number): string | null {
    const content = this.readFileIfExists(file);
    if (!content) return null;
    if (content.length <= cap) return content;
    return content.slice(0, cap) + '\n…(truncated)';
  }

  private readSummarySection(repoContent: string): string {
    const idx = repoContent.indexOf('### LLM Summary');
    if (idx < 0) return '';
    return repoContent.slice(idx + '### LLM Summary'.length).trim();
  }

  private stripSummarySection(repoContent: string): string {
    const idx = repoContent.indexOf('\n### LLM Summary');
    if (idx < 0) return repoContent.trim();
    return repoContent.slice(0, idx).trim();
  }

  private isEnabled(): boolean {
    try {
      return vscode.workspace.getConfiguration('adoCode').get<boolean>('understanding.enabled', true);
    } catch {
      return true;
    }
  }

  private shouldAutoSummarize(): boolean {
    try {
      return vscode.workspace.getConfiguration('adoCode').get<boolean>('understanding.autoSummarize', true);
    } catch {
      return true;
    }
  }
}

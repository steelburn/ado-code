import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../logger';
import { WorkItemContext } from '../../shared/messages';
import { formatWorkItemContext, DEFAULT_THREAD_BUDGET } from '../../llm/prompts';
import { renderDocDigest, stripDigest, withDigest } from '../../shared/docDigest';
import { hashBlock, stripManagedBlock } from '../../webview/agentsMd';
import { DEFAULT_MAX_ENTRIES, UnderstandingIndex } from './UnderstandingIndex';

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

/** Files whose change invalidates the repo understanding (git identity also counts). */
const WATCHED_FILES = ['AGENTS.md', 'package.json', 'README.md', 'README', 'tsconfig.json'];
/** Fingerprinted by user-authored content only — ADO Code rewrites its managed block. */
const WATCHED_AGENTS_MD = 'AGENTS.md';

/** Top-level entries never listed as repo facts. */
const EXCLUDED_TREE = new Set([
  '.git', '.ado-code', '.vscode', '.vscode-test', 'node_modules',
  'out', 'dist', 'build', 'coverage', 'webview-ui-dist', '.hermes', '.husky',
]);

const MAX_TREE_ENTRIES = 40;
/** Budget for the user-authored AGENTS.md text folded into repo.md. */
const MAX_AGENTS_MD_CHARS = 900;
/** Read window used to find that text past the (possibly large) managed block. */
const MAX_AGENTS_MD_RAW_CHARS = 12000;
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
  'Produce a concise repository understanding in Markdown that lets a future session navigate quickly WITHOUT reading many files. ' +
  'Lead with the directory structure and where the documentation lives (README, AGENTS.md, docs/), then name the key entry files worth reading first. ' +
  'Cover: architecture and how the pieces fit together; key modules/directories and their responsibilities; conventions (naming, structure, error handling, testing); ' +
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
  /** Metadata index over the cache directory (lazily created). */
  private cachedIndex?: UnderstandingIndex;

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
      const repoContent = this.withRepoDigest(content);
      fs.writeFileSync(this.repoFile(), repoContent, 'utf8');
      this.index.upsert({ id: 'repo', kind: 'repo', title: 'Repository map', content: repoContent });
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
      const repoContent = this.withRepoDigest(content);
      fs.writeFileSync(this.repoFile(), repoContent, 'utf8');
      this.index.upsert({ id: 'repo', kind: 'repo', title: 'Repository map', content: repoContent });
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
      this.index.touch(`workitem-${workItem.id}`);
      this.currentWorkItemId = workItem.id;
      return;
    }
    this.init();
    const workItemContent = `${this.workItemDigest(workItem)}\n\n### Work Item\n\n${formatWorkItemContext(workItem)}`;
    fs.writeFileSync(file, workItemContent, 'utf8');
    this.index.upsert({ id: `workitem-${workItem.id}`, kind: 'workitem', title: workItem.title, content: workItemContent });
    this.evictCache();
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
    const knowledgeContent = this.withKnowledgeDigest(combined);
    fs.writeFileSync(file, knowledgeContent, 'utf8');
    this.index.upsert({ id: 'knowledge', kind: 'knowledge', title: 'Prior session knowledge', content: knowledgeContent });
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
    if (repo) {
      parts.push(repo);
      this.index.touch('repo');
    }
    if (this.currentWorkItemId !== undefined) {
      const wi = this.readFileIfExists(this.workItemFile(this.currentWorkItemId));
      if (wi) {
        parts.push(wi);
        this.index.touch(`workitem-${this.currentWorkItemId}`);
      }
    }
    const knowledge = this.readFileIfExists(this.knowledgeFile());
    if (knowledge) {
      parts.push(`### Prior Session Knowledge\n\n${knowledge}`);
      this.index.touch('knowledge');
    }
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
        if (rel === WATCHED_AGENTS_MD) {
          // AGENTS.md is written by ADO Code itself (managed-block sync), and
          // mtime/size would therefore invalidate the cache we generate it from
          // — a feedback loop. Fingerprint only the user-authored text outside
          // the managed block: a managed-block rewrite leaves this unchanged.
          const body = fs.readFileSync(abs, 'utf8');
          parts.push(`${rel}:${hashBlock(stripManagedBlock(body))}`);
          continue;
        }
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

    // Only the user-authored part of AGENTS.md belongs in the facts: the managed
    // block is generated from these very facts (AGENTS.md and repo.md holding the
    // same repository map is what ADO-27359 removes), and it is already in the
    // prompt via AGENTS.md itself.
    const agentsMdFacts = this.readUserAuthoredAgentsMd();
    if (agentsMdFacts) {
      lines.push('## AGENTS.md (user-authored sections)', '', '```', agentsMdFacts, '```', '');
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

  // -----------------------------------------------------------------------
  // Digest-first headers (ADO-27354)
  // -----------------------------------------------------------------------

  /** Digest for repo.md: what sections exist and whether a summary is inlined. */
  private withRepoDigest(content: string): string {
    const body = stripDigest(content);
    const sections = body
      .split('\n')
      .filter((l) => /^#{2,3} /.test(l))
      .map((l) => l.replace(/^#+\s*/, '').trim());
    const hasSummary = /^### LLM Summary/m.test(body);
    return withDigest(
      body,
      renderDocDigest({
        kind: 'repository facts',
        facts: [
          `Sections: ${sections.length > 0 ? sections.join(', ') : '(none)'}`,
          `Size: ${body.length} chars.`,
          hasSummary
            ? 'An LLM summary is inlined under the summary heading below.'
            : 'No LLM summary yet — deterministic facts only.',
        ],
        footer: 'The fingerprint that decides staleness is in "Repository Facts" below; read a line range rather than the whole file.',
      }),
    );
  }

  /** Digest for knowledge.md: how many entries survive and what the newest one is. */
  private withKnowledgeDigest(text: string): string {
    const body = stripDigest(text);
    const entries = body.split('\n## ').filter((e) => e.trim().length > 0);
    const newest = entries.length > 0 ? entries[entries.length - 1].split('\n')[0].replace(/^##\s*/, '') : '';
    return withDigest(
      body,
      renderDocDigest({
        kind: 'distilled session knowledge',
        facts: [
          `Entries kept: ${entries.length} (oldest dropped first once the file passes ${MAX_KNOWLEDGE_CHARS} chars).`,
          `Newest entry: ${newest || '(none)'}`,
          `Size: ${body.length} chars.`,
        ],
        footer: 'Do not re-read this whole file each turn — read the entry you need, or use the workspace-memory tools.',
      }),
    );
  }

  /** Digest for a cached work item, with a live retrieval pointer. */
  private workItemDigest(workItem: WorkItemContext): string {
    const total = workItem.comments?.length ?? 0;
    const shown = Math.min(total, DEFAULT_THREAD_BUDGET.maxComments);
    return renderDocDigest({
      kind: `cached work item #${workItem.id}`,
      facts: [
        `#${workItem.id} — ${workItem.title}`,
        `State: ${workItem.state || '(unknown)'}; comments rendered: ${shown} of ${total}.`,
        `Acceptance criteria: ${workItem.acceptanceCriteria ? 'cached below' : '(none set)'}.`,
      ],
      footer: `Call get_work_item(${workItem.id}) for the full thread and acceptance criteria.`,
    });
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

  /**
   * AGENTS.md minus the ADO Code managed block, capped and annotated with a
   * pointer when anything had to be dropped.
   */
  private readUserAuthoredAgentsMd(): string | null {
    const raw = this.readFileCapped(path.join(this.root, 'AGENTS.md'), MAX_AGENTS_MD_RAW_CHARS);
    if (!raw) return null;
    const authored = stripManagedBlock(raw).trim();
    if (!authored) return null;
    if (authored.length <= MAX_AGENTS_MD_CHARS) return authored;
    const cut = authored.lastIndexOf('\n', MAX_AGENTS_MD_CHARS);
    const head = cut > 0 ? authored.slice(0, cut) : authored.slice(0, MAX_AGENTS_MD_CHARS);
    return `${head.trimEnd()}\n… (truncated — read AGENTS.md for the rest)`;
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

  /**
   * Metadata index over the cache directory (id, title, size, hash,
   * lastAccessed). Rebuilt from disk when missing or corrupt; the markdown
   * files stay the payload and are additionally an export format.
   */
  get index(): UnderstandingIndex {
    if (!this.cachedIndex) this.cachedIndex = new UnderstandingIndex(this.dir);
    return this.cachedIndex;
  }

  /** Configured LRU cap on cached work items (adoCode.understanding.maxEntries). */
  maxEntries(): number {
    try {
      const value = vscode.workspace
        .getConfiguration('adoCode')
        .get<number>('understanding.maxEntries', DEFAULT_MAX_ENTRIES);
      const n = Math.floor(Number(value));
      return Number.isFinite(n) && n >= 10 ? n : DEFAULT_MAX_ENTRIES;
    } catch {
      return DEFAULT_MAX_ENTRIES;
    }
  }

  /**
   * Evict least-recently-accessed work items beyond the cap. repo.md and
   * knowledge.md are always injected into the prompt, so they are protected.
   * Returns the evicted ids, oldest first.
   */
  evictCache(max = this.maxEntries()): string[] {
    return this.index.evictLRU(max, ['repo', 'knowledge']);
  }

  /**
   * Export the cache as markdown into `targetDir` (default:
   * `<understanding>/export`). Copies are verbatim, so the export always
   * matches the cache and the cache files are never modified.
   */
  exportMarkdown(targetDir?: string): { dir: string; files: string[]; manifestPath: string } {
    const dir = targetDir ?? this.index.defaultExportDir();
    const result = this.index.exportTo(dir);
    return { dir, files: result.files, manifestPath: result.manifestPath };
  }

  private shouldAutoSummarize(): boolean {
    try {
      return vscode.workspace.getConfiguration('adoCode').get<boolean>('understanding.autoSummarize', true);
    } catch {
      return true;
    }
  }
}

/**
 * SkillRegistryService — fetch, parse, and install skills from remote registries.
 *
 * Registry format (TSV, one entry per line):
 *   author/repo-name<tab>https://.../SKILL.md<tab>Description text
 *
 * The service:
 *   1. Fetches configured registry URLs and parses TSV
 *   2. Downloads individual SKILL.md files on install
 *   3. Caches registry entries for 5 minutes
 *   4. Converts entries to Skill objects for the catalog
 */

import * as vscode from 'vscode';
import { logger } from './logger';
import { type Skill, type SkillCategory } from '../shared/skillTypes';
import { parseSkillMd, skillFromParsedMd, slugify } from '../shared/parseSkillMd';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  slug: string;        // e.g. "ibelick/baseline-ui"
  url: string;         // URL to SKILL.md
  description: string; // Trigger/description text
}

export interface RegistrySource {
  url: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRIES: RegistrySource[] = [
  { url: 'https://www.ui-skills.com/skills/registry.txt', label: 'UI Skills' },
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// SkillRegistryService
// ---------------------------------------------------------------------------

export class SkillRegistryService {
  private cache: Map<string, RegistryEntry[]> = new Map();
  private cacheExpiry: Map<string, number> = new Map();

  constructor(private _context: vscode.ExtensionContext) {}

  // ── Registry URL management ────────────────────────────────────────

  /** Get configured registry URLs (user settings + built-in defaults). */
  getRegistryUrls(): RegistrySource[] {
    const config = vscode.workspace.getConfiguration('adoCode');
    const customUrls: string[] = config.get<string[]>('skillRegistryUrls', []);
    const sources = [...DEFAULT_REGISTRIES];
    for (const url of customUrls) {
      if (url && !sources.some((s) => s.url === url)) {
        let label: string;
        try {
          label = new URL(url).hostname;
        } catch {
          label = url;
        }
        sources.push({ url, label });
      }
    }
    return sources;
  }

  // ── Fetching ───────────────────────────────────────────────────────

  /** Fetch and parse a single registry TSV file. Uses cache when fresh. */
  async fetchRegistry(source: RegistrySource): Promise<RegistryEntry[]> {
    const cached = this.cache.get(source.url);
    const expiry = this.cacheExpiry.get(source.url) || 0;
    if (cached && Date.now() < expiry) {
      return cached;
    }

    try {
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const entries = this.parseTsv(text);
      this.cache.set(source.url, entries);
      this.cacheExpiry.set(source.url, Date.now() + CACHE_TTL_MS);
      logger.info(
        `SkillRegistry: fetched ${entries.length} entries from ${source.label}`,
      );
      return entries;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`SkillRegistry: failed to fetch ${source.url}: ${msg}`);
      return [];
    }
  }

  /** Fetch all configured registries and return results per source. */
  async fetchAllRegistries(): Promise<
    { source: RegistrySource; entries: RegistryEntry[] }[]
  > {
    const sources = this.getRegistryUrls();
    const results = await Promise.all(
      sources.map(async (source) => ({
        source,
        entries: await this.fetchRegistry(source),
      })),
    );
    return results;
  }

  // ── Skill download ─────────────────────────────────────────────────

  /** Download a SKILL.md from a registry entry and parse it into a Skill. */
  async downloadSkill(
    entry: RegistryEntry,
    _sourceLabel: string,
  ): Promise<Skill | null> {
    try {
      const response = await fetch(entry.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const parsed = parseSkillMd(text);
      const partial = skillFromParsedMd(parsed, entry.url);

      // Derive id from slug (e.g. "ibelick/baseline-ui" → "ibelick-baseline-ui")
      const id = slugify(entry.slug);

      // Infer category from description/tags
      const category = this.inferCategory(
        entry.description,
        partial.tags || [],
      );

      return {
        id,
        name: partial.name || entry.slug.split('/').pop() || entry.slug,
        description: partial.description || entry.description,
        version: partial.version || '1.0.0',
        author: partial.author || entry.slug.split('/')[0] || 'Unknown',
        category,
        tags: partial.tags?.length
          ? partial.tags
          : this.extractTags(entry.description),
        icon: partial.icon || '🧩',
        prompt: partial.prompt,
        knowledge: partial.knowledge,
        installed: false,
        enabled: false,
        builtin: false,
        source: 'registry',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`SkillRegistry: failed to download ${entry.url}: ${msg}`);
      return null;
    }
  }

  /** Convert multiple registry fetch results into Skill objects. */
  async entriesToSkills(
    results: { source: RegistrySource; entries: RegistryEntry[] }[],
  ): Promise<Skill[]> {
    const skills: Skill[] = [];
    for (const { source, entries } of results) {
      // Limit to first 50 per registry to avoid overwhelming the UI
      const limited = entries.slice(0, 50);
      for (const entry of limited) {
        const skill = await this.downloadSkill(entry, source.label);
        if (skill) {
          skills.push(skill);
        }
      }
    }
    return skills;
  }

  // ── Private helpers ────────────────────────────────────────────────

  /** Parse TSV text into RegistryEntry objects. */
  private parseTsv(text: string): RegistryEntry[] {
    const entries: RegistryEntry[] = [];
    const lines = text.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        entries.push({
          slug: parts[0].trim(),
          url: parts[1].trim(),
          description: parts[2]?.trim() || '',
        });
      }
    }
    return entries;
  }

  /** Infer skill category from description text and tags. */
  private inferCategory(description: string, tags: string[]): SkillCategory {
    const text = (description + ' ' + tags.join(' ')).toLowerCase();

    // UI Skills registry categories (match website taxonomy)
    if (text.includes('animation') || text.includes('motion') || text.includes('gsap') || text.includes('scrolltrigger') || text.includes('framer')) return 'motion';
    if (text.includes('design system') || text.includes('tokens') || text.includes('component library') || text.includes('design token')) return 'systems';
    if (text.includes('visual') || text.includes('canvas') || text.includes('poster') || text.includes('illustration') || text.includes('shadow') || text.includes('blur')) return 'visual';
    if (text.includes('interaction') || text.includes('micro-interaction') || text.includes('hover') || text.includes('drag') || text.includes('gesture')) return 'interaction';
    if (text.includes('craft') || text.includes('polish') || text.includes('refine') || text.includes('quality')) return 'craft';
    if (text.includes('taste') || text.includes('brutalist') || text.includes('minimalist') || text.includes('swiss')) return 'taste';
    if (text.includes('typography') || text.includes('font') || text.includes('type scale') || text.includes('letter-spacing')) return 'typography';
    if (text.includes('color') || text.includes('palette') || text.includes('oklch') || text.includes('color system')) return 'color';
    if (text.includes('three.js') || text.includes('threejs') || text.includes('webgl') || text.includes('3d') || text.includes('globe')) return '3d';
    if (text.includes('vue') || text.includes('nuxt')) return 'frontend';
    if (text.includes('react') || text.includes('next.js') || text.includes('nextjs') || text.includes('remix')) return 'frontend';
    if (text.includes('svelte')) return 'frontend';
    if (text.includes('architecture') || text.includes('monorepo') || text.includes('turborepo')) return 'architecture';
    if (text.includes('testing') || text.includes('vitest') || text.includes('playwright') || text.includes('jest')) return 'testing';
    if (text.includes('debug') || text.includes('diagnos')) return 'debugging';
    if (text.includes('code quality') || text.includes('lint') || text.includes('review') || text.includes('audit')) return 'code-quality';
    if (text.includes('tooling') || text.includes('vite') || text.includes('webpack') || text.includes('bundler') || text.includes('pnpm')) return 'tooling';
    if (text.includes('remotion') || text.includes('video')) return 'video';

    // Builtin ADO Code categories (fallback)
    if (text.includes('accessibility') || text.includes('a11y') || text.includes('wcag')) return 'accessibility';
    if (text.includes('security') || text.includes('vulnerability')) return 'security';
    if (text.includes('refactor') || text.includes('clean')) return 'refactoring';
    if (text.includes('deploy') || text.includes('ci/cd') || text.includes('docker')) return 'deployment';
    if (text.includes('database') || text.includes('sql') || text.includes('migration')) return 'database';
    if (text.includes('performance') || text.includes('optimize')) return 'performance';
    if (text.includes('document') || text.includes('readme')) return 'documentation';

    return 'custom';
  }

  /** Extract tags from description text. */
  private extractTags(description: string): string[] {
    const tags: string[] = [];
    const keywords = [
      'ui',
      'css',
      'react',
      'vue',
      'animation',
      'design',
      'accessibility',
      'testing',
      'security',
      'performance',
      'tailwind',
      'threejs',
      'svelte',
      'nextjs',
    ];
    const lower = description.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        tags.push(kw);
      }
    }
    return tags;
  }
}

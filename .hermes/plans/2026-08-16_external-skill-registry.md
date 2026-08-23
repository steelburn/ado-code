# External Skill Registry — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add support for external skill registries (TSV format) so users can browse and install community skills from URLs like `https://www.ui-skills.com/skills/registry.txt`.

**Architecture:** A new `SkillRegistryService` fetches and parses remote TSV registries, downloads SKILL.md files on install, and caches them. Registry skills appear in the existing SkillCatalog UI with a "registry" source badge. The SkillManager coordinates between builtin, local-imported, and registry skills.

**Tech Stack:** TypeScript, VS Code extension API, no runtime deps.

---

### Task 1: Add `registry` source type

**Files:**
- Modify: `src/shared/skillTypes.ts:22` — add `'registry'` to `Skill.source` union
- Modify: `src/webview-ui/src/types.ts:250` — same change in webview copy

**Step 1: Update skillTypes.ts**

Change:
```typescript
source: 'builtin' | 'marketplace' | 'local';
```
To:
```typescript
source: 'builtin' | 'marketplace' | 'local' | 'registry';
```

**Step 2: Update webview types.ts**

Same change on the duplicated type.

**Step 3: Add registry badge CSS**

In `src/webview-ui/src/components/SkillCatalog/styles.css`, add after `.skill-source-local`:
```css
.skill-source-registry {
  background: rgba(187, 128, 255, 0.15);
  color: var(--vscode-terminal-ansiMagenta);
}
```

**Step 4: Verify**
Run: `npm run compile`
Expected: Clean compilation.

---

### Task 2: Create SkillRegistryService

**Files:**
- Create: `src/services/SkillRegistryService.ts`

**Step 1: Create the service**

```typescript
/**
 * SkillRegistryService — fetch, parse, and install skills from remote registries.
 *
 * Registry format (TSV):
 *   author/repo-name<tab>https://.../SKILL.md<tab>Description text
 */

import * as vscode from 'vscode';
import { logger } from './logger';
import { type Skill, type SkillCategory } from '../shared/skillTypes';
import { parseSkillMd, skillFromParsedMd, slugify } from '../shared/parseSkillMd';

export interface RegistryEntry {
  slug: string;        // e.g. "ibelick/baseline-ui"
  url: string;         // URL to SKILL.md
  description: string; // Trigger/description text
}

export interface RegistrySource {
  url: string;
  label: string;
}

const DEFAULT_REGISTRIES: RegistrySource[] = [
  { url: 'https://www.ui-skills.com/skills/registry.txt', label: 'UI Skills' },
];

export class SkillRegistryService {
  private cache: Map<string, RegistryEntry[]> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private context: vscode.ExtensionContext) {}

  /** Get configured registry URLs (user settings + defaults). */
  getRegistryUrls(): RegistrySource[] {
    const config = vscode.workspace.getConfiguration('adoCode');
    const customUrls: string[] = config.get<string[]>('skillRegistryUrls', []);
    const sources = [...DEFAULT_REGISTRIES];
    for (const url of customUrls) {
      if (!sources.some(s => s.url === url)) {
        sources.push({ url, label: new URL(url).hostname });
      }
    }
    return sources;
  }

  /** Fetch and parse a registry TSV file. Uses cache when fresh. */
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
      this.cacheExpiry.set(source.url, Date.now() + SkillRegistryService.CACHE_TTL_MS);
      logger.info(`SkillRegistry: fetched ${entries.length} entries from ${source.label}`);
      return entries;
    } catch (err: any) {
      logger.warn(`SkillRegistry: failed to fetch ${source.url}: ${err.message}`);
      return [];
    }
  }

  /** Fetch all registries and merge entries. */
  async fetchAllRegistries(): Promise<{ source: RegistrySource; entries: RegistryEntry[] }[]> {
    const sources = this.getRegistryUrls();
    const results = await Promise.all(
      sources.map(async (source) => ({
        source,
        entries: await this.fetchRegistry(source),
      }))
    );
    return results;
  }

  /** Download a SKILL.md from a registry entry and parse it into a Skill. */
  async downloadSkill(entry: RegistryEntry, sourceLabel: string): Promise<Skill | null> {
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
      const category = this.inferCategory(entry.description, partial.tags || []);

      return {
        id,
        name: partial.name || entry.slug.split('/').pop() || entry.slug,
        description: partial.description || entry.description,
        version: partial.version || '1.0.0',
        author: partial.author || entry.slug.split('/')[0] || 'Unknown',
        category,
        tags: partial.tags?.length ? partial.tags : this.extractTags(entry.description),
        icon: partial.icon || '🧩',
        prompt: partial.prompt,
        knowledge: partial.knowledge,
        installed: false,
        enabled: false,
        builtin: false,
        source: 'registry',
      };
    } catch (err: any) {
      logger.warn(`SkillRegistry: failed to download ${entry.url}: ${err.message}`);
      return null;
    }
  }

  /** Convert registry entries to Skill objects (not yet installed). */
  async entriesToSkills(
    results: { source: RegistrySource; entries: RegistryEntry[] }[]
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

  // ── Private helpers ───────────────────────────────────────────────

  /** Parse TSV text into RegistryEntry objects. */
  private parseTsv(text: string): RegistryEntry[] {
    const entries: RegistryEntry[] = [];
    const lines = text.split('\n').filter(l => l.trim());
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

  /** Infer skill category from description text. */
  private inferCategory(description: string, tags: string[]): SkillCategory {
    const text = (description + ' ' + tags.join(' ')).toLowerCase();
    if (text.includes('accessibility') || text.includes('a11y') || text.includes('wcag')) return 'accessibility';
    if (text.includes('security') || text.includes('audit') || text.includes('vulnerability')) return 'security';
    if (text.includes('test') || text.includes('spec')) return 'testing';
    if (text.includes('review') || text.includes('lint')) return 'code-review';
    if (text.includes('document') || text.includes('readme')) return 'documentation';
    if (text.includes('refactor') || text.includes('clean')) return 'refactoring';
    if (text.includes('deploy') || text.includes('ci/cd') || text.includes('docker')) return 'deployment';
    if (text.includes('database') || text.includes('sql') || text.includes('migration')) return 'database';
    if (text.includes('performance') || text.includes('optimize')) return 'performance';
    return 'custom';
  }

  /** Extract tags from description text. */
  private extractTags(description: string): string[] {
    const tags: string[] = [];
    const keywords = ['ui', 'css', 'react', 'vue', 'animation', 'design', 'accessibility', 'testing', 'security', 'performance'];
    const lower = description.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) tags.push(kw);
    }
    return tags;
  }
}
```

**Step 2: Verify**
Run: `npm run compile`
Expected: Clean compilation.

---

### Task 3: Add VS Code setting for registry URLs

**Files:**
- Modify: `package.json` — add `adoCode.skillRegistryUrls` setting

**Step 1: Add the setting**

In `package.json`, inside `contributes.configuration.properties`, add:
```json
"adoCode.skillRegistryUrls": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "description": "Additional skill registry URLs to fetch skills from (TSV format). The built-in UI Skills registry is always included."
}
```

**Step 2: Verify**
Run: `npm run compile`
Expected: Clean compilation.

---

### Task 4: Add message types for registry operations

**Files:**
- Modify: `src/shared/messages.ts` — add registry message types

**Step 1: Add WebviewToExtension messages**

Add after the existing skill messages:
```typescript
// Skill registry
| { type: 'getRegistrySkills' }
| { type: 'installRegistrySkill'; entry: { slug: string; url: string; description: string } }
```

**Step 2: Add ExtensionToWebview messages**

Add after `skillImportResult`:
```typescript
// Skill registry
| { type: 'registrySkills'; skills: Skill[] }
| { type: 'registryInstallResult'; success: boolean; skill?: Skill; error?: string }
```

**Step 3: Verify**
Run: `npm run compile`
Expected: Clean compilation.

---

### Task 5: Wire up SkillRegistryService in composition

**Files:**
- Modify: `src/services.ts` — import and instantiate SkillRegistryService
- Modify: `src/webview/ChatViewProvider.ts` — handle registry messages

**Step 1: Update services.ts**

Add `SkillRegistryService` to the Services interface and createServices:
```typescript
import { SkillRegistryService } from './services/SkillRegistryService';

export interface Services {
  // ... existing ...
  skillRegistry: SkillRegistryService;
}

// In createServices():
skillRegistry: new SkillRegistryService(context),
```

**Step 2: Handle messages in ChatViewProvider**

Add message handlers for `getRegistrySkills` and `installRegistrySkill`:
```typescript
case 'getRegistrySkills': {
  const results = await this.services.skillRegistry.fetchAllRegistries();
  const registrySkills = await this.services.skillRegistry.entriesToSkills(results);
  // Mark already-installed ones
  const installed = new Set(this.services.skills.getAllSkills().map(s => s.id));
  const skills = registrySkills.map(s => ({
    ...s,
    installed: installed.has(s.id),
    enabled: installed.has(s.id),
  }));
  this.postMessage({ type: 'registrySkills', skills });
  break;
}
case 'installRegistrySkill': {
  try {
    const entry = message.entry;
    const source = this.services.skillRegistry.getRegistryUrls()[0];
    const skill = await this.services.skillRegistry.downloadSkill(entry, source.label);
    if (!skill) {
      this.postMessage({ type: 'registryInstallResult', success: false, error: 'Failed to download skill' });
      break;
    }
    skill.installed = true;
    skill.enabled = true;
    const ok = this.services.skills.installSkill(skill);
    if (ok) {
      this.postMessage({ type: 'registryInstallResult', success: true, skill });
      this.postMessage({ type: 'skillCatalog', skills: this.services.skills.getAllSkills() });
    } else {
      this.postMessage({ type: 'registryInstallResult', success: false, error: 'Skill already exists' });
    }
  } catch (err: any) {
    this.postMessage({ type: 'registryInstallResult', success: false, error: err.message });
  }
  break;
}
```

**Step 3: Verify**
Run: `npm run compile`
Expected: Clean compilation.

---

### Task 6: Update SkillCatalog UI to show registry skills

**Files:**
- Modify: `src/webview-ui/src/components/SkillCatalog/index.tsx` — add registry tab/filter

**Step 1: Add registry tab**

Add a "Registry" tab alongside "All", "Installed", "Available" tabs that triggers `getRegistrySkills` and shows the results.

**Step 2: Add registry badge on SkillCard**

The source badge already renders via `skill.source` — the CSS from Task 1 handles the visual.

**Step 3: Verify**
Run: `npm run build:webview && npm run compile`
Expected: Clean build.

---

### Task 7: End-to-end verification

**Step 1: Full build**
Run: `npm run build:all`
Expected: Clean build.

**Step 2: Run tests**
Run: `npm test`
Expected: All tests pass.

**Step 3: Manual verification**
- Open skill catalog → should see builtin skills
- Registry tab → should load UI Skills registry entries
- Click Install on a registry skill → should download SKILL.md and install
- Installed skill should appear in "Installed" tab

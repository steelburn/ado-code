/**
 * parseSkillMd — Parse a SKILL.md file with YAML frontmatter.
 *
 * Format:
 *   ---
 *   name: My Skill
 *   description: Does something cool
 *   version: 1.0.0
 *   author: Someone
 *   category: custom
 *   tags: [foo, bar]
 *   icon: 🎯
 *   ---
 *   # Skill body (markdown)
 *   This becomes the prompt/knowledge content.
 *
 * No external YAML parser — minimal hand-rolled parser for the subset
 * we actually need (strings, numbers, booleans, arrays of strings).
 */

import { type Skill, type SkillCategory } from './skillTypes';

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Parse raw SKILL.md text into frontmatter + body. */
export function parseSkillMd(raw: string): ParsedSkillMd {
  const trimmed = raw.replace(/^\uFEFF/, ''); // strip BOM

  // Match YAML frontmatter between --- delimiters
  const fmMatch = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat entire content as body
    return { frontmatter: {}, body: trimmed };
  }

  const rawFm = fmMatch[1];
  const body = fmMatch[2].trim();
  const frontmatter = parseSimpleYaml(rawFm);

  return { frontmatter, body };
}

/**
 * Convert a ParsedSkillMd into a Skill object suitable for SkillManager.
 * Fills in defaults for missing fields.
 */
export function skillFromParsedMd(parsed: ParsedSkillMd): Partial<Skill> {
  const fm = parsed.frontmatter;
  return {
    id: slugify(String(fm.id || fm.name || 'imported-skill')),
    name: String(fm.name || 'Imported Skill'),
    description: String(fm.description || parsed.body.slice(0, 120) || 'No description'),
    version: String(fm.version || '1.0.0'),
    author: String(fm.author || 'Custom'),
    category: validateCategory(fm.category),
    tags: toArray(fm.tags),
    icon: String(fm.icon || '🧩'),
    prompt: parsed.body || undefined,
    knowledge: !parsed.body && fm.knowledge ? String(fm.knowledge) : undefined,
  };
}

// ── Minimal YAML parser (subset) ───────────────────────────────

function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = '';
  let currentValue = '';
  let inMultiline = false;

  for (const line of lines) {
    // Check for YAML key: value
    const kvMatch = line.match(/^(\w[\w.-]*):\s*(.*)$/);

    if (inMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        // Continuation of multiline value
        currentValue += (currentValue ? '\n' : '') + line.trim();
        continue;
      } else {
        // End of multiline — save and start new
        result[currentKey] = parseYamlValue(currentValue);
        inMultiline = false;
        currentKey = '';
        currentValue = '';
      }
    }

    if (kvMatch) {
      // Save previous key if exists
      if (currentKey) {
        result[currentKey] = parseYamlValue(currentValue);
      }
      currentKey = kvMatch[1];
      currentValue = kvMatch[2].trim();

      // Check for multiline (value is empty and next lines are indented)
      if (!currentValue) {
        inMultiline = true;
        currentValue = '';
      }
    } else if (currentKey && line.startsWith('  ')) {
      // Nested content under current key (metadata, etc.) — skip for now
    }
  }

  // Save last key
  if (currentKey) {
    result[currentKey] = parseYamlValue(currentValue);
  }

  return result;
}

/** Parse a YAML scalar value into a JS type. */
function parseYamlValue(raw: string): unknown {
  if (!raw) return '';

  // Strip surrounding quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Null
  if (raw === 'null' || raw === '~') return null;

  // Array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
  }

  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;

  return raw;
}

/** Ensure value is a string array. */
function toArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string' && val) return [val];
  return [];
}

/** Validate category against known SkillCategory values. */
function validateCategory(val: unknown): SkillCategory {
  const valid: SkillCategory[] = [
    // Builtin ADO Code categories
    'code-review', 'documentation', 'testing', 'refactoring',
    'deployment', 'database', 'security', 'performance', 'accessibility',
    // UI Skills registry categories
    'motion', 'systems', 'visual', 'interaction', 'craft', 'taste',
    'typography', 'color', '3d', 'frontend', 'architecture', 'debugging',
    'code-quality', 'tooling', 'video', 'frameworks',
    // Fallback
    'custom',
  ];
  const s = String(val || 'custom').toLowerCase();
  return valid.includes(s as SkillCategory) ? (s as SkillCategory) : 'custom';
}

/** Convert a string to a URL-safe slug. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

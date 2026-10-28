/**
 * Skill injection budget (ADO-27360).
 *
 * Skills are injected as prompt/knowledge content. A large SKILL.md used to
 * land in context whole — the same failure mode as an oversized memory entry.
 * The fix mirrors skills-that-reference-sub-files: inject the head of the file
 * plus an outline of the remaining sections and the sub-files the skill itself
 * references, so the model can decide what to load instead of paying for all
 * of it on every turn.
 *
 * Everything here is pure except `readSkillBudget()`, which reads the setting.
 */

import * as vscode from 'vscode';

/** Setting holding the per-skill injection ceiling. */
export const SKILL_MAX_CHARS_SETTING = 'adoCode.skills.maxInjectedChars';

/** Default ceiling for one injected skill. */
export const DEFAULT_SKILL_MAX_CHARS = 4000;

/** Read the configured ceiling, falling back to the default. */
export function readSkillBudget(): number {
  try {
    const raw = vscode.workspace
      .getConfiguration('adoCode')
      .get<number>('skills.maxInjectedChars', DEFAULT_SKILL_MAX_CHARS);
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 200) return Math.floor(raw);
  } catch {
    /* no workspace / stub host — use the default */
  }
  return DEFAULT_SKILL_MAX_CHARS;
}

/**
 * Sub-files a SKILL.md points at: markdown link targets and backticked
 * relative paths, restricted to things that look like files.
 */
export function extractSkillSubFiles(content: string, limit = 8): string[] {
  const found = new Set<string>();
  const isFile = (p: string) => /\.(md|txt|json|ya?ml|py|ts|js|sh|tsx|jsx|csv)$/i.test(p);
  for (const m of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const p = m[1];
    if (!/^https?:/i.test(p) && isFile(p)) found.add(p);
  }
  for (const m of content.matchAll(/`([\w./-]+\/[\w./-]+)`/g)) {
    if (isFile(m[1])) found.add(m[1]);
  }
  return [...found].slice(0, limit);
}

/** Result of applying the budget to one skill payload. */
export interface CappedSkill {
  /** Text to inject (identical to the input when it fits). */
  content: string;
  truncated: boolean;
  omittedChars: number;
  /** Sub-file references surfaced as pointers when the cap was hit. */
  subFiles: string[];
}

/**
 * Apply the skill budget. Content at or under the cap is returned unchanged —
 * small skills must inject byte-for-byte as before.
 */
export function capSkillContent(
  content: string,
  options: { maxChars?: number; skillName?: string } = {},
): CappedSkill {
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_SKILL_MAX_CHARS);
  if (content.length <= maxChars) {
    return { content, truncated: false, omittedChars: 0, subFiles: [] };
  }
  // Cut on a line boundary so the tail is never a half sentence.
  const hard = content.slice(0, maxChars);
  const breakAt = hard.lastIndexOf('\n');
  const head = (breakAt > maxChars * 0.6 ? hard.slice(0, breakAt) : hard).trimEnd();
  const rest = content.slice(head.length);
  const omittedChars = rest.length;

  const headings = [...rest.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].trim());
  const subFiles = extractSkillSubFiles(content);

  const notes: string[] = [
    `_…skill content truncated: ${omittedChars} of ${content.length} chars omitted (budget ${maxChars}, \`${SKILL_MAX_CHARS_SETTING}\`)._`,
  ];
  if (headings.length > 0) {
    notes.push(`_Remaining sections not injected: ${headings.join(' · ')}._`);
  }
  if (subFiles.length > 0) {
    notes.push(`_Sub-files referenced by this skill (read on demand): ${subFiles.map((f) => `\`${f}\``).join(', ')}._`);
  }
  if (headings.length === 0 && subFiles.length === 0) {
    notes.push('_Re-run `execute_skill` with a narrower input if you need the omitted part._');
  }

  return { content: `${head}\n\n${notes.join('\n')}`, truncated: true, omittedChars, subFiles };
}

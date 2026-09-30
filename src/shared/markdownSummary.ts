/**
 * markdownSummary — pure helpers for turning a markdown document (such as a
 * workspace memory `.md` file) into a short, human-readable one-liner.
 *
 * Used by the status panel so memory entries show a parsed preview instead of
 * a bare key. No `vscode` dependency, so it is unit-testable on its own.
 */

/** Strip common inline markdown syntax from a single line. */
export function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')                // ATX headings
    .replace(/^[-*+]\s+/, '')                 // bullets
    .replace(/^\d+[.)]\s+/, '')               // ordered list markers
    .replace(/^>\s*/, '')                     // block quotes
    .replace(/^\s*[-*_]{3,}\s*$/, '')         // horizontal rules / frontmatter fences
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links → label
    .replace(/[*_`~]/g, '');                  // emphasis / inline code
}

/**
 * Reduce a markdown document to its first content-bearing line, markdown
 * syntax stripped and truncated to `max` characters. A leading YAML
 * frontmatter block is skipped.
 */
export function summarizeMarkdown(content: string, max = 64): string {
  const lines = content.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) start = end + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const plain = stripMarkdown(lines[i]).trim();
    if (!plain) continue;
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  return '(empty)';
}

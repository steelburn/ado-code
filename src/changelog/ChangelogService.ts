import * as fs from 'fs';
import * as path from 'path';

export interface ChangelogEntry {
  workItemId: number;
  title: string;
  state: string;
  date: string;
  workItemUrl: string;
  branch?: string;      // Q6: implementing branch, when detectable
  commitHash?: string;  // Q6: short commit hash, when detectable
}

export class ChangelogService {
  constructor(private workspaceRoot: string) {}

  /**
   * Append an entry under the Unreleased section of CHANGELOG.md.
   * Creates the file (with Keep-a-Changelog skeleton) if it doesn't exist.
   * Returns the changelog file path.
   */
  async addEntry(entry: ChangelogEntry): Promise<string> {
    const filePath = path.join(this.workspaceRoot, 'CHANGELOG.md');
    let content = '';

    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    } else {
      content = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

`;
    }

    const entryLine = `- ${entry.state} [ADO-${entry.workItemId}](${entry.workItemUrl}): ${entry.title} (${entry.date})` +
      (entry.branch || entry.commitHash
        ? ` — \`${[entry.branch, entry.commitHash].filter(Boolean).join(' @ ')}\``
        : '');

    // Insert under the first "## [Unreleased]" heading, or append at top
    const unreleasedIndex = content.indexOf('## [Unreleased]');
    if (unreleasedIndex >= 0) {
      // Guard against a missing trailing newline (indexOf -> -1), which would
      // otherwise corrupt the file by inserting at position 0.
      const newlineIdx = content.indexOf('\n', unreleasedIndex);
      const insertAt = newlineIdx === -1 ? content.length : newlineIdx + 1;
      content = content.slice(0, insertAt) + entryLine + '\n' + content.slice(insertAt);
    } else {
      content = content + '\n## [Unreleased]\n\n' + entryLine + '\n';
    }

    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /** Check whether an entry for this work item already exists (idempotency). */
  hasEntry(workItemId: number): boolean {
    const filePath = path.join(this.workspaceRoot, 'CHANGELOG.md');
    if (!fs.existsSync(filePath)) return false;
    // Line-anchored match: `ADO-42` must not match `ADO-421`. Match the
    // bracketed markdown link form `[ADO-42](` OR a bare `ADO-42` at a
    // word boundary.
    const content = fs.readFileSync(filePath, 'utf8');
    return new RegExp(`\\[ADO-${workItemId}\\]\\(|ADO-${workItemId}(?!\\d)`).test(content);
  }

  /**
   * Format the changelog entry as a comment to post on the ADO work item.
   * ADO's markdown engine collapses single newlines (a soft break needs two
   * trailing spaces), so every block is separated by a blank line — paragraph
   * breaks always survive. The work item URL is expected to be
   * percent-encoded (see ChatViewProvider.updateWorkItemState) so project
   * names with spaces render as a real link instead of spilling literal text.
   */
  formatForAdo(entry: ChangelogEntry): string {
    const lines = [
      `**Changelog entry added (${entry.state}):**`,
      '',
      `- **ADO-${entry.workItemId}** — ${entry.title} _(${entry.date})_`,
      `- [Open in Azure DevOps](${entry.workItemUrl})`,
    ];
    if (entry.branch || entry.commitHash) {
      lines.push(`- Branch: \`${[entry.branch, entry.commitHash].filter(Boolean).join(' @ ')}\``);
    }
    lines.push('', '_Added automatically by ADO Code on task completion._');
    return lines.join('\n');
  }
}

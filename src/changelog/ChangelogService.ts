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

  /**
   * True when CHANGELOG.md already carries an entry *for* this work item —
   * the idempotency guard for the completion hook.
   *
   * Only the bullet `addEntry()` writes counts: a markdown link to the work
   * item at the start of a list line (`- <state> [ADO-42](<url>): …`).
   * Searching for a bare `ADO-<id>` anywhere in the file is not safe — prose
   * that merely quotes the id (a branch name such as
   * `feature/ADO-42-<slug>-<token>`) made the guard report an undocumented
   * item as already documented, so the completion hook silently skipped its
   * entry (ADO-26933). Anchoring to the bullet also keeps a mid-sentence link
   * from counting, and the literal `]` after the id keeps `ADO-42` from
   * matching `ADO-421`.
   */
  hasEntry(workItemId: number): boolean {
    const filePath = path.join(this.workspaceRoot, 'CHANGELOG.md');
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    const entryBullet = new RegExp(`^[ \\t]*[-*][ \\t]+.*\\[ADO-${workItemId}\\]\\(`, 'm');
    return entryBullet.test(content);
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

// ── Completion-entry helpers ───────────────────────────────────────────────
// Pure, so the completion hook's two decisions — which title to record and
// whether to record a branch pointer — are testable without VS Code.

/** Branches that never carry a work item's implementation commits. */
const NON_IMPLEMENTING_BRANCHES = new Set(['main', 'master', 'trunk', 'develop']);

function stripRefPrefix(branch: string): string {
  const name = branch.trim();
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name;
}

/**
 * True when `branch` could be carrying this work item's commits. The default /
 * integration branches and a detached HEAD never do, so recording one as the
 * entry's implementing branch — plus a commit hash that the next squash
 * destroys — would be a pointer that lies (ADO-26934).
 */
export function isImplementingBranch(branch: string | null | undefined): boolean {
  if (!branch) return false;
  const name = stripRefPrefix(branch);
  if (!name || name.startsWith('HEAD')) return false; // detached HEAD
  return !NON_IMPLEMENTING_BRANCHES.has(name.toLowerCase());
}

/**
 * The title of the work item actually being completed — never another item's
 * title (ADO-26934). Falls back to a neutral, non-empty label (never
 * `#undefined`) when the lookup did not resolve.
 */
export function resolveEntryTitle(
  closedItemTitle: string | null | undefined,
  workItemId: number,
): string {
  const cleaned = (closedItemTitle ?? '').trim();
  return cleaned.length > 0 ? cleaned : `Work item ${workItemId}`;
}

export interface CompletionEntryInput {
  workItemId: number;
  /** `AdoWorkItem.fields['System.Title']` of the item being completed. */
  closedItemTitle?: string | null;
  state: string;
  date: string;
  workItemUrl: string;
  branch?: string | null;
  commitHash?: string | null;
}

/** Build the entry recorded when a work item completes (ADO-26933/26934). */
export function buildCompletionEntry(input: CompletionEntryInput): ChangelogEntry {
  const implementing = isImplementingBranch(input.branch);
  return {
    workItemId: input.workItemId,
    title: resolveEntryTitle(input.closedItemTitle, input.workItemId),
    state: input.state,
    date: input.date,
    workItemUrl: input.workItemUrl,
    branch: implementing ? stripRefPrefix(input.branch as string) : undefined,
    commitHash: implementing ? (input.commitHash ?? undefined) : undefined,
  };
}

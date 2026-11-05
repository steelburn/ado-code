/**
 * The startup "What's New" announcement.
 *
 * WHY THIS EXISTS
 * ---------------
 * The changelog used to be announced at the very END of `activate()` and only
 * after `await vscode.window.showInformationMessage(...)` — a promise that
 * settles only once the user reacts to the notification. That had two bad
 * consequences:
 *
 *   1. a FRESH INSTALL (no stored `lastSeenVersion`) skipped the block entirely,
 *      so a user whose chat webview was still on its pre-config spinner had no
 *      way at all to see that ADO Code had loaded — the changelog was the one
 *      piece of UI that could have told them, and it was unreachable;
 *   2. the awaited prompt sat on the activation path, so everything after it
 *      (the version write, the "ready in Xms" log line) waited for the user.
 *
 * So the decision, the section selection and the panel HTML live here, free of
 * the `vscode` module and of any I/O the caller cannot bound: activation can
 * ask "announce or not?" synchronously, at the top, and hand the result to a
 * fire-and-forget notification. `readFile` is injectable so the rules are
 * testable without an extension host.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractChangelogSection, renderChangelogMarkdown } from './changelogMarkdown';

/** What (if anything) the current activation should announce. */
export type ChangelogAnnouncement = 'first-run' | 'update' | null;

/**
 * Decide whether this activation should announce the changelog.
 *
 * - no stored version            → `first-run` (nothing was ever shown)
 * - stored version ≠ current one → `update`
 * - same version                 → `null` (already seen; stays quiet)
 */
export function changelogAnnouncement(
  lastSeenVersion: string | undefined | null,
  currentVersion: string | undefined | null
): ChangelogAnnouncement {
  const current = (currentVersion ?? '').trim();
  if (!current) return null;
  const lastSeen = (lastSeenVersion ?? '').trim();
  if (!lastSeen) return 'first-run';
  return lastSeen === current ? null : 'update';
}

/** Notification text for an announcement (the button label is added by the caller). */
export function changelogNotificationText(kind: Exclude<ChangelogAnnouncement, null>, version: string): string {
  return kind === 'first-run'
    ? `ADO Code ${version} is ready — see what it brings`
    : `ADO Code updated to ${version}`;
}

/** Injectable file reader, so the section lookup can be tested without disk. */
export type ReadFile = (filePath: string) => string;

const defaultReadFile: ReadFile = (filePath) => fs.readFileSync(filePath, 'utf8');

/** Read the bundled CHANGELOG.md, or `undefined` when it is not readable. */
export function readChangelog(extensionPath: string, read: ReadFile = defaultReadFile): string | undefined {
  try {
    return read(path.join(extensionPath, 'CHANGELOG.md'));
  } catch {
    return undefined;
  }
}

/**
 * The `## [<version>]` section of a CHANGELOG.md, falling back to the newest
 * versioned section when `version` is not in the file (development builds run
 * an unpublished version, and an empty panel is worse than the last release).
 */
export function changelogSectionFor(changelog: string, version: string): string | undefined {
  const exact = version ? extractChangelogSection(changelog, version) : undefined;
  if (exact) return exact;

  const newest = /^##\s*\[?v?(\d+\.\d+\.\d+)\]?/m.exec(changelog);
  if (!newest) return undefined;
  return extractChangelogSection(changelog, newest[1]);
}

/** Minimal HTML escaping for values interpolated into the panel. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ChangelogPanelOptions {
  /** First install rather than an update — adds the welcome lead-in. */
  firstRun?: boolean;
}

/** Full standalone HTML page for the What's New panel. */
export function changelogPanelHtml(version: string, section: string, options: ChangelogPanelOptions = {}): string {
  const lead = options.firstRun
    ? `<p class="lead">Welcome to ADO Code — this is what the extension brings. ` +
      `The panel is standalone, so it stays readable while the chat view is still starting.</p>`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; line-height: 1.6; }
    h2 { color: var(--vscode-charts-green); }
    h3 { margin-top: 16px; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; }
    strong { color: var(--vscode-charts-blue); }
    p { margin: 8px 0; }
    code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
    a { color: var(--vscode-textLink-foreground); }
    hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }
    .lead { opacity: 0.85; }
  </style>
</head>
<body>
  <h2>ADO Code ${escapeHtml(version)}</h2>
  ${lead}
  ${renderChangelogMarkdown(section)}
</body>
</html>`;
}

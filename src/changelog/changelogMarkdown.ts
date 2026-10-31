/**
 * Render a CHANGELOG.md section for the "What's New" webview panel.
 *
 * WHY THIS EXISTS
 * ---------------
 * CHANGELOG.md is authored hard-wrapped at ~100 columns, so one bullet spans
 * several physical lines. The panel used to render the section line by line —
 * `<li>` for lines starting with "- ", nothing at all for everything else — so
 * every wrapped bullet was cut at its first line and read like a truncated
 * half sentence ("The remote console is now a single-page app, opened by the
 * QR code. It used to be").
 *
 * `reflowWrappedLines()` folds the continuation lines back into the block they
 * belong to (bullet, paragraph, blockquote) and `renderChangelogMarkdown()`
 * hands the folded markdown to the shared `markdownToHtml()` renderer, so the
 * whole entry — plus its bold/italic/inline-code — reaches the panel.
 */
import { markdownToHtml } from '../ado/markdownToHtml';

/** A level-1..6 heading: opens a block, never absorbs the following line. */
const HEADING = /^\s{0,3}#{1,6}\s/;
/** A bullet, checkbox or numbered item. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
/** A thematic break — a block of its own. */
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
/** A fenced code block delimiter. */
const FENCE = /^\s{0,3}(?:```|~~~)/;
/** A blockquote marker (its text is folded like a paragraph). */
const QUOTE = /^\s{0,3}>\s?/;

type BlockKind = 'blank' | 'heading' | 'item' | 'quote' | 'para' | 'code';

/**
 * Fold hard-wrapped continuation lines into the block they continue.
 *
 * A line that opens a block (heading, rule, list item, fence) always starts a
 * new line. Any other non-blank line is appended to the previous bullet /
 * paragraph / blockquote with a single space — which is what turns a bullet
 * wrapped over four physical lines back into one sentence. A trailing double
 * space (markdown's hard break) or an intervening blank line keeps the lines
 * apart, and fenced code is passed through untouched.
 */
export function reflowWrappedLines(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let kind: BlockKind = 'blank';
  let lastHardBreak = false;
  let inCode = false;

  for (const raw of lines) {
    if (inCode) {
      out.push(raw);
      if (FENCE.test(raw)) {
        inCode = false;
        kind = 'code';
      }
      continue;
    }

    const hardBreak = / {2,}$/.test(raw);
    const line = raw.replace(/[ \t]+$/, '');

    if (FENCE.test(line)) {
      out.push(raw);
      inCode = true;
      kind = 'code';
      lastHardBreak = false;
      continue;
    }
    if (line.trim() === '') {
      out.push('');
      kind = 'blank';
      lastHardBreak = false;
      continue;
    }
    if (HEADING.test(line) || RULE.test(line)) {
      out.push(line);
      kind = 'heading';
      lastHardBreak = false;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      out.push(line);
      kind = 'item';
      lastHardBreak = hardBreak;
      continue;
    }

    const isQuote = QUOTE.test(line);
    const joinable = kind === 'item' || kind === 'para' || kind === 'quote';
    if (joinable && !lastHardBreak) {
      const text = isQuote && kind === 'quote' ? line.replace(QUOTE, '') : line.trim();
      out[out.length - 1] += ` ${text}`;
    } else {
      out.push(line);
      kind = isQuote ? 'quote' : 'para';
    }
    lastHardBreak = hardBreak;
  }

  return out.join('\n');
}

/** Fold wrapped lines, then render the section's markdown as HTML. */
export function renderChangelogMarkdown(markdown: string): string {
  return markdownToHtml(reflowWrappedLines(markdown));
}

/**
 * Pull the `## [<version>]` section out of a CHANGELOG.md (heading may carry a
 * trailing release date). Returns the section body without the heading, or
 * `undefined` when the version is not in the file.
 */
export function extractChangelogSection(changelog: string, version: string): string | undefined {
  const normalized = changelog.replace(/\r\n?/g, '\n');
  const wanted = version.replace(/^v/, '');
  const headings = [...normalized.matchAll(/^##[ \t]+\[?v?([^\]\s]+)\]?[^\n]*$/gm)];

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading[1] !== wanted) continue;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index ?? normalized.length : normalized.length;
    return normalized.slice(start, end).trim();
  }

  return undefined;
}

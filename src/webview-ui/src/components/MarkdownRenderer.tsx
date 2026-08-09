import React, { useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify'; // H-9 fix: import the sanitizer
import { highlightCode } from '../utils/highlightCode';

interface Props {
  content: string;
}

/**
 * Detect whether a string contains HTML tags (as opposed to Markdown).
 */
function isHtml(str: string): boolean {
  return /<\/?(?:p|ul|ol|li|div|span|strong|em|br|h[1-6]|a|img|pre|code|blockquote|table|thead|tbody|tr|td|th)\b/i.test(str);
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Convert common HTML to Markdown.
 * Handles the tags commonly returned by ADO work item fields.
 */
export function htmlToMarkdown(html: string): string {
  let md = html;

  // --- Block-level elements ---

  // Headings: <h1>…</h1> → # …\n\n  (up to h6)
  for (let i = 1; i <= 6; i++) {
    const prefix = '#'.repeat(i);
    md = md.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi'), `${prefix} $1\n\n`);
  }

  // Paragraphs: <p>…</p> → …\n\n
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  // <br> / <br/> / <br /> → \n
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // --- Lists ---
  // Unordered list items
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, inner: string) => {
    return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  });

  // Ordered list items
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, inner: string) => {
    let idx = 0;
    return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, () => {
      idx++;
      return `${idx}. $1\n`;
    });
  });

  // --- Inline elements ---
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Links: <a href="url">text</a> → [text](url)
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Single-quote variant
  md = md.replace(/<a[^>]*href='([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Images: <img src="url" alt="alt" /> → ![alt](url)
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');

  // --- Pre / code blocks ---
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const cleaned = inner.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '$1');
    return `\n\`\`\`\n${cleaned}\n\`\`\`\n`;
  });

  // --- Tables (basic) ---
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, inner: string) => {
    const rows: string[] = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(inner)) !== null) {
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        cells.push(cellMatch[1].trim());
      }
      rows.push('| ' + cells.join(' | ') + ' |');
    }
    if (rows.length > 0) {
      // Insert a separator after the first row (header)
      rows.splice(1, 0, '| ' + rows[0].split('|').slice(1, -1).map(() => '---').join(' | ') + ' |');
    }
    return '\n' + rows.join('\n') + '\n\n';
  });

  // --- Strip remaining HTML tags ---
  md = md.replace(/<\/?(?:div|span|section|article|header|footer|nav|main|aside|details|summary|figure|figcaption|small|mark|del|s|sub|sup|hr|blockquote|dl|dt|dd)[^>]*>/gi, '');

  // Last resort: strip any remaining tags (but keep content)
  md = md.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  md = decodeEntities(md);

  // Collapse excessive blank lines (3+ → 2)
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

export function MarkdownRenderer({ content }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      // If content looks like HTML, convert to Markdown first
      const markdown = isHtml(content) ? htmlToMarkdown(content) : content;

      // SECURITY: marked does NOT sanitize; LLM output is untrusted and may
      // contain raw HTML. DOMPurify strips scripts/event handlers before the
      // HTML touches the DOM (paired with the webview CSP from Task 3).
      let raw = marked.parse(markdown) as string;

      // Apply syntax highlighting to code blocks before sanitization.
      // marked renders code blocks as <pre><code class="language-xxx">...</code></pre>
      raw = raw.replace(
        /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/gi,
        (_match: string, lang: string, code: string) => {
          const decoded = decodeEntities(code);
          const highlighted = highlightCode(decoded, lang);
          return `<pre><code class="language-${lang}">${highlighted}</code></pre>`;
        }
      );

      ref.current.innerHTML = DOMPurify.sanitize(raw);
    }
  }, [content]);

  return <div ref={ref} className="markdown-body" />;
}

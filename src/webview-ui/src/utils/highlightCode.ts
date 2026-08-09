/**
 * Lightweight regex-based syntax highlighter for code blocks.
 * No external dependencies — pure regex approach for speed.
 * Uses CSS classes: .hljs-keyword, .hljs-string, .hljs-comment,
 * .hljs-number, .hljs-function, .hljs-operator
 */

const HLJS_KEYWORD = 'hljs-keyword';
const HLJS_STRING = 'hljs-string';
const HLJS_COMMENT = 'hljs-comment';
const HLJS_NUMBER = 'hljs-number';
const HLJS_FUNCTION = 'hljs-function';
const HLJS_OPERATOR = 'hljs-operator';

// Escape HTML entities to prevent XSS and ensure proper rendering
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Wrap matched text with a span and CSS class
function wrapToken(text: string, className: string): string {
  return `<span class="${className}">${text}</span>`;
}

// JavaScript/TypeScript keywords
const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false',
  'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield',
  // TypeScript specific
  'abstract', 'as', 'enum', 'implements', 'interface', 'keyof', 'namespace',
  'type', 'readonly', 'private', 'protected', 'public', 'override', 'satisfies',
  'declare', 'is', 'infer', 'asserts', 'module', 'require',
]);

// Python keywords
const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with',
  'yield', 'self', 'cls', 'print', 'raise',
]);

// Bash keywords
const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done',
  'case', 'esac', 'function', 'return', 'exit', 'local', 'export',
  'source', 'alias', 'unalias', 'set', 'unset', 'readonly', 'declare',
  'typeset', 'shift', 'break', 'continue', 'echo', 'printf', 'read',
  'test', 'exec', 'eval', 'trap', 'wait', 'cd', 'pushd', 'popd',
  'dirs', 'pwd', 'export', 'env', 'true', 'false',
]);

// JSON keywords
const JSON_KEYWORDS = new Set(['true', 'false', 'null']);

// CSS keywords
const CSS_KEYWORDS = new Set([
  'important', 'inherit', 'initial', 'unset', 'revert', 'none', 'auto',
  'block', 'inline', 'flex', 'grid', 'absolute', 'relative', 'fixed',
  'sticky', 'static', 'center', 'left', 'right', 'top', 'bottom',
  'normal', 'bold', 'italic', 'transparent',
]);

// HTML tags (for highlighting)
const HTML_TAGS = new Set([
  'html', 'head', 'body', 'div', 'span', 'p', 'a', 'img', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'thead',
  'tbody', 'tfoot', 'form', 'input', 'button', 'select', 'option', 'textarea',
  'label', 'script', 'style', 'link', 'meta', 'title', 'base', 'br', 'hr',
  'pre', 'code', 'blockquote', 'section', 'article', 'aside', 'nav', 'header',
  'footer', 'main', 'figure', 'figcaption', 'details', 'summary', 'audio',
  'video', 'source', 'canvas', 'svg', 'path', 'circle', 'rect', 'text',
  'strong', 'em', 'small', 'sub', 'sup', 'del', 'ins', 'mark',
]);

/**
 * Highlight JavaScript/TypeScript code.
 */
function highlightJS(code: string): string {
  // Tokenize using a state machine approach
  const tokens: Array<{ start: number; end: number; className: string }> = [];

  // Track positions to avoid overlapping matches
  const occupied = new Set<number>();

  function markOccupied(start: number, end: number, className: string): void {
    // Only mark if not already occupied
    for (let i = start; i < end; i++) {
      if (occupied.has(i)) return;
    }
    for (let i = start; i < end; i++) {
      occupied.add(i);
    }
    tokens.push({ start, end, className });
  }

  // Single-line comments: //
  const singleCommentRegex = /\/\/[^\n]*/g;
  let match;
  while ((match = singleCommentRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_COMMENT);
  }

  // Multi-line comments: /* ... */
  const multiCommentRegex = /\/\*[\s\S]*?\*\//g;
  while ((match = multiCommentRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_COMMENT);
  }

  // Template literals with expressions: `...${expr}...`
  const templateRegex = /`(?:[^`\\]|\\.|\$\{[^}]*\})*`/g;
  while ((match = templateRegex.exec(code)) !== null) {
    // Highlight template expressions inside ${}
    let result = match[0];
    result = result.replace(/\$\{([^}]*)\}/g, (_e, expr: string) => {
      const highlighted = highlightJS(expr);
      return `\${${highlighted}}`;
    });
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Double-quoted strings
  const doubleQuoteRegex = /"(?:[^"\\]|\\.)*"/g;
  while ((match = doubleQuoteRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Single-quoted strings
  const singleQuoteRegex = /'(?:[^'\\]|\\.)*'/g;
  while ((match = singleQuoteRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Numbers (integers, floats, hex, binary, octal)
  const numberRegex = /\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g;
  while ((match = numberRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_NUMBER);
  }

  // Function calls: word followed by (
  const functionRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g;
  while ((match = functionRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[1].length, HLJS_FUNCTION);
  }

  // Method calls: .methodName(
  const methodRegex = /\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g;
  while ((match = methodRegex.exec(code)) !== null) {
    markOccupied(match.index + 1, match.index + 1 + match[1].length, HLJS_FUNCTION);
  }

  // Keywords
  const keywordRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
  while ((match = keywordRegex.exec(code)) !== null) {
    if (JS_KEYWORDS.has(match[1])) {
      markOccupied(match.index, match.index + match[1].length, HLJS_KEYWORD);
    }
  }

  // Operators
  const operatorRegex = /[+\-*/%=!<>&|^~?:]+|=>/g;
  while ((match = operatorRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_OPERATOR);
  }

  // Build result
  return buildHighlightedCode(code, tokens);
}

/**
 * Highlight Python code.
 */
function highlightPython(code: string): string {
  const tokens: Array<{ start: number; end: number; className: string }> = [];
  const occupied = new Set<number>();

  function markOccupied(start: number, end: number, className: string): void {
    for (let i = start; i < end; i++) {
      if (occupied.has(i)) return;
    }
    for (let i = start; i < end; i++) {
      occupied.add(i);
    }
    tokens.push({ start, end, className });
  }

  // Comments: #
  const commentRegex = /#[^\n]*/g;
  let match;
  while ((match = commentRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_COMMENT);
  }

  // Triple-quoted strings (docstrings)
  const tripleQuoteRegex = /"""[\s\S]*?"""|'''[\s\S]*?'''/g;
  while ((match = tripleQuoteRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // F-strings: f"..." or f'...'
  const fStringRegex = /f"(?:[^"\\]|\\.)*"|f'(?:[^'\\]|\\.)*'/g;
  while ((match = fStringRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Double-quoted strings
  const doubleQuoteRegex = /"(?:[^"\\]|\\.)*"/g;
  while ((match = doubleQuoteRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Single-quoted strings
  const singleQuoteRegex = /'(?:[^'\\]|\\.)*'/g;
  while ((match = singleQuoteRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Numbers
  const numberRegex = /\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g;
  while ((match = numberRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_NUMBER);
  }

  // Function calls: word(
  const functionRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=\()/g;
  while ((match = functionRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[1].length, HLJS_FUNCTION);
  }

  // Decorators: @decorator
  const decoratorRegex = /@([a-zA-Z_][a-zA-Z0-9_.]*)/g;
  while ((match = decoratorRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_FUNCTION);
  }

  // Keywords
  const keywordRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  while ((match = keywordRegex.exec(code)) !== null) {
    if (PYTHON_KEYWORDS.has(match[1])) {
      markOccupied(match.index, match.index + match[1].length, HLJS_KEYWORD);
    }
  }

  // Operators
  const operatorRegex = /[+\-*/%=!<>&|^~@:]+|->/g;
  while ((match = operatorRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_OPERATOR);
  }

  return buildHighlightedCode(code, tokens);
}

/**
 * Highlight Bash/Shell code.
 */
function highlightBash(code: string): string {
  const tokens: Array<{ start: number; end: number; className: string }> = [];
  const occupied = new Set<number>();

  function markOccupied(start: number, end: number, className: string): void {
    for (let i = start; i < end; i++) {
      if (occupied.has(i)) return;
    }
    for (let i = start; i < end; i++) {
      occupied.add(i);
    }
    tokens.push({ start, end, className });
  }

  // Comments: #
  const commentRegex = /#[^\n]*/g;
  let match;
  while ((match = commentRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_COMMENT);
  }

  // Double-quoted strings
  const doubleQuoteRegex = /"(?:[^"\\]|\\.)*"/g;
  while ((match = doubleQuoteRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Single-quoted strings
  const singleQuoteRegex = /'(?:[^'\\]|\\.)*'/g;
  while ((match = singleQuoteRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Variables: $var, ${var}, $((expr))
  const variableRegex = /\$[({]?[a-zA-Z0-9_]+[})]?|\$\([^\)]*\)/g;
  while ((match = variableRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_NUMBER);
  }

  // Numbers
  const numberRegex = /\b\d+\b/g;
  while ((match = numberRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_NUMBER);
  }

  // Command flags: -flag, --flag
  const flagRegex = /\s(-{1,2}[a-zA-Z0-9_-]+)/g;
  while ((match = flagRegex.exec(code)) !== null) {
    markOccupied(match.index + 1, match.index + 1 + match[1].length, HLJS_FUNCTION);
  }

  // Keywords
  const keywordRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  while ((match = keywordRegex.exec(code)) !== null) {
    if (BASH_KEYWORDS.has(match[1])) {
      markOccupied(match.index, match.index + match[1].length, HLJS_KEYWORD);
    }
  }

  // Pipes and redirects
  const operatorRegex = /\||>>|>|<|&&|\|\|/g;
  while ((match = operatorRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_OPERATOR);
  }

  return buildHighlightedCode(code, tokens);
}

/**
 * Highlight JSON code.
 */
function highlightJSON(code: string): string {
  const tokens: Array<{ start: number; end: number; className: string }> = [];
  const occupied = new Set<number>();

  function markOccupied(start: number, end: number, className: string): void {
    for (let i = start; i < end; i++) {
      if (occupied.has(i)) return;
    }
    for (let i = start; i < end; i++) {
      occupied.add(i);
    }
    tokens.push({ start, end, className });
  }

  // Strings (keys and values)
  const stringRegex = /"(?:[^"\\]|\\.)*"/g;
  let match;
  while ((match = stringRegex.exec(code)) !== null) {
    // Check if this is a key (followed by colon)
    const afterString = code.substring(match.index + match[0].length).trimStart();
    if (afterString.startsWith(':')) {
      // It's a key
      markOccupied(match.index, match.index + match[0].length, HLJS_KEYWORD);
    } else {
      // It's a value
      markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
    }
  }

  // Numbers
  const numberRegex = /-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/g;
  while ((match = numberRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_NUMBER);
  }

  // Keywords (true, false, null)
  const keywordRegex = /\b(true|false|null)\b/g;
  while ((match = keywordRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_KEYWORD);
  }

  // Punctuation
  const punctRegex = /[{}[\],:]/g;
  while ((match = punctRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_OPERATOR);
  }

  return buildHighlightedCode(code, tokens);
}

/**
 * Highlight HTML code.
 */
function highlightHTML(code: string): string {
  const tokens: Array<{ start: number; end: number; className: string }> = [];
  const occupied = new Set<number>();

  function markOccupied(start: number, end: number, className: string): void {
    for (let i = start; i < end; i++) {
      if (occupied.has(i)) return;
    }
    for (let i = start; i < end; i++) {
      occupied.add(i);
    }
    tokens.push({ start, end, className });
  }

  // Comments
  const commentRegex = /<!--[\s\S]*?-->/g;
  let match;
  while ((match = commentRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_COMMENT);
  }

  // Strings (attribute values)
  const stringRegex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  while ((match = stringRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Tags: <tagname ... >
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)/g;
  while ((match = tagRegex.exec(code)) !== null) {
    // Highlight the < or </
    const prefix = match[0].startsWith('</') ? '</' : '<';
    markOccupied(match.index, match.index + prefix.length, HLJS_OPERATOR);
    // Highlight tag name
    markOccupied(
      match.index + prefix.length,
      match.index + match[0].length,
      HLJS_KEYWORD
    );
  }

  // Self-closing />
  const selfCloseRegex = /\/>/g;
  while ((match = selfCloseRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_OPERATOR);
  }

  // Attributes: word=
  const attrRegex = /\b([a-zA-Z-]+)(=)/g;
  while ((match = attrRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[1].length, HLJS_FUNCTION);
    markOccupied(match.index + match[1].length, match.index + match[0].length, HLJS_OPERATOR);
  }

  // Entities: &name; or &#123;
  const entityRegex = /&[a-zA-Z]+;|&#\d+;/g;
  while ((match = entityRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_NUMBER);
  }

  return buildHighlightedCode(code, tokens);
}

/**
 * Highlight CSS code.
 */
function highlightCSS(code: string): string {
  const tokens: Array<{ start: number; end: number; className: string }> = [];
  const occupied = new Set<number>();

  function markOccupied(start: number, end: number, className: string): void {
    for (let i = start; i < end; i++) {
      if (occupied.has(i)) return;
    }
    for (let i = start; i < end; i++) {
      occupied.add(i);
    }
    tokens.push({ start, end, className });
  }

  // Comments
  const commentRegex = /\/\*[\s\S]*?\*\//g;
  let match;
  while ((match = commentRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_COMMENT);
  }

  // Strings
  const stringRegex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  while ((match = stringRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_STRING);
  }

  // Numbers with units
  const numberRegex = /-?\b\d+\.?\d*(?:px|em|rem|%|vh|vw|s|ms|deg|rad|turn|fr)?\b/g;
  while ((match = numberRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_NUMBER);
  }

  // Properties: word:
  const propertyRegex = /\b([a-zA-Z-]+)\s*(?=:)/g;
  while ((match = propertyRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[1].length, HLJS_KEYWORD);
  }

  // Selectors (simplified: .class, #id, tag, @media)
  const selectorRegex = /([.#@][a-zA-Z_-][a-zA-Z0-9_-]*)/g;
  while ((match = selectorRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_FUNCTION);
  }

  // At-rules
  const atRuleRegex = /@[a-zA-Z-]+/g;
  while ((match = atRuleRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[0].length, HLJS_KEYWORD);
  }

  // Functions: word(
  const functionRegex = /\b([a-zA-Z-]+)\s*(?=\()/g;
  while ((match = functionRegex.exec(code)) !== null) {
    markOccupied(match.index, match.index + match[1].length, HLJS_FUNCTION);
  }

  // Keywords
  const keywordRegex = /\b([a-zA-Z-]+)\b/g;
  while ((match = keywordRegex.exec(code)) !== null) {
    if (CSS_KEYWORDS.has(match[1])) {
      markOccupied(match.index, match.index + match[1].length, HLJS_KEYWORD);
    }
  }

  return buildHighlightedCode(code, tokens);
}

/**
 * Build the highlighted HTML from code and token list.
 */
function buildHighlightedCode(
  code: string,
  tokens: Array<{ start: number; end: number; className: string }>
): string {
  // Sort tokens by start position
  tokens.sort((a, b) => a.start - b.start);

  // Remove overlapping tokens (keep first)
  const cleaned: Array<{ start: number; end: number; className: string }> = [];
  let lastEnd = 0;
  for (const token of tokens) {
    if (token.start >= lastEnd) {
      cleaned.push(token);
      lastEnd = token.end;
    }
  }

  // Build result
  let result = '';
  let pos = 0;
  for (const token of cleaned) {
    // Add unhighlighted text before this token
    if (pos < token.start) {
      result += escapeHtml(code.substring(pos, token.start));
    }
    // Add highlighted token
    result += wrapToken(escapeHtml(code.substring(token.start, token.end)), token.className);
    pos = token.end;
  }
  // Add remaining text
  if (pos < code.length) {
    result += escapeHtml(code.substring(pos));
  }

  return result;
}

/**
 * Highlight code based on language.
 * Returns HTML string with span tags for syntax coloring.
 */
export function highlightCode(code: string, language: string): string {
  const lang = language.toLowerCase().trim();

  // Normalize language aliases
  if (lang === 'js' || lang === 'javascript' || lang === 'jsx' || lang === 'mjs' || lang === 'cjs') {
    return highlightJS(code);
  }
  if (lang === 'ts' || lang === 'typescript' || lang === 'tsx' || lang === 'mts' || lang === 'cts') {
    return highlightJS(code);
  }
  if (lang === 'py' || lang === 'python' || lang === 'python3') {
    return highlightPython(code);
  }
  if (lang === 'sh' || lang === 'bash' || lang === 'shell' || lang === 'zsh' || lang === 'fish' || lang === 'ps1' || lang === 'powershell') {
    return highlightBash(code);
  }
  if (lang === 'json' || lang === 'jsonc') {
    return highlightJSON(code);
  }
  if (lang === 'html' || lang === 'htm' || lang === 'xml' || lang === 'svg' || lang === 'xhtml') {
    return highlightHTML(code);
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less' || lang === 'sass') {
    return highlightCSS(code);
  }

  // Unknown language: just escape HTML
  return escapeHtml(code);
}

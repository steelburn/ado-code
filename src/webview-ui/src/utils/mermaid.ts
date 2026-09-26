import mermaid from 'mermaid';

let mermaidInitialized = false;
let currentTheme = '';

/**
 * Determine the appropriate Mermaid theme based on VS Code's active theme classes.
 */
function getDesiredTheme(): 'dark' | 'default' {
  const body = document.body;
  const isDark =
    body.classList.contains('vscode-dark') ||
    body.classList.contains('vscode-high-contrast') ||
    document.documentElement.classList.contains('vscode-dark');
  return isDark ? 'dark' : 'default';
}

/**
 * Initialize or re-initialize Mermaid with the current theme.
 */
export function initMermaid(): void {
  const theme = getDesiredTheme();
  if (!mermaidInitialized || currentTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'loose',
      fontFamily: 'var(--vscode-font-family, sans-serif)',
      suppressErrorRendering: true,
    });
    mermaidInitialized = true;
    currentTheme = theme;
  }
}

let idCounter = 0;
function getUniqueId(): string {
  idCounter++;
  return `mermaid-${Date.now()}-${idCounter}`;
}

/**
 * Decode HTML entities if code comes from HTML parsing.
 */
function decodeHtmlEntities(str: string): string {
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

/**
 * Ensure standard SVG namespaces (xmlns) are present for standalone SVG use.
 */
export function formatSvgContent(rawSvg: string): string {
  let svg = rawSvg.trim();
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svg = svg.replace(/<svg\b([^>]*)>/i, '<svg xmlns="http://www.w3.org/2000/svg" $1>');
  }
  if (!svg.includes('xmlns:xlink="http://www.w3.org/1999/xlink"') && svg.includes('xlink:')) {
    svg = svg.replace(/<svg\b([^>]*)>/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink" $1>');
  }
  return svg;
}

/**
 * Extracts a diagram title if declared in frontmatter or title directive.
 */
export function extractDiagramTitle(code: string): string {
  const frontmatterMatch = code.match(/---\s*[\r\n]+(?:[\s\S]*?[\r\n]+)?title:\s*([^\r\n]+)/i);
  if (frontmatterMatch && frontmatterMatch[1]) {
    return frontmatterMatch[1].trim();
  }
  const titleMatch = code.match(/(?:^|\n)\s*(?:title|accTitle)\s*[:\s]\s*([^\r\n]+)/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].trim();
  }
  return '';
}

/**
 * Sanitize a diagram name for filesystem use, defaulting to 'diagram.svg'.
 */
export function sanitizeFileName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized ? `${sanitized}.svg` : 'diagram.svg';
}

function getVsCodeApi(): { postMessage(msg: any): void } | null {
  if (typeof (window as any) !== 'undefined') {
    if ((window as any).__vscodeApi) {
      return (window as any).__vscodeApi;
    }
    if (typeof (window as any).acquireVsCodeApi === 'function') {
      try {
        (window as any).__vscodeApi = (window as any).acquireVsCodeApi();
        return (window as any).__vscodeApi;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Fallback browser download using an anchor element.
 */
export function downloadSvgFallback(svgContent: string, filename = 'diagram.svg'): void {
  if (typeof document === 'undefined') return;
  const formatted = formatSvgContent(svgContent);
  const fileContent = formatted.startsWith('<?xml')
    ? formatted
    : `<?xml version="1.0" encoding="UTF-8"?>\n${formatted}`;

  const blob = new Blob([fileContent], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/**
 * Copy rendered SVG string to the clipboard with HTML/text fallback.
 */
export async function copySvgToClipboard(svgContent: string): Promise<boolean> {
  const formatted = formatSvgContent(svgContent);

  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    if (typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
      try {
        const textBlob = new Blob([formatted], { type: 'text/plain' });
        const htmlBlob = new Blob([formatted], { type: 'text/html' });
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': textBlob,
            'text/html': htmlBlob,
          }),
        ]);
        return true;
      } catch {
        // Fallback below
      }
    }

    if (typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(formatted);
        return true;
      } catch {
        // Fallback below
      }
    }
  }

  // Fallback using hidden textarea and execCommand
  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = formatted;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Save SVG to a file by dispatching a saveSvg message to VS Code host,
 * or falling back to browser download.
 */
export async function saveSvgToFile(svgContent: string, defaultName = 'diagram.svg'): Promise<boolean> {
  const formatted = formatSvgContent(svgContent);
  const fileContent = formatted.startsWith('<?xml')
    ? formatted
    : `<?xml version="1.0" encoding="UTF-8"?>\n${formatted}`;

  const vscodeApi = getVsCodeApi();
  if (vscodeApi) {
    vscodeApi.postMessage({
      type: 'saveSvg',
      content: fileContent,
      defaultName,
    });
    return true;
  }

  downloadSvgFallback(fileContent, defaultName);
  return true;
}

/**
 * Create an interactive Mermaid widget element containing:
 * - Toolbar with "Diagram" badge, View Toggle [ Diagram | Code ], Copy SVG, Save SVG, and Copy Code buttons
 * - Chart view containing the rendered SVG
 * - Code view containing the raw formatted Mermaid code
 */
export function createMermaidWidget(rawCode: string): HTMLElement {
  initMermaid();

  const container = document.createElement('div');
  container.className = 'mermaid-container';
  container.setAttribute('data-mermaid-processed', 'true');

  const cleanCode = decodeHtmlEntities(rawCode).trim();

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';

  const leftDiv = document.createElement('div');
  leftDiv.className = 'mermaid-toolbar-left';
  const badge = document.createElement('span');
  badge.className = 'mermaid-badge';
  badge.innerHTML = `<span class="mermaid-icon">📊</span> <span class="mermaid-label">Diagram</span>`;
  leftDiv.appendChild(badge);
  toolbar.appendChild(leftDiv);

  const rightDiv = document.createElement('div');
  rightDiv.className = 'mermaid-toolbar-right';

  // Toggle group: [ Diagram | Code ]
  const toggleGroup = document.createElement('div');
  toggleGroup.className = 'mermaid-toggle-group';

  const btnDiagram = document.createElement('button');
  btnDiagram.type = 'button';
  btnDiagram.className = 'mermaid-toggle-btn active';
  btnDiagram.innerHTML = `<span class="mermaid-btn-icon">📊</span> Diagram`;
  btnDiagram.title = 'Switch to diagram view';

  const btnCode = document.createElement('button');
  btnCode.type = 'button';
  btnCode.className = 'mermaid-toggle-btn';
  btnCode.innerHTML = `<span class="mermaid-btn-icon">&lt;/&gt;</span> Code`;
  btnCode.title = 'Switch to Mermaid source code';

  toggleGroup.appendChild(btnDiagram);
  toggleGroup.appendChild(btnCode);
  rightDiv.appendChild(toggleGroup);

  // SVG getter for action buttons
  let renderedSvg: string | null = null;
  const getSvg = (): string | null => {
    if (renderedSvg) return renderedSvg;
    const svgEl = chartEl.querySelector('svg');
    return svgEl ? svgEl.outerHTML : null;
  };

  // Copy SVG button
  const copySvgBtn = document.createElement('button');
  copySvgBtn.type = 'button';
  copySvgBtn.className = 'mermaid-action-btn mermaid-copy-svg-btn';
  copySvgBtn.innerHTML = `<span>🖼️</span> Copy SVG`;
  copySvgBtn.title = 'Copy SVG image output to clipboard';
  copySvgBtn.disabled = true;
  copySvgBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const svg = getSvg();
    if (!svg) return;
    try {
      const ok = await copySvgToClipboard(svg);
      if (ok) {
        copySvgBtn.innerHTML = `<span>✓</span> Copied`;
        setTimeout(() => {
          copySvgBtn.innerHTML = `<span>🖼️</span> Copy SVG`;
        }, 1500);
      } else {
        throw new Error('Copy failed');
      }
    } catch {
      copySvgBtn.innerHTML = `<span>✗</span> Failed`;
      setTimeout(() => {
        copySvgBtn.innerHTML = `<span>🖼️</span> Copy SVG`;
      }, 1500);
    }
  });
  rightDiv.appendChild(copySvgBtn);

  // Save SVG button
  const saveSvgBtn = document.createElement('button');
  saveSvgBtn.type = 'button';
  saveSvgBtn.className = 'mermaid-action-btn mermaid-save-svg-btn';
  saveSvgBtn.innerHTML = `<span>💾</span> Save SVG`;
  saveSvgBtn.title = 'Save SVG image to file';
  saveSvgBtn.disabled = true;
  saveSvgBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const svg = getSvg();
    if (!svg) return;
    try {
      const filename = sanitizeFileName(extractDiagramTitle(cleanCode));
      await saveSvgToFile(svg, filename);
      saveSvgBtn.innerHTML = `<span>✓</span> Saved`;
      setTimeout(() => {
        saveSvgBtn.innerHTML = `<span>💾</span> Save SVG`;
      }, 1500);
    } catch {
      saveSvgBtn.innerHTML = `<span>✗</span> Failed`;
      setTimeout(() => {
        saveSvgBtn.innerHTML = `<span>💾</span> Save SVG`;
      }, 1500);
    }
  });
  rightDiv.appendChild(saveSvgBtn);

  // Copy Code button
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'mermaid-action-btn mermaid-copy-btn';
  copyBtn.innerHTML = `<span>📋</span> Copy Code`;
  copyBtn.title = 'Copy Mermaid source code';
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cleanCode);
      copyBtn.innerHTML = `<span>✓</span> Copied`;
      setTimeout(() => {
        copyBtn.innerHTML = `<span>📋</span> Copy Code`;
      }, 1500);
    } catch {
      copyBtn.innerHTML = `<span>✗</span> Failed`;
      setTimeout(() => {
        copyBtn.innerHTML = `<span>📋</span> Copy Code`;
      }, 1500);
    }
  });
  rightDiv.appendChild(copyBtn);
  toolbar.appendChild(rightDiv);
  container.appendChild(toolbar);

  // Chart Wrapper
  const chartWrapper = document.createElement('div');
  chartWrapper.className = 'mermaid-chart-wrapper';
  const chartEl = document.createElement('div');
  chartEl.className = 'mermaid-chart';
  chartEl.innerHTML = `<div class="mermaid-loading">Rendering diagram…</div>`;
  chartWrapper.appendChild(chartEl);
  container.appendChild(chartWrapper);

  // Code Wrapper
  const codeWrapper = document.createElement('div');
  codeWrapper.className = 'mermaid-code-wrapper';
  codeWrapper.style.display = 'none';
  const preEl = document.createElement('pre');
  preEl.className = 'mermaid-code-block';
  const codeEl = document.createElement('code');
  codeEl.className = 'language-mermaid';
  codeEl.textContent = cleanCode;
  preEl.appendChild(codeEl);
  codeWrapper.appendChild(preEl);
  container.appendChild(codeWrapper);

  // Toggle handlers
  const showDiagram = () => {
    btnDiagram.classList.add('active');
    btnCode.classList.remove('active');
    chartWrapper.style.display = '';
    codeWrapper.style.display = 'none';
  };

  const showCode = () => {
    btnCode.classList.add('active');
    btnDiagram.classList.remove('active');
    chartWrapper.style.display = 'none';
    codeWrapper.style.display = '';
  };

  btnDiagram.addEventListener('click', (e) => {
    e.stopPropagation();
    showDiagram();
  });

  btnCode.addEventListener('click', (e) => {
    e.stopPropagation();
    showCode();
  });

  // Asynchronous render
  const renderId = getUniqueId();
  mermaid
    .render(renderId, cleanCode)
    .then(({ svg }) => {
      renderedSvg = svg;
      chartEl.innerHTML = svg;
      copySvgBtn.disabled = false;
      saveSvgBtn.disabled = false;
    })
    .catch((err) => {
      // In case of syntax or render error, show error banner and fall back to code view
      renderedSvg = null;
      copySvgBtn.disabled = true;
      saveSvgBtn.disabled = true;
      console.warn('Mermaid rendering error:', err);
      chartEl.innerHTML = `
        <div class="mermaid-error">
          <div class="mermaid-error-title">⚠️ Unable to render Mermaid diagram</div>
          <div class="mermaid-error-msg">${err instanceof Error ? err.message : String(err)}</div>
        </div>
      `;
      // Show code view by default on error
      showCode();
    });

  return container;
}

/**
 * Process a container element to find and replace all Mermaid code blocks
 * with interactive Mermaid widgets.
 */
export function processMermaidInContainer(container: HTMLElement): void {
  // 1. Look for <pre><code class="language-mermaid"> or similar
  const pres = container.querySelectorAll('pre');
  pres.forEach((pre) => {
    // Skip if already in a mermaid container or code-block-wrapper
    if (pre.closest('.mermaid-container') || pre.parentElement?.classList.contains('code-block-wrapper')) {
      return;
    }

    const codeEl = pre.querySelector('code');
    const className = (codeEl?.className || '') + ' ' + (pre.className || '');
    const isMermaidClass = /language-mermaid|lang-mermaid|\bmermaid\b/i.test(className);

    // Also check if text begins with common mermaid keywords if not tagged
    const text = (codeEl?.textContent || pre.textContent || '').trim();
    const isMermaidContent = /^(?:graph\s+[TLRB]{2}|flowchart\s+[TLRB]{2}|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|journey|quadrantChart|mindmap)/.test(text);

    if (isMermaidClass || (isMermaidContent && text.includes('\n'))) {
      const widget = createMermaidWidget(text);
      pre.parentNode?.replaceChild(widget, pre);
    }
  });
}

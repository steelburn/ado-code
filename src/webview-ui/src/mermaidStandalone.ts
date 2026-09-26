import { processMermaidInContainer, initMermaid } from './utils/mermaid';
import './styles/mermaid.css';

function runMermaid(): void {
  initMermaid();
  processMermaidInContainer(document.body);
}

// Run on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runMermaid);
} else {
  runMermaid();
}

// Also observe for dynamic changes in case content loads asynchronously
const observer = new MutationObserver(() => {
  processMermaidInContainer(document.body);
});

observer.observe(document.body, { childList: true, subtree: true });

// Expose on window for manual triggering if needed
(window as any).renderMermaid = runMermaid;

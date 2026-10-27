/**
 * Deliberately-lazy module: exists only so the probe can force ONE webpack
 * chunk fetch through the loader the export bar actually uses
 * (`await import()` inside the bundle → `__webpack_require__.e` → `<script src>`
 * → CSP check).
 *
 * mermaid happens to lazy-load its diagram renderers too, but relying on that
 * would make the assertion depend on mermaid's internal chunking strategy.
 * A dedicated module keeps the proof deterministic: if webpack cannot fetch a
 * sibling chunk under the chat CSP, this import fails and the probe says so.
 */

export const LAZY_CHUNK_MARKER = 'ado-code-probe-lazy-chunk-ok';

export function lazyChunkMarker(): string {
  return LAZY_CHUNK_MARKER;
}

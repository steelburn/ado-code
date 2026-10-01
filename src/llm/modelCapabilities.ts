/**
 * Re-export barrel (Stage 1 dedup).
 *
 * The model-capability heuristic and gateway parsers are pure and vscode-free,
 * so they now live in `src/shared/modelCapabilities.ts` — a single source of
 * truth imported by BOTH the extension host and the webview Configuration page
 * (which previously carried a hand-synced copy).
 *
 * Kept as a barrel so the existing `../llm/modelCapabilities` import sites
 * (ChatViewProvider, llm/providers/*, llm/client.ts, llm/types.ts and the test
 * suite) keep resolving without churn.
 */
export * from '../shared/modelCapabilities';

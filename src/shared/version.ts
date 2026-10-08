/**
 * Extension version + outbound request identity.
 *
 * `EXTENSION_VERSION` mirrors package.json "version" — bump BOTH on release
 * (the extension manifest is the source of truth for the marketplace; this
 * constant exists so host code — e.g. the User-Agent — can reference the
 * version without importing package.json from compiled output).
 *
 * This is the ONLY place the outbound version may be written down — providers
 * must import `ADO_CODE_USER_AGENT` rather than format their own header.
 *
 * Drift between this constant and package.json is mechanically rejected by
 * `src/test/suite/shared/version.test.ts` (runs in the pre-commit suite) and
 * `scripts/check-version.js` (runs on `vsce package` via vscode:prepublish),
 * so a release can no longer ship a stale User-Agent.
 */
export const EXTENSION_VERSION = '0.7.3';

/**
 * User-Agent header sent with every LLM API request so gateway/provider logs
 * identify the caller as ADO Code (version + project URL).
 */
export const ADO_CODE_USER_AGENT = `ADO-Code/${EXTENSION_VERSION} (+https://github.com/steelburn/ado-code)`;

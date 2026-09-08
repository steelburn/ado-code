/**
 * Extension version + outbound request identity.
 *
 * `EXTENSION_VERSION` mirrors package.json "version" — bump BOTH on release
 * (the extension manifest is the source of truth for the marketplace; this
 * constant exists so host code — e.g. the User-Agent — can reference the
 * version without importing package.json from compiled output).
 */
export const EXTENSION_VERSION = '0.6.5';

/**
 * User-Agent header sent with every LLM API request so gateway/provider logs
 * identify the caller as ADO Code (version + project URL).
 */
export const ADO_CODE_USER_AGENT = `ADO-Code/${EXTENSION_VERSION} (+https://github.com/steelburn/ado-code)`;

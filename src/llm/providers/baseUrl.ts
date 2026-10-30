/**
 * Base-URL joining and normalisation, shared by both LLM providers.
 *
 * The provider builds every request as `<apiUrl>/chat/completions` (and
 * `<apiUrl>/models`), so a base URL that already ends in a slash produced
 * `https://host/v1//chat/completions`. Gateways answer that with a 404, which
 * reads like "wrong model" or "wrong key" and sends the user chasing the wrong
 * problem — while the trailing slash is the single most common paste artefact in
 * `adoCode.llmApiUrl` (`https://api.openai.com/v1/`). Normalise once, at the
 * point where the path is joined, so every request and the model listing share
 * one rule.
 *
 * Only the base URL is touched: a path may legitimately keep interior slashes,
 * and the scheme's `//` is never stripped.
 */

/** Trim surrounding whitespace and every trailing slash; a bare scheme keeps its `//`. */
export function normalizeBaseUrl(url: string): string {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '');
  // 'https://' would otherwise collapse to 'https:' and join to 'https:/chat/...'
  return /^[a-z][a-z0-9+.-]*:$/i.test(trimmed) ? `${trimmed}//` : trimmed;
}

/** `baseUrl` + `path` with exactly one separator, whatever the user typed. */
export function joinBaseUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, '')}`;
}

/**
 * Drop a trailing API-version segment (`.../v1`) so a versioned path can be
 * appended to what is left.
 *
 * Anthropic documents its base URL both ways (`https://api.anthropic.com` and
 * `.../v1`) while every endpoint lives under `/v1`, so the segment has to come
 * off first — appending to `.../v1` yields `/v1/v1/messages`. Strip-then-
 * append round-trips a gateway path such as `https://gw.local/anthropic/v1`
 * back to itself, so this is safe for any prefix, not just a bare host.
 */
export function withoutApiVersion(baseUrl: string, version = 'v1'): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const suffix = `/${version}`;
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
}

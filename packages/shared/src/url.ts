/**
 * URL parsing/normalization shared by client and server.
 *
 * Only http/https are accepted. This alone does not prevent SSRF (a hostname
 * can still resolve to a private IP) -- that check requires a DNS lookup and
 * lives server-side only, in apps/worker/src/ssrf.ts. This module just does
 * cheap syntactic validation so bad input can be rejected before it ever
 * reaches the database.
 */

export interface ParsedUrlLine {
  raw: string;
  normalized: string | null;
  valid: boolean;
  reason?: string;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeUrl(raw: string): ParsedUrlLine {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { raw, normalized: null, valid: false, reason: 'empty' };
  }

  let parsed: URL;
  try {
    // Default to https:// if no scheme was given at all, since that's the
    // overwhelmingly common intent for a pasted bare domain like "example.com".
    parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { raw, normalized: null, valid: false, reason: 'malformed' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { raw, normalized: null, valid: false, reason: `unsupported protocol: ${parsed.protocol}` };
  }

  if (!parsed.hostname) {
    return { raw, normalized: null, valid: false, reason: 'missing hostname' };
  }

  // Normalize: lowercase host, strip default ports, strip trailing slash on bare path,
  // drop fragment (irrelevant to a server-side health check).
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = '';
  }
  let normalized = parsed.toString();
  if (normalized.endsWith('/') && parsed.pathname === '/' && !parsed.search) {
    normalized = normalized.slice(0, -1);
  }

  return { raw, normalized, valid: true };
}

/** Parses a textarea of pasted URLs: newline or comma separated, blank lines ignored, deduped. */
export function parseUrlList(text: string): {
  valid: ParsedUrlLine[];
  invalid: ParsedUrlLine[];
  duplicates: string[];
} {
  const lines = text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const valid: ParsedUrlLine[] = [];
  const invalid: ParsedUrlLine[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const line of lines) {
    const parsedLine = normalizeUrl(line);
    if (!parsedLine.valid || !parsedLine.normalized) {
      invalid.push(parsedLine);
      continue;
    }
    if (seen.has(parsedLine.normalized)) {
      duplicates.push(parsedLine.normalized);
      continue;
    }
    seen.add(parsedLine.normalized);
    valid.push(parsedLine);
  }

  return { valid, invalid, duplicates };
}

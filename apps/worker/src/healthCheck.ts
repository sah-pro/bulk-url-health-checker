import { assertNotPrivateTarget, SsrfBlockedError } from './ssrf';
import { env } from './config';

export interface HealthCheckSuccess {
  outcome: 'success';
  httpStatus: number;
  responseTimeMs: number;
  pageTitle: string | null;
}

export interface HealthCheckFailure {
  outcome: 'failure';
  transient: boolean; // transient => eligible for retry; permanent => not
  error: string;
  responseTimeMs: number;
}

export type HealthCheckResult = HealthCheckSuccess | HealthCheckFailure;

const TITLE_REGEX = /<title[^>]*>([^<]*)<\/title>/i;

/**
 * "Final HTTP status code" is obtained by following redirects (fetch's
 * default behavior, up to its internal limit) and reading response.status
 * after all redirects have been followed -- i.e. the status of the last
 * response in the chain, not the first 3xx. response.url likewise reflects
 * the final, post-redirect URL. This matches what a browser or curl -L would
 * report as "the" status code for a redirecting URL.
 */
export async function performHealthCheck(normalizedUrl: string): Promise<HealthCheckResult> {
  const start = performance.now();
  let currentUrl = new URL(normalizedUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.REQUEST_TIMEOUT_MS);

  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      try {
        await assertNotPrivateTarget(currentUrl.hostname);
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          return {
            outcome: 'failure',
            transient: false,
            error: err.message,
            responseTimeMs: Math.round(performance.now() - start),
          };
        }
        throw err;
      }

      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'bulk-url-health-checker/1.0' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) {
          return {
            outcome: 'failure',
            transient: false,
            error: `Redirect response ${response.status} did not include a Location header.`,
            responseTimeMs: Math.round(performance.now() - start),
          };
        }
        if (redirects === 5) {
          return {
            outcome: 'failure',
            transient: false,
            error: 'Too many redirects.',
            responseTimeMs: Math.round(performance.now() - start),
          };
        }
        currentUrl = new URL(location, currentUrl);
        if (!['http:', 'https:'].includes(currentUrl.protocol)) {
          return {
            outcome: 'failure',
            transient: false,
            error: `Unsupported redirect protocol: ${currentUrl.protocol}`,
            responseTimeMs: Math.round(performance.now() - start),
          };
        }
        continue;
      }

      const pageTitle = await extractTitleWithSizeLimit(response);
      const responseTimeMs = Math.round(performance.now() - start);
      return { outcome: 'success', httpStatus: response.status, responseTimeMs, pageTitle };
    }

    return {
      outcome: 'failure',
      transient: false,
      error: 'Too many redirects.',
      responseTimeMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - start);
    return classifyError(err, responseTimeMs);
  } finally {
    clearTimeout(timeout);
  }
}

/** Reads at most MAX_RESPONSE_BYTES of the body looking for a <title>, then stops -- never buffers a whole large response. */
async function extractTitleWithSizeLimit(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') || !response.body) {
    // Draining a non-HTML body is unnecessary; undici will discard it on GC,
    // but we cancel explicitly to release the connection promptly.
    await response.body?.cancel().catch(() => {});
    return null;
  }

  const reader = response.body.getReader();
  let received = 0;
  let text = '';
  try {
    while (received < env.MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += Buffer.from(value).toString('utf-8');
      const match = TITLE_REGEX.exec(text);
      if (match) return match[1]!.trim() || null;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return null;
}

export function classifyError(err: unknown, responseTimeMs: number): HealthCheckFailure {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof DOMException && err.name === 'AbortError') {
    return { outcome: 'failure', transient: true, error: 'Request timed out', responseTimeMs };
  }

  // Node/undici network-level errors (DNS failure, connection reset/refused, TLS failure)
  // surface as TypeError with a `cause`. These are treated as transient: the
  // target may simply be temporarily unreachable.
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code;
  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);
  if (code && transientCodes.has(code)) {
    return { outcome: 'failure', transient: true, error: `${code}: ${message}`, responseTimeMs };
  }

  // Anything else we can't positively classify as transient (malformed
  // response, unexpected client-side error) is treated as permanent so we
  // don't burn retries on errors that will never succeed.
  return { outcome: 'failure', transient: false, error: message, responseTimeMs };
}

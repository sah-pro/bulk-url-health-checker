import type { BatchDetail, ListBatchesResponse, CreateBatchResponse } from '@bulk-url/shared';

/**
 * Two different base URLs are needed because the API is reached from two
 * different network contexts:
 *  - Server Components / server actions run inside the Next.js Node process,
 *    which in Docker Compose talks to the API over the internal service
 *    network (e.g. http://api:4000).
 *  - Client Components run in the browser, which can only reach the API via
 *    whatever port is published to the host (e.g. http://localhost:4000).
 * Conflating these is a common source of "works locally, breaks in Docker"
 * bugs, so they are kept as two explicit env vars rather than one.
 */
export const SERVER_API_URL = process.env.API_URL ?? 'http://localhost:4000';
export const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

/** Server-side fetch (used from Server Components). Always fetches fresh -- the API itself owns caching. */
export async function fetchBatchList(): Promise<ListBatchesResponse> {
  const res = await fetch(`${SERVER_API_URL}/api/batches`, { cache: 'no-store' });
  return parseOrThrow(res);
}

export async function fetchBatchDetail(id: string): Promise<BatchDetail> {
  const res = await fetch(`${SERVER_API_URL}/api/batches/${id}`, { cache: 'no-store' });
  return parseOrThrow(res);
}

/** Client-side calls (used from Client Components / browser). */
export async function createBatch(urls: string[]): Promise<CreateBatchResponse> {
  const res = await fetch(`${PUBLIC_API_URL}/api/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  return parseOrThrow(res);
}

export async function createBatchFromCsv(file: File): Promise<CreateBatchResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${PUBLIC_API_URL}/api/batches`, { method: 'POST', body: formData });
  return parseOrThrow(res);
}

export async function cancelBatchRequest(id: string): Promise<void> {
  const res = await fetch(`${PUBLIC_API_URL}/api/batches/${id}/cancel`, { method: 'POST' });
  await parseOrThrow(res);
}

export async function retryFailedRequest(id: string): Promise<void> {
  const res = await fetch(`${PUBLIC_API_URL}/api/batches/${id}/retry-failed`, { method: 'POST' });
  await parseOrThrow(res);
}

export async function fetchBatchDetailClient(id: string): Promise<BatchDetail> {
  const res = await fetch(`${PUBLIC_API_URL}/api/batches/${id}`, { cache: 'no-store' });
  return parseOrThrow(res);
}

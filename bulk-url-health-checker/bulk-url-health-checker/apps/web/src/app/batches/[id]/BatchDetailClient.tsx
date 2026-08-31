'use client';

import { useEffect, useState, useCallback } from 'react';
import type { BatchDetail, BatchEvent, UrlCheckDto } from '@bulk-url/shared';
import {
  PUBLIC_API_URL,
  cancelBatchRequest,
  retryFailedRequest,
  fetchBatchDetailClient,
} from '../../../lib/api';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{status}</span>;
}

const TERMINAL_BATCH_STATUSES = new Set(['COMPLETED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED']);

export function BatchDetailClient({ batchId, initialData }: { batchId: string; initialData: BatchDetail }) {
  const [batch, setBatch] = useState<BatchDetail>(initialData);
  const [connected, setConnected] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const applyEvent = useCallback((event: BatchEvent) => {
    if (event.type === 'batch-updated') {
      // The server always sends the full batch object (including urlChecks
      // when it's the initial post-connect push); merge summary fields but
      // keep whatever url check list we already have unless this payload
      // actually includes one.
      setBatch((prev) => ({
        ...prev,
        ...event.batch,
        urlChecks: 'urlChecks' in event.batch ? (event.batch as BatchDetail).urlChecks : prev.urlChecks,
      }));
    } else if (event.type === 'url-updated') {
      setBatch((prev) => ({
        ...prev,
        urlChecks: mergeUrlCheck(prev.urlChecks, event.urlCheck),
      }));
    }
  }, []);

  useEffect(() => {
    // EventSource reconnects automatically on drop (browser built-in
    // behavior). Because the server always re-sends full authoritative state
    // as the very first message on every new connection (see
    // apps/api/src/routes/events.ts), any events missed while disconnected
    // are implicitly recovered here -- we don't need bespoke gap-detection
    // logic on the client.
    const source = new EventSource(`${PUBLIC_API_URL}/api/batches/${batchId}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as BatchEvent;
      if (event.type !== 'heartbeat') applyEvent(event);
    };
    return () => source.close();
  }, [batchId, applyEvent]);

  async function handleCancel() {
    setActionPending(true);
    setActionError(null);
    try {
      await cancelBatchRequest(batchId);
      const fresh = await fetchBatchDetailClient(batchId);
      setBatch(fresh);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel.');
    } finally {
      setActionPending(false);
    }
  }

  async function handleRetryFailed() {
    setActionPending(true);
    setActionError(null);
    try {
      await retryFailedRequest(batchId);
      const fresh = await fetchBatchDetailClient(batchId);
      setBatch(fresh);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to retry.');
    } finally {
      setActionPending(false);
    }
  }

  const canCancel = !TERMINAL_BATCH_STATUSES.has(batch.status);
  const canRetryFailed = batch.failedUrls > 0 && batch.status !== 'CANCELLED';
  const pct = batch.totalUrls === 0 ? 0 : Math.round((batch.completedUrls / batch.totalUrls) * 100);

  return (
    <div>
      <div
        className="section"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h1 style={{ fontSize: 20, marginBottom: 4 }}>Batch {batch.id.slice(0, 8)}</h1>
          <StatusBadge status={batch.status} />{' '}
          <span className="muted" style={{ fontSize: 12 }}>
            {connected ? 'live' : 'reconnecting...'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleRetryFailed} disabled={!canRetryFailed || actionPending}>
            Retry failed only
          </button>
          <button onClick={handleCancel} disabled={!canCancel || actionPending}>
            Cancel batch
          </button>
        </div>
      </div>

      {actionError && <p className="error-cell">{actionError}</p>}

      <div className="section">
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          {batch.completedUrls} / {batch.totalUrls} checked &middot; {batch.successfulUrls} succeeded &middot;{' '}
          {batch.failedUrls} failed
        </p>
      </div>

      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Status</th>
            <th>HTTP</th>
            <th>Time</th>
            <th>Title</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {batch.urlChecks.map((check) => (
            <tr key={check.id}>
              <td
                style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {check.url}
              </td>
              <td>
                <StatusBadge status={check.status} />
              </td>
              <td>{check.httpStatus ?? '-'}</td>
              <td>{check.responseTimeMs != null ? `${check.responseTimeMs}ms` : '-'}</td>
              <td className="muted">{check.pageTitle ?? '-'}</td>
              <td className="error-cell">{check.error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function mergeUrlCheck(existing: UrlCheckDto[], updated: UrlCheckDto): UrlCheckDto[] {
  const index = existing.findIndex((c) => c.id === updated.id);
  if (index === -1) return [...existing, updated];
  const copy = existing.slice();
  copy[index] = updated;
  return copy;
}

import Link from 'next/link';
import { fetchBatchList } from '../../lib/api';
import type { BatchSummary } from '@bulk-url/shared';

export const dynamic = 'force-dynamic'; // this page must never be statically cached by Next -- the API's own 30s cache is the only cache in the system

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{status}</span>;
}

function ProgressCell({ batch }: { batch: BatchSummary }) {
  const pct = batch.totalUrls === 0 ? 0 : Math.round((batch.completedUrls / batch.totalUrls) * 100);
  return (
    <div style={{ minWidth: 120 }}>
      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {batch.completedUrls} / {batch.totalUrls}
      </div>
    </div>
  );
}

export default async function BatchesPage() {
  const { batches, cached } = await fetchBatchList();

  return (
    <div>
      <div
        className="section"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <h1 style={{ fontSize: 20 }}>Batches</h1>
        <Link href="/batches/new">
          <button className="primary">New batch</button>
        </Link>
      </div>

      {batches.length === 0 ? (
        <p className="muted">No batches yet. Create one to get started.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Success</th>
              <th>Failed</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td>
                  <Link href={`/batches/${batch.id}`}>{batch.id.slice(0, 8)}</Link>
                </td>
                <td>
                  <StatusBadge status={batch.status} />
                </td>
                <td>
                  <ProgressCell batch={batch} />
                </td>
                <td>{batch.successfulUrls}</td>
                <td>{batch.failedUrls}</td>
                <td className="muted">{new Date(batch.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        {cached ? 'Served from 30s cache.' : 'Served fresh (cache miss/expired).'}
      </p>
    </div>
  );
}

import { notFound } from 'next/navigation';
import { fetchBatchDetail } from '../../../lib/api';
import { BatchDetailClient } from './BatchDetailClient';

export const dynamic = 'force-dynamic';

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let initialData;
  try {
    initialData = await fetchBatchDetail(id);
  } catch {
    notFound();
  }

  // The server-rendered fetch above is what makes "open this URL cold, in a
  // new tab, with zero prior client state" produce the correct result on the
  // very first paint. BatchDetailClient then takes over for live updates.
  return <BatchDetailClient batchId={id} initialData={initialData} />;
}

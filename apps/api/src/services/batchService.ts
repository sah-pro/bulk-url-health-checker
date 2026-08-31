import { PoolClient } from 'pg';
import { parseUrlList } from '@bulk-url/shared';
import type { BatchSummary, BatchDetail, UrlCheckDto, BatchStatus, UrlCheckStatus } from '@bulk-url/shared';
import { pool, withTransaction } from '../db/pool';
import { urlCheckQueue, jobIdFor } from '../lib/queue';
import { invalidateBatchListCache, getCachedBatchList, setCachedBatchList } from '../lib/cache';
import { redis } from '../lib/redis';

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

/** Shape of a row from the `batches` table, as returned by `pg` (snake_case columns). */
interface BatchRow {
  id: string;
  status: BatchStatus;
  total_urls: number;
  completed_urls: number;
  successful_urls: number;
  failed_urls: number;
  created_at: Date;
  updated_at: Date;
  cancelled_at: Date | null;
}

/** Shape of a row from the `url_checks` table, as returned by `pg` (snake_case columns). */
interface UrlCheckRow {
  id: string;
  batch_id: string;
  url: string;
  normalized_url: string;
  status: UrlCheckStatus;
  http_status: number | null;
  response_time_ms: number | null;
  page_title: string | null;
  error: string | null;
  attempt: number;
  max_attempts: number;
  run_generation: number;
  created_at: Date;
  updated_at: Date;
}

function rowToBatchSummary(row: BatchRow): BatchSummary {
  return {
    id: row.id,
    status: row.status,
    totalUrls: row.total_urls,
    completedUrls: row.completed_urls,
    successfulUrls: row.successful_urls,
    failedUrls: row.failed_urls,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
  };
}

function rowToUrlCheckDto(row: UrlCheckRow): UrlCheckDto {
  return {
    id: row.id,
    batchId: row.batch_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    status: row.status,
    httpStatus: row.http_status,
    responseTimeMs: row.response_time_ms,
    pageTitle: row.page_title,
    error: row.error,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    runGeneration: row.run_generation,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Creates a batch and all of its url_checks in a single transaction, then
 * enqueues one BullMQ job per URL only after that transaction has committed.
 *
 * This ordering is the "critical requirement" from the assignment: if the
 * process crashes between the DB commit and enqueueing, the batch and its
 * rows still exist (durable, just stuck QUEUED) and can be recovered by a
 * reconciliation job; but nothing is ever enqueued for a URL that isn't
 * durably persisted first.
 */
export async function createBatch(rawUrls: string[]): Promise<BatchSummary> {
  const { valid, invalid } = parseUrlList(rawUrls.join('\n'));

  if (valid.length === 0) {
    throw new ValidationError(
      invalid.length > 0 ? 'No valid URLs found in submission.' : 'No URLs provided.',
    );
  }

  const { batchRow, checkRows } = await withTransaction(async (client: PoolClient) => {
    const batchResult = await client.query<BatchRow>(
      `INSERT INTO batches (status, total_urls) VALUES ('PENDING', $1) RETURNING *`,
      [valid.length],
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      throw new Error('INSERT ... RETURNING * for a new batch unexpectedly returned no row.');
    }

    const insertedChecks: UrlCheckRow[] = [];
    for (const line of valid) {
      const res = await client.query<UrlCheckRow>(
        `INSERT INTO url_checks (batch_id, url, normalized_url, status)
         VALUES ($1, $2, $3, 'QUEUED') RETURNING *`,
        [batch.id, line.raw, line.normalized],
      );
      const inserted = res.rows[0];
      if (!inserted) {
        throw new Error('INSERT ... RETURNING * for a new url_check unexpectedly returned no row.');
      }
      insertedChecks.push(inserted);
    }

    return { batchRow: batch, checkRows: insertedChecks };
  });

  // Persistence is committed. Now enqueue -- outside the DB transaction,
  // since a queue is not transactional with Postgres. Every row starts at
  // run_generation 0 (column default), so the job id encodes that generation
  // explicitly -- see jobIdFor() in lib/queue.ts.
  await Promise.all(
    checkRows.map((row) =>
      urlCheckQueue.add(
        'check-url',
        { batchId: row.batch_id, urlCheckId: row.id, normalizedUrl: row.normalized_url, runGeneration: 0 },
        { jobId: jobIdFor(row.id, 0) },
      ),
    ),
  );

  await pool.query(`UPDATE batches SET status = 'RUNNING' WHERE id = $1 AND status = 'PENDING'`, [
    batchRow.id,
  ]);
  batchRow.status = 'RUNNING';

  await invalidateBatchListCache();
  await publishBatchUpdate(batchRow.id);

  return rowToBatchSummary(batchRow);
}

export async function listBatches(
  limit: number,
  offset: number,
): Promise<{ batches: BatchSummary[]; cached: boolean }> {
  // Only the unfiltered, default-paged first page is cached; it's overwhelmingly
  // the common request (the batch list view) and keeps the cache key trivial.
  const cacheable = limit === 50 && offset === 0;

  if (cacheable) {
    const cached = await getCachedBatchList();
    if (cached) {
      return { batches: JSON.parse(cached), cached: true };
    }
  }

  const { rows } = await pool.query<BatchRow>(
    `SELECT * FROM batches ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const batches = rows.map(rowToBatchSummary);

  if (cacheable) {
    await setCachedBatchList(JSON.stringify(batches));
  }

  return { batches, cached: false };
}

export async function getBatchDetail(id: string): Promise<BatchDetail> {
  const batchResult = await pool.query<BatchRow>(`SELECT * FROM batches WHERE id = $1`, [id]);
  if (batchResult.rows.length === 0) {
    throw new NotFoundError('Batch not found');
  }
  const checksResult = await pool.query<UrlCheckRow>(
    `SELECT * FROM url_checks WHERE batch_id = $1 ORDER BY created_at ASC`,
    [id],
  );

  const batchRow = batchResult.rows[0];
  if (!batchRow) {
    // Row existed for the length check above but vanished by the time we
    // read it back -- treat as not-found rather than crash the request.
    throw new NotFoundError('Batch not found');
  }

  return {
    ...rowToBatchSummary(batchRow),
    urlChecks: checksResult.rows.map(rowToUrlCheckDto),
  };
}

/**
 * Cancels a batch. Idempotent: cancelling an already-terminal or
 * already-cancelled batch is a no-op that returns the current state rather
 * than erroring, so a doubled-up client request can never corrupt anything.
 *
 * Queued jobs: flipping their url_checks row to CANCELLED here means that
 * when the worker eventually picks up the corresponding job, its
 * claim-for-processing UPDATE (see worker/processUrl.ts) will affect zero
 * rows (it only claims rows still in QUEUED) and the worker will skip them.
 *
 * In-flight jobs: we do not force-abort a request already in progress (see
 * README trade-offs). Instead we rely on the same claim pattern in reverse --
 * when the in-flight job tries to write SUCCESS/FAILED, it uses a conditional
 * UPDATE ... WHERE status = 'PROCESSING'. Since we've already moved that row
 * to CANCELLED (only if it was QUEUED -- see the WHERE clause below), a
 * PROCESSING row is intentionally left alone here and allowed to finish
 * naturally; its result is still recorded, which is more useful than
 * discarding real completed work, and it does not affect the CANCELLED
 * batch's authoritative status because batch status is fixed once cancelled.
 */
export async function cancelBatch(id: string): Promise<BatchSummary> {
  const result = await withTransaction(async (client) => {
    const batchRes = await client.query<BatchRow>(`SELECT * FROM batches WHERE id = $1 FOR UPDATE`, [id]);
    if (batchRes.rows.length === 0) {
      throw new NotFoundError('Batch not found');
    }
    const batch = batchRes.rows[0];
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    if (batch.status === 'CANCELLED' || ['COMPLETED', 'FAILED', 'PARTIALLY_FAILED'].includes(batch.status)) {
      return batch; // idempotent no-op
    }

    await client.query(
      `UPDATE url_checks SET status = 'CANCELLED' WHERE batch_id = $1 AND status = 'QUEUED'`,
      [id],
    );
    const updated = await client.query<BatchRow>(
      `UPDATE batches SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      throw new Error('UPDATE ... RETURNING * for cancelBatch unexpectedly returned no row.');
    }
    return updatedRow;
  });

  await invalidateBatchListCache();
  await publishBatchUpdate(id);
  return rowToBatchSummary(result);
}

/**
 * Re-enqueues only URLs currently in FAILED state. Resets them to QUEUED and
 * clears prior error/result fields.
 *
 * Idempotent against double-clicks: the UPDATE ... WHERE status = 'FAILED'
 * ... RETURNING pattern means a second concurrent call will find zero FAILED
 * rows left to claim (the first call already moved them to QUEUED) and will
 * enqueue nothing new -- BullMQ's jobId de-dup is a second line of defense.
 */
export async function retryFailedUrls(id: string): Promise<BatchSummary> {
  const { batch, resetRows } = await withTransaction(async (client) => {
    const batchRes = await client.query<BatchRow>(`SELECT * FROM batches WHERE id = $1 FOR UPDATE`, [id]);
    if (batchRes.rows.length === 0) {
      throw new NotFoundError('Batch not found');
    }
    const currentBatch = batchRes.rows[0];
    if (!currentBatch) {
      throw new NotFoundError('Batch not found');
    }
    if (currentBatch.status === 'CANCELLED') {
      throw new ValidationError('Cannot retry URLs in a cancelled batch.');
    }

    const reset = await client.query<UrlCheckRow>(
      `UPDATE url_checks
       SET status = 'QUEUED', http_status = NULL, response_time_ms = NULL,
           page_title = NULL, error = NULL, attempt = 0, run_generation = run_generation + 1
       WHERE batch_id = $1 AND status = 'FAILED'
       RETURNING *`,
      [id],
    );

    // Only flip the batch back to RUNNING if there was actually something to
    // retry. Without this guard, a repeated/stale retry-failed call (or one
    // made against a batch with zero FAILED rows) would unconditionally move
    // a terminal batch -- e.g. a fully COMPLETED one -- to RUNNING even
    // though no job is enqueued to ever move it out of that state again,
    // leaving it stuck. When there's nothing to reset, leave the batch's
    // current status untouched and just report it back.
    if (reset.rows.length === 0) {
      return { batch: currentBatch, resetRows: reset.rows };
    }

    const updatedBatch = await client.query<BatchRow>(
      `UPDATE batches SET status = 'RUNNING' WHERE id = $1 RETURNING *`,
      [id],
    );
    const updatedRow = updatedBatch.rows[0];
    if (!updatedRow) {
      throw new Error('UPDATE ... RETURNING * for retryFailedUrls unexpectedly returned no row.');
    }

    return { batch: updatedRow, resetRows: reset.rows };
  });

  // Each reset row now carries a freshly incremented run_generation (bumped
  // atomically above, guarded by the batch row's FOR UPDATE lock so two
  // concurrent retry-failed calls can never both increment the same row).
  // That new generation gives every legitimate retry a brand-new job id
  // (see jobIdFor() in lib/queue.ts) -- no need to remove any previous
  // completed job first, and no risk of colliding with it.
  await Promise.all(
    resetRows.map((row: UrlCheckRow) =>
      urlCheckQueue.add(
        'check-url',
        {
          batchId: row.batch_id,
          urlCheckId: row.id,
          normalizedUrl: row.normalized_url,
          runGeneration: row.run_generation,
        },
        { jobId: jobIdFor(row.id, row.run_generation) },
      ),
    ),
  );

  await invalidateBatchListCache();
  await publishBatchUpdate(id);
  return rowToBatchSummary(batch);
}

/** Publishes the current batch state to Redis pub/sub so any API instance's SSE clients see it. */
export async function publishBatchUpdate(batchId: string): Promise<void> {
  const detail = await getBatchDetail(batchId).catch(() => null);
  if (!detail) return;
  await redis.publish(`batch:${batchId}`, JSON.stringify({ type: 'batch-updated', batch: detail }));
}

/**
 * Reconciles url_checks rows that are durably QUEUED in Postgres but may
 * have no corresponding BullMQ job -- the gap the assignment calls out
 * explicitly: DB commit succeeds, then the enqueue step partially or
 * entirely fails (process crash, Redis blip, etc.) between COMMIT and
 * `.add()`. Postgres remains authoritative throughout (createBatch and
 * retryFailedUrls both write QUEUED rows *before* enqueueing), so recovery
 * is just "find QUEUED rows with no live job, and enqueue them" -- no
 * separate outbox table is needed because the url_checks row itself already
 * *is* the durable record of intended work, and its deterministic job id
 * (see jobIdFor) makes re-enqueueing idempotent.
 *
 * `staleAfterMs` is a look-back window, not an arbitrary polling interval:
 * a row is only considered for reconciliation once it has sat in QUEUED
 * without being touched for at least this long. This is what avoids the
 * race the assignment calls out -- "API enqueues job, reconciliation sees
 * the QUEUED record, the API's own enqueue call is still in flight" -- by
 * construction: a row that was just inserted/reset has an `updated_at`
 * within the last few milliseconds, well inside the window, so this pass
 * simply skips it and lets the original enqueue call finish normally.
 *
 * Idempotent: `urlCheckQueue.add()` with a job id that already exists (in
 * any non-removed state) is a safe no-op, so even if this runs concurrently
 * with the original enqueue for the same row, or runs twice back to back,
 * at most one job ever exists per (urlCheckId, runGeneration).
 *
 * Known limitation (documented, not silently ignored): this only recovers
 * the "DB says QUEUED but no job exists" direction. The symmetric failure
 * -- a BullMQ job finishes but the DB write in finalizeCheck never lands
 * (e.g. the worker process is killed mid-transaction) -- is a different
 * failure mode. That case isn't silently lost either: the row stays
 * PROCESSING, which is exactly what BullMQ's own stalled-job detection is
 * designed to catch and redeliver (see README "Failure scenarios" and the
 * worker's run_generation-aware claim step, which allows a redelivered
 * attempt to reclaim a PROCESSING row) -- but it is not this function's
 * job, and is called out here explicitly rather than left implicit.
 */
export async function reconcileStuckUrlChecks(
  staleAfterMs = 15000,
): Promise<{ scanned: number; enqueued: number }> {
  const { rows } = await pool.query<UrlCheckRow>(
    `SELECT * FROM url_checks
     WHERE status = 'QUEUED' AND updated_at < now() - ($1 || ' milliseconds')::interval`,
    [staleAfterMs],
  );

  let enqueued = 0;
  for (const row of rows) {
    const jobId = jobIdFor(row.id, row.run_generation);
    const existing = await urlCheckQueue.getJob(jobId);
    if (existing) {
      // A job already exists under this row's current generation -- nothing
      // missing here, whatever earlier problem caused this row to look
      // "stuck" (a slow worker, a saturated global rate/concurrency limit,
      // etc.) is not a missing-job problem and reconciliation must not
      // interfere with it.
      continue;
    }
    await urlCheckQueue.add(
      'check-url',
      {
        batchId: row.batch_id,
        urlCheckId: row.id,
        normalizedUrl: row.normalized_url,
        runGeneration: row.run_generation,
      },
      { jobId },
    );
    enqueued += 1;
  }

  return { scanned: rows.length, enqueued };
}

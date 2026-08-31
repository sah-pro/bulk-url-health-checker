import { Redis } from 'ioredis';
import { PoolClient, Pool } from 'pg';
import { performHealthCheck } from './healthCheck';
import { GlobalRateLimiter } from './rateLimiter';
import { GlobalConcurrencyLimiter } from './concurrencyLimiter';
import type { UrlCheckJobData } from '@bulk-url/shared';
import { randomUUID } from 'node:crypto';
import { env } from './config';

/**
 * Job payload is shared between API and worker through packages/shared so
 * queue contracts cannot silently drift between independently deployed processes.
 */

export type UrlCheckJobPayload = UrlCheckJobData;

const RETRYABLE_5XX_THRESHOLD = 500;

export class TransientFailureError extends Error {
  constructor(message: string, public readonly claimToken: string) {
    super(message);
    this.name = 'TransientFailureError';
  }
}

interface Deps {
  pool: Pool;
  redis: Redis;
  rateLimiter: GlobalRateLimiter;
  concurrencyLimiter: GlobalConcurrencyLimiter;
}

/**
 * Processes a single URL check job. Designed to be safe if BullMQ ever
 * delivers the same job more than once (at-least-once delivery is BullMQ's
 * documented guarantee, not exactly-once) -- see the claim step below --
 * and to correctly handle BullMQ's own internal retry-with-backoff, which
 * redelivers the *same* job id at a higher `attempt` number rather than
 * creating a new job.
 */
export async function processUrlCheckJob(
  payload: UrlCheckJobPayload,
  attempt: number,
  deps: Deps,
): Promise<void> {
  const { pool, redis, rateLimiter, concurrencyLimiter } = deps;

  // --- Idempotent, generation-aware leased claim ----------------------
  // The claim has three independent guards:
  //   1. run_generation rejects stale jobs from an older retry generation.
  //   2. attempt < current attempt accepts BullMQ's legitimate next retry.
  //   3. for the same attempt, only an expired processing lease may be reclaimed.
  // A fresh lease therefore blocks duplicate delivery while an expired lease
  // lets BullMQ recover work after a worker crash.
  const claimToken = randomUUID();
  const claim = await pool.query<{ id: string; processing_claim_token: string }>(
    `UPDATE url_checks
     SET status = 'PROCESSING', attempt = $3, processing_claim_token = $4,
         processing_lease_until = now() + ($5 || ' milliseconds')::interval
     WHERE id = $1
       AND run_generation = $2
       AND (
         (status = 'QUEUED' AND attempt < $3)
         OR (status = 'PROCESSING' AND attempt < $3)
         OR (status = 'PROCESSING' AND attempt = $3 AND processing_lease_until < now())
       )
     RETURNING id, processing_claim_token`,
    [payload.urlCheckId, payload.runGeneration, attempt, claimToken, env.IN_FLIGHT_LEASE_MS],
  );
  if (claim.rowCount === 0) {
    return; // stale/duplicate delivery, active duplicate, cancelled, superseded generation, or terminal
  }

  const execution = { claimToken: claim.rows[0]!.processing_claim_token };
  await markBatchRunning(pool, payload.batchId);

  // --- Global guarantees: concurrency first (cheaper to wait on), then rate ---
  await concurrencyLimiter.withSlot(async () => {
    await rateLimiter.acquire();
    const result = await performHealthCheck(payload.normalizedUrl);

    if (result.outcome === 'success' && result.httpStatus >= RETRYABLE_5XX_THRESHOLD) {
      // A 5xx is plausibly transient (overloaded/restarting server) and
      // eligible for retry. But if this turns out to be the *last* attempt,
      // the final HTTP status and response time must still be visible to
      // the user -- persisting them here (row stays PROCESSING) means
      // they're already durably recorded before we throw, regardless of
      // which code path (another retry, or exhaustion) runs next.
      await persistInterimResult(pool, payload, execution.claimToken, result.httpStatus, result.responseTimeMs);
      throw new TransientFailureError(`Upstream returned ${result.httpStatus}`, execution.claimToken);
    }

    if (result.outcome === 'success') {
      await finalizeCheck(pool, redis, payload, execution.claimToken, {
        status: 'SUCCESS',
        httpStatus: result.httpStatus,
        responseTimeMs: result.responseTimeMs,
        pageTitle: result.pageTitle,
        error: null,
      });
      return;
    }

    if (result.transient) {
      // Network-level transient failure (timeout, DNS, connection reset,
      // etc.): there is no HTTP status to record (no response was ever
      // received), but the measured response time up to the point of
      // failure is still meaningful, so persist that much before retrying.
      await persistInterimResult(pool, payload, execution.claimToken, null, result.responseTimeMs);
      throw new TransientFailureError(result.error, execution.claimToken);
    }

    // Permanent failure: do not retry regardless of attempts remaining.
    await finalizeCheck(pool, redis, payload, execution.claimToken, {
      status: 'FAILED',
      httpStatus: null,
      responseTimeMs: result.responseTimeMs,
      pageTitle: null,
      error: result.error,
    });
  });
}

/**
 * Writes the most recent attempt's observed http_status/response_time_ms
 * without changing status away from PROCESSING or touching `error`. Called
 * right before throwing a TransientFailureError, so that whichever attempt
 * turns out to be the last one, its real result is already durably
 * recorded and finalizeExhaustedRetries (below) doesn't have to fabricate
 * or null it out.
 *
 * Guarded by both run_generation and processing_claim_token so a stale
 * worker cannot write results after another worker has legitimately reclaimed
 * the execution.
 */
async function persistInterimResult(
  pool: Pool,
  payload: UrlCheckJobPayload,
  claimToken: string,
  httpStatus: number | null,
  responseTimeMs: number | null,
): Promise<void> {
  await pool.query(
    `UPDATE url_checks SET http_status = $4, response_time_ms = $5
     WHERE id = $1 AND run_generation = $2 AND status = 'PROCESSING' AND processing_claim_token = $3`,
    [payload.urlCheckId, payload.runGeneration, claimToken, httpStatus, responseTimeMs],
  );
}

/**
 * Called from the BullMQ worker's failure handler when a job has exhausted
 * all attempts. Writes the terminal FAILED state so a check that kept
 * hitting transient errors doesn't stay stuck in PROCESSING forever.
 *
 * Deliberately does NOT overwrite http_status/response_time_ms with null:
 * the last attempt's persistInterimResult() call (above) already recorded
 * whatever was actually observed (a final 5xx status and its response time,
 * or nulls if the last attempt was a pure network failure with no
 * response) -- this only needs to flip status and set the error message.
 */
export async function finalizeExhaustedRetries(
  payload: UrlCheckJobPayload,
  lastError: string,
  claimToken: string,
  pool: Pool,
  redis: Redis,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE url_checks SET status = 'FAILED', error = $4, processing_claim_token = NULL, processing_lease_until = NULL
       WHERE id = $1 AND run_generation = $2 AND status = 'PROCESSING' AND processing_claim_token = $3
       RETURNING batch_id`,
      [payload.urlCheckId, payload.runGeneration, claimToken, lastError],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await recomputeBatchAggregates(client, payload.batchId);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await publishUpdate(pool, redis, payload.batchId, payload.urlCheckId);
}

async function finalizeCheck(
  pool: Pool,
  redis: Redis,
  payload: UrlCheckJobPayload,
  claimToken: string,
  fields: {
    status: 'SUCCESS' | 'FAILED';
    httpStatus: number | null;
    responseTimeMs: number | null;
    pageTitle: string | null;
    error: string | null;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Conditional on PROCESSING *and* this row's current run_generation: if
    // the batch was cancelled while this request was in flight,
    // cancelBatch() only touches QUEUED rows (see batchService.ts), so this
    // row is still PROCESSING and this write is allowed to land -- a
    // completed result is more useful than a discarded one, and the batch's
    // own status is already fixed at CANCELLED regardless of what happens
    // to individual in-flight rows. But if a *retry-failed* call bumped
    // run_generation while this (older-generation) request was in flight,
    // this write must NOT land -- it would overwrite the newer generation's
    // QUEUED/PROCESSING state with a stale result from a superseded run.
    const updated = await client.query(
      `UPDATE url_checks
       SET status = $4, http_status = $5, response_time_ms = $6, page_title = $7, error = $8,
           processing_claim_token = NULL, processing_lease_until = NULL
       WHERE id = $1 AND run_generation = $2 AND status = 'PROCESSING'
         AND processing_claim_token = $3
       RETURNING batch_id`,
      [
        payload.urlCheckId,
        payload.runGeneration,
        claimToken,
        fields.status,
        fields.httpStatus,
        fields.responseTimeMs,
        fields.pageTitle,
        fields.error,
      ],
    );

    if ((updated.rowCount ?? 0) > 0) {
      await recomputeBatchAggregates(client, payload.batchId);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await publishUpdate(pool, redis, payload.batchId, payload.urlCheckId);
}

async function markBatchRunning(pool: Pool, batchId: string): Promise<void> {
  await pool.query(`UPDATE batches SET status = 'RUNNING' WHERE id = $1 AND status = 'PENDING'`, [batchId]);
}

/**
 * Recomputes batch-level counters and terminal status from the authoritative
 * url_checks rows (rather than incrementing counters independently, which
 * could drift under concurrent writers). Must run inside the same
 * transaction as the row update it follows, using the same client, so the
 * aggregate is always consistent with the row that triggered it.
 */
async function recomputeBatchAggregates(client: PoolClient, batchId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE status IN ('SUCCESS','FAILED','CANCELLED')) AS completed,
       count(*) FILTER (WHERE status = 'SUCCESS') AS successful,
       count(*) FILTER (WHERE status = 'FAILED') AS failed,
       count(*) AS total
     FROM url_checks WHERE batch_id = $1`,
    [batchId],
  );
  const { completed, successful, failed, total } = rows[0];

  let status: string | null = null;
  if (Number(completed) === Number(total)) {
    if (Number(failed) === 0) status = 'COMPLETED';
    else if (Number(successful) === 0) status = 'FAILED';
    else status = 'PARTIALLY_FAILED';
  }

  await client.query(
    `UPDATE batches
     SET completed_urls = $2, successful_urls = $3, failed_urls = $4,
         status = CASE WHEN status = 'CANCELLED' THEN status WHEN $5::batch_status IS NOT NULL THEN $5::batch_status ELSE status END
     WHERE id = $1`,
    [batchId, completed, successful, failed, status],
  );
}

async function publishUpdate(pool: Pool, redis: Redis, batchId: string, urlCheckId: string): Promise<void> {
  const [batchRes, checkRes] = await Promise.all([
    pool.query(`SELECT * FROM batches WHERE id = $1`, [batchId]),
    pool.query(`SELECT * FROM url_checks WHERE id = $1`, [urlCheckId]),
  ]);
  if (batchRes.rows.length === 0 || checkRes.rows.length === 0) return;

  const b = batchRes.rows[0];
  const c = checkRes.rows[0];

  const batchPayload = {
    id: b.id,
    status: b.status,
    totalUrls: b.total_urls,
    completedUrls: b.completed_urls,
    successfulUrls: b.successful_urls,
    failedUrls: b.failed_urls,
    createdAt: b.created_at.toISOString(),
    updatedAt: b.updated_at.toISOString(),
    cancelledAt: b.cancelled_at ? b.cancelled_at.toISOString() : null,
  };
  const checkPayload = {
    id: c.id,
    batchId: c.batch_id,
    url: c.url,
    normalizedUrl: c.normalized_url,
    status: c.status,
    httpStatus: c.http_status,
    responseTimeMs: c.response_time_ms,
    pageTitle: c.page_title,
    error: c.error,
    attempt: c.attempt,
    maxAttempts: c.max_attempts,
    runGeneration: c.run_generation,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  };

  await redis.publish(`batch:${batchId}`, JSON.stringify({ type: 'url-updated', urlCheck: checkPayload }));
  await redis.publish(`batch:${batchId}`, JSON.stringify({ type: 'batch-updated', batch: batchPayload }));
  await redis.del('cache:batches:list'); // batch state changed -- invalidate list cache from the worker side too
}

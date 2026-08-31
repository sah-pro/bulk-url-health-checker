/**
 * Integration tests against REAL Postgres + Redis (see vitest.config.ts) for
 * two specific bugs fixed in processUrl.ts:
 *
 *  1. The claim query used to require `status = 'QUEUED'`, which silently
 *     broke every BullMQ-internal retry after the first attempt (the row is
 *     already PROCESSING by then) -- the "job never actually re-runs" bug.
 *  2. A 5xx (or network-transient) result must have its http_status /
 *     response_time_ms durably recorded even if it turns out to be the
 *     last attempt -- finalizeExhaustedRetries must not null them out.
 *
 * performHealthCheck itself talks to the real network and is already
 * exercised live elsewhere (README "Verification"); this file mocks only
 * that one function so the HTTP outcome is deterministic, while every
 * assertion here is against real Postgres row state written by the real
 * claim/finalize SQL -- not against the mock.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { pool } from '../db';
import { redis } from '../redis';
import { GlobalRateLimiter } from '../rateLimiter';
import { GlobalConcurrencyLimiter } from '../concurrencyLimiter';
import * as healthCheckModule from '../healthCheck';
import { processUrlCheckJob, finalizeExhaustedRetries, UrlCheckJobPayload } from '../processUrl';

const rateLimiter = new GlobalRateLimiter(redis);
const concurrencyLimiter = new GlobalConcurrencyLimiter(redis);
const deps = { pool, redis, rateLimiter, concurrencyLimiter };

async function seedBatchAndCheck(): Promise<UrlCheckJobPayload> {
  const batchRes = await pool.query(
    `INSERT INTO batches (status, total_urls) VALUES ('RUNNING', 1) RETURNING id`,
  );
  const batchId = batchRes.rows[0].id;
  const checkRes = await pool.query(
    `INSERT INTO url_checks (batch_id, url, normalized_url, status) VALUES ($1, $2, $2, 'QUEUED') RETURNING id`,
    [batchId, 'https://worker-test.example/x'],
  );
  return {
    batchId,
    urlCheckId: checkRes.rows[0].id,
    normalizedUrl: 'https://worker-test.example/x',
    runGeneration: 0,
  };
}

async function getRow(urlCheckId: string) {
  const { rows } = await pool.query(`SELECT * FROM url_checks WHERE id = $1`, [urlCheckId]);
  return rows[0];
}

async function cleanDb() {
  await pool.query('TRUNCATE batches CASCADE');
  // Clear the rate limiter / concurrency semaphore keys so tests don't
  // throttle each other across runs.
  await redis.del('ratelimit:url-check', 'inflight:url-check');
}

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

describe('worker claim query: retries actually re-run the check', () => {
  it('a second (retry) attempt is genuinely claimed and re-processed even though the row is already PROCESSING', async () => {
    const payload = await seedBatchAndCheck();

    const spy = vi
      .spyOn(healthCheckModule, 'performHealthCheck')
      .mockResolvedValueOnce({ outcome: 'success', httpStatus: 503, responseTimeMs: 10, pageTitle: null })
      .mockResolvedValueOnce({ outcome: 'success', httpStatus: 200, responseTimeMs: 12, pageTitle: 'OK' });

    // Attempt 1: throws (transient 5xx), row left PROCESSING with the
    // interim result recorded.
    await expect(processUrlCheckJob(payload, 1, deps)).rejects.toThrow();
    let row = await getRow(payload.urlCheckId);
    expect(row.status).toBe('PROCESSING');
    expect(row.http_status).toBe(503);
    expect(row.attempt).toBe(1);

    // Attempt 2 (BullMQ-internal retry -- same job, same generation, higher
    // attempt number). Before the fix, the claim required status='QUEUED'
    // and this call would silently no-op (return without throwing and
    // without calling performHealthCheck a second time) -- proving the fix
    // means performHealthCheck really was called again.
    await processUrlCheckJob(payload, 2, deps);
    expect(spy).toHaveBeenCalledTimes(2);

    row = await getRow(payload.urlCheckId);
    expect(row.status).toBe('SUCCESS');
    expect(row.http_status).toBe(200);
    expect(row.attempt).toBe(2);
  });

  it('a duplicate delivery of the SAME attempt number is rejected (no double-processing)', async () => {
    const payload = await seedBatchAndCheck();
    const spy = vi
      .spyOn(healthCheckModule, 'performHealthCheck')
      .mockResolvedValue({ outcome: 'success', httpStatus: 200, responseTimeMs: 5, pageTitle: null });

    await processUrlCheckJob(payload, 1, deps);
    // A second delivery claiming to also be "attempt 1" (e.g. a stalled-job
    // redelivery racing the first, already-finished delivery) must not
    // reprocess.
    await processUrlCheckJob(payload, 1, deps);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a stale job from a superseded run_generation cannot claim or overwrite the row', async () => {
    const payload = await seedBatchAndCheck();
    // Simulate the row having already moved on to generation 1 (as if
    // retry-failed ran while this generation-0 job was still in flight).
    await pool.query(`UPDATE url_checks SET run_generation = 1 WHERE id = $1`, [payload.urlCheckId]);

    const spy = vi.spyOn(healthCheckModule, 'performHealthCheck');
    await processUrlCheckJob(payload /* still says runGeneration: 0 */, 1, deps);

    expect(spy).not.toHaveBeenCalled(); // claim must fail before any network call
    const row = await getRow(payload.urlCheckId);
    expect(row.run_generation).toBe(1); // untouched
    expect(row.status).toBe('QUEUED'); // untouched
  });
});

describe('worker crash/stalled-job recovery', () => {
  it('reclaims an expired processing lease for the same BullMQ attempt', async () => {
    const payload = await seedBatchAndCheck();
    const spy = vi.spyOn(healthCheckModule, 'performHealthCheck').mockResolvedValue({
      outcome: 'success', httpStatus: 200, responseTimeMs: 11, pageTitle: 'Recovered',
    });

    await pool.query(
      `UPDATE url_checks
       SET status = 'PROCESSING', attempt = 1,
           processing_claim_token = gen_random_uuid(),
           processing_lease_until = now() - interval '1 second'
       WHERE id = $1`,
      [payload.urlCheckId],
    );

    await processUrlCheckJob(payload, 1, deps);

    expect(spy).toHaveBeenCalledTimes(1);
    const row = await getRow(payload.urlCheckId);
    expect(row.status).toBe('SUCCESS');
    expect(row.attempt).toBe(1);
    expect(row.processing_claim_token).toBeNull();
    expect(row.processing_lease_until).toBeNull();
  });

  it('does not allow a fresh processing lease to be stolen by duplicate delivery', async () => {
    const payload = await seedBatchAndCheck();
    const spy = vi.spyOn(healthCheckModule, 'performHealthCheck').mockResolvedValue({
      outcome: 'success', httpStatus: 200, responseTimeMs: 11, pageTitle: null,
    });

    await processUrlCheckJob(payload, 1, deps);
    await processUrlCheckJob(payload, 1, deps);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('final HTTP status / response time preserved after exhausted retries', () => {
  it('a final 503 is preserved, not nulled out, once retries are exhausted', async () => {
    const payload = await seedBatchAndCheck();
    vi.spyOn(healthCheckModule, 'performHealthCheck').mockResolvedValue({
      outcome: 'success',
      httpStatus: 503,
      responseTimeMs: 42,
      pageTitle: null,
    });

    // Simulate BullMQ driving 4 attempts (matches queue.ts's attempts: 4),
    // the same way apps/worker/src/index.ts's job handler does: call
    // processUrlCheckJob for each attempt, and on the LAST one, catch the
    // thrown error and call finalizeExhaustedRetries instead of retrying.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(processUrlCheckJob(payload, attempt, deps)).rejects.toThrow();
    }
    let lastError: string = '';
    try {
      await processUrlCheckJob(payload, 4, deps);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    const rowBeforeFinalize = await getRow(payload.urlCheckId);
    await finalizeExhaustedRetries(payload, lastError, rowBeforeFinalize.processing_claim_token, pool, redis);

    const row = await getRow(payload.urlCheckId);
    expect(row.status).toBe('FAILED');
    expect(row.http_status).toBe(503); // NOT null -- the actual final observed status
    expect(row.response_time_ms).toBe(42);
    expect(row.error).toContain('503');
  });

  it('a final pure network failure (no response) correctly stores http_status = NULL, not a fabricated value', async () => {
    const payload = await seedBatchAndCheck();
    vi.spyOn(healthCheckModule, 'performHealthCheck').mockResolvedValue({
      outcome: 'failure',
      transient: true,
      error: 'ECONNRESET: simulated',
      responseTimeMs: 7,
    });

    let lastError = '';
    try {
      await processUrlCheckJob(payload, 1, deps);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    const rowBeforeFinalize = await getRow(payload.urlCheckId);
    await finalizeExhaustedRetries(payload, lastError, rowBeforeFinalize.processing_claim_token, pool, redis);

    const row = await getRow(payload.urlCheckId);
    expect(row.status).toBe('FAILED');
    expect(row.http_status).toBeNull(); // honest null -- no response was ever received
    expect(row.response_time_ms).toBe(7); // still recorded -- it's not an HTTP status
  });

  it('finalizeExhaustedRetries does not fire for a row already superseded by a newer generation', async () => {
    const payload = await seedBatchAndCheck();
    vi.spyOn(healthCheckModule, 'performHealthCheck').mockResolvedValue({
      outcome: 'success',
      httpStatus: 500,
      responseTimeMs: 9,
      pageTitle: null,
    });
    await processUrlCheckJob(payload, 1, deps).catch(() => {});

    // Row gets superseded (e.g. a retry-failed bumped it) before the old
    // job's exhaustion handler runs.
    await pool.query(`UPDATE url_checks SET run_generation = 1, status = 'QUEUED' WHERE id = $1`, [
      payload.urlCheckId,
    ]);

    const rowBeforeFinalize = await getRow(payload.urlCheckId);
    await finalizeExhaustedRetries(payload /* still generation 0 */, 'stale exhaustion', rowBeforeFinalize.processing_claim_token, pool, redis);

    const row = await getRow(payload.urlCheckId);
    // Must NOT have been overwritten back to FAILED by the stale generation-0 finalize.
    expect(row.status).toBe('QUEUED');
    expect(row.run_generation).toBe(1);
  });
});

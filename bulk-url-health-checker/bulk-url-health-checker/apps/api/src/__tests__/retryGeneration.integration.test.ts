/**
 * Integration tests against a REAL Postgres + Redis (see vitest.config.ts
 * for the connection strings; apps/api/src/db/migrate.ts must have been run
 * against that database first -- see README "Testing").
 *
 * These are deliberately not mocked: the whole point of run_generation is
 * to be correct under real concurrent Postgres transactions and real BullMQ
 * job-id collisions, neither of which a mock can meaningfully stand in for.
 * If Postgres/Redis aren't reachable, these fail loudly with a connection
 * error rather than silently passing -- that's intentional; a green run
 * here means the behavior was actually exercised.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool } from '../db/pool';
import { urlCheckQueue, jobIdFor } from '../lib/queue';
import {
  createBatch,
  retryFailedUrls,
  reconcileStuckUrlChecks,
  getBatchDetail,
} from '../services/batchService';

async function insertRawBatch(urls: string[]) {
  return createBatch(urls);
}

/** Marks every url_check row of a batch FAILED directly, bypassing the worker -- these tests are about the retry/reconciliation logic in batchService.ts, not the worker's HTTP behavior. */
async function markAllFailed(batchId: string) {
  await pool.query(
    `UPDATE url_checks SET status = 'FAILED', error = 'synthetic failure for test' WHERE batch_id = $1`,
    [batchId],
  );
}

async function markFirstFailed(batchId: string, n: number) {
  await pool.query(
    `UPDATE url_checks SET status = 'FAILED', error = 'synthetic failure for test'
     WHERE id IN (SELECT id FROM url_checks WHERE batch_id = $1 ORDER BY created_at ASC LIMIT $2)`,
    [batchId, n],
  );
}

async function markFirstSuccess(batchId: string, n: number) {
  await pool.query(
    `UPDATE url_checks SET status = 'SUCCESS', http_status = 200 WHERE id IN
     (SELECT id FROM url_checks WHERE batch_id = $1 ORDER BY created_at ASC LIMIT $2)`,
    [batchId, n],
  );
}

async function cleanDb() {
  await pool.query('TRUNCATE batches CASCADE');
}

beforeEach(async () => {
  await cleanDb();
});

afterAll(async () => {
  await pool.end();
  await urlCheckQueue.close();
});

describe('run_generation retry semantics (batchService.ts)', () => {
  it("Test A: retry creates a new generation and a new job id even if the old generation's BullMQ job is still retained", async () => {
    const batch = await insertRawBatch(['https://example.com/a']);
    const before = await getBatchDetail(batch.id);
    const check = before.urlChecks[0]!;
    expect(check.runGeneration).toBe(0);

    // Simulate: the original job for generation 0 ran and BullMQ is still
    // retaining its completed record (we don't need the worker to actually
    // run it -- just that a job exists under generation 0's job id).
    const gen0JobId = jobIdFor(check.id, 0);
    const existingGen0Job = await urlCheckQueue.getJob(gen0JobId);
    expect(existingGen0Job).toBeTruthy(); // createBatch already enqueued it

    await markAllFailed(batch.id);
    await retryFailedUrls(batch.id);

    const after = await getBatchDetail(batch.id);
    const afterCheck = after.urlChecks[0]!;
    expect(afterCheck.runGeneration).toBe(1);
    expect(afterCheck.status).toBe('QUEUED');

    // The retry must have created a genuinely NEW job id, distinct from the
    // retained generation-0 job -- this is exactly the case that silently
    // broke before run_generation existed (the old fix tried to .remove()
    // the old job and re-add under the SAME id, which is race-prone; this
    // design never needs to touch the old job at all).
    const gen1JobId = jobIdFor(afterCheck.id, 1);
    expect(gen1JobId).not.toBe(gen0JobId);
    const gen1Job = await urlCheckQueue.getJob(gen1JobId);
    expect(gen1Job).toBeTruthy();
    // The old generation's job is untouched/still present -- proving we
    // didn't need to race-remove it.
    expect(await urlCheckQueue.getJob(gen0JobId)).toBeTruthy();
  });

  it('Test B: two concurrent retry-failed calls produce exactly one generation increment and one logical retry job', async () => {
    const batch = await insertRawBatch(['https://example.com/b']);
    await markAllFailed(batch.id);

    // Fire both concurrently -- batchService serializes them internally via
    // `SELECT ... FOR UPDATE` on the batch row.
    const [r1, r2] = await Promise.all([retryFailedUrls(batch.id), retryFailedUrls(batch.id)]);
    expect(r1.status).toBe('RUNNING');
    expect(r2.status).toBe('RUNNING');

    const after = await getBatchDetail(batch.id);
    const check = after.urlChecks[0]!;
    // Exactly one increment, not two.
    expect(check.runGeneration).toBe(1);
    expect(check.status).toBe('QUEUED');

    // Exactly one logical job exists for the new generation; no generation-2
    // job was ever created by the "losing" concurrent call.
    expect(await urlCheckQueue.getJob(jobIdFor(check.id, 1))).toBeTruthy();
    expect(await urlCheckQueue.getJob(jobIdFor(check.id, 2))).toBeFalsy();
  });

  it('Test C: successful URLs are never included in a retry', async () => {
    const batch = await insertRawBatch([
      'https://example.com/c1',
      'https://example.com/c2',
      'https://example.com/c3',
    ]);
    await markFirstFailed(batch.id, 1);
    await markFirstSuccess(batch.id, 0); // no-op, keeps the other two QUEUED for this test
    // Mark the second one SUCCESS explicitly, third stays QUEUED.
    const detailBefore = await getBatchDetail(batch.id);
    const successId = detailBefore.urlChecks[1]!.id;
    await pool.query(`UPDATE url_checks SET status = 'SUCCESS', http_status = 200 WHERE id = $1`, [
      successId,
    ]);

    await retryFailedUrls(batch.id);

    const after = await getBatchDetail(batch.id);
    const successRow = after.urlChecks.find((c) => c.id === successId)!;
    expect(successRow.status).toBe('SUCCESS');
    expect(successRow.runGeneration).toBe(0); // untouched -- never retried
  });

  it('Test D: a stale old-generation claim cannot overwrite a newer generation (worker claim query, exercised directly)', async () => {
    const batch = await insertRawBatch(['https://example.com/d']);
    const before = await getBatchDetail(batch.id);
    const checkId = before.urlChecks[0]!.id;

    await markAllFailed(batch.id);
    await retryFailedUrls(batch.id); // bumps to generation 1, row is QUEUED

    // Simulate a stale generation-0 worker attempt trying to claim now that
    // the row has moved on to generation 1. This is the exact claim query
    // from processUrl.ts.
    const staleClaim = await pool.query(
      `UPDATE url_checks SET status = 'PROCESSING', attempt = $3
       WHERE id = $1 AND run_generation = $2 AND status IN ('QUEUED','PROCESSING') AND attempt < $3
       RETURNING id`,
      [checkId, 0 /* stale generation */, 1],
    );
    expect(staleClaim.rowCount).toBe(0); // must not claim

    const after = await getBatchDetail(batch.id);
    const afterCheck = after.urlChecks.find((c) => c.id === checkId)!;
    expect(afterCheck.status).toBe('QUEUED'); // untouched by the stale claim
    expect(afterCheck.runGeneration).toBe(1);

    // A legitimate generation-1 claim, by contrast, must succeed.
    const realClaim = await pool.query(
      `UPDATE url_checks SET status = 'PROCESSING', attempt = $3
       WHERE id = $1 AND run_generation = $2 AND status IN ('QUEUED','PROCESSING') AND attempt < $3
       RETURNING id`,
      [checkId, 1, 1],
    );
    expect(realClaim.rowCount).toBe(1);
  });

  it('Test E: retry works even when the retained completed job is still present under a different generation id (no collision)', async () => {
    const batch = await insertRawBatch(['https://example.com/e']);
    const before = await getBatchDetail(batch.id);
    const checkId = before.urlChecks[0]!.id;
    const gen0JobId = jobIdFor(checkId, 0);

    // Simulate the generation-0 job having actually completed and BullMQ
    // retaining it (this is the exact scenario that silently broke before
    // run_generation existed).
    await pool.query(`UPDATE url_checks SET status = 'FAILED', error = 'x' WHERE id = $1`, [checkId]);

    await retryFailedUrls(batch.id);
    // Retry a SECOND time to prove this isn't a one-shot fix.
    await pool.query(`UPDATE url_checks SET status = 'FAILED', error = 'x' WHERE id = $1`, [checkId]);
    await retryFailedUrls(batch.id);

    const after = await getBatchDetail(batch.id);
    const afterCheck = after.urlChecks[0]!;
    expect(afterCheck.runGeneration).toBe(2);
    expect(afterCheck.status).toBe('QUEUED');
    expect(await urlCheckQueue.getJob(jobIdFor(checkId, 2))).toBeTruthy();
    expect(await urlCheckQueue.getJob(gen0JobId)).toBeTruthy(); // still there, never needed removal
  });

  it('retry-failed on a batch with zero FAILED rows does not change status or generation (idempotent no-op)', async () => {
    const batch = await insertRawBatch(['https://example.com/f']);
    await markFirstSuccess(batch.id, 1);
    // recompute batch status manually the way the worker would (this test
    // exercises batchService, not the worker's aggregate recompute).
    await pool.query(
      `UPDATE batches SET status = 'COMPLETED', completed_urls = 1, successful_urls = 1 WHERE id = $1`,
      [batch.id],
    );

    const result = await retryFailedUrls(batch.id);
    expect(result.status).toBe('COMPLETED'); // must NOT flip back to RUNNING

    const after = await getBatchDetail(batch.id);
    expect(after.urlChecks[0]!.runGeneration).toBe(0);
  });
});

describe('reconcileStuckUrlChecks (queue reconciliation)', () => {
  it('Test A: enqueues a job for a QUEUED row with no live BullMQ job', async () => {
    const batch = await insertRawBatch(['https://example.com/recon-a']);
    const before = await getBatchDetail(batch.id);
    const checkId = before.urlChecks[0]!.id;
    const jobId = jobIdFor(checkId, 0);

    // Simulate the enqueue having failed after the DB commit: remove the
    // job that createBatch just added, but leave the row QUEUED (exactly
    // the gap the assignment describes).
    await urlCheckQueue.remove(jobId);
    expect(await urlCheckQueue.getJob(jobId)).toBeFalsy();

    // staleAfterMs=0 so this genuinely-fresh row is still eligible for this
    // assertion -- the separate look-back-window behavior (a *fresh* row is
    // left alone under the real default) is covered by Test D below; the
    // `updated_at` trigger on this table makes artificially backdating a row
    // in a test unreliable, so we vary the threshold instead of the data.
    const result = await reconcileStuckUrlChecks(0);
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(await urlCheckQueue.getJob(jobId)).toBeTruthy();
  });

  it('Test B: partial enqueue failure -- only the missing jobs are recreated, not the ones that already exist', async () => {
    const batch = await insertRawBatch([
      'https://example.com/recon-b1',
      'https://example.com/recon-b2',
      'https://example.com/recon-b3',
    ]);
    const detail = await getBatchDetail(batch.id);
    const [c1, c2, c3] = detail.urlChecks;

    // Simulate jobs 2 and 3 failing to enqueue, job 1 succeeded.
    await urlCheckQueue.remove(jobIdFor(c2!.id, 0));
    await urlCheckQueue.remove(jobIdFor(c3!.id, 0));

    const result = await reconcileStuckUrlChecks(0);
    expect(result.enqueued).toBe(2);
    expect(await urlCheckQueue.getJob(jobIdFor(c1!.id, 0))).toBeTruthy();
    expect(await urlCheckQueue.getJob(jobIdFor(c2!.id, 0))).toBeTruthy();
    expect(await urlCheckQueue.getJob(jobIdFor(c3!.id, 0))).toBeTruthy();
  });

  it('Test C: running reconciliation twice does not create duplicate logical work', async () => {
    const batch = await insertRawBatch(['https://example.com/recon-c']);
    const before = await getBatchDetail(batch.id);
    const checkId = before.urlChecks[0]!.id;
    await urlCheckQueue.remove(jobIdFor(checkId, 0));

    const first = await reconcileStuckUrlChecks(0);
    expect(first.enqueued).toBe(1);
    const second = await reconcileStuckUrlChecks(0);
    expect(second.enqueued).toBe(0); // job now exists; nothing missing anymore
  });

  it('Test D: a fresh (recently updated) QUEUED row is left alone -- avoids racing the original enqueue', async () => {
    const batch = await insertRawBatch(['https://example.com/recon-d']);
    const before = await getBatchDetail(batch.id);
    const checkId = before.urlChecks[0]!.id;
    // Row is fresh (just inserted); its own job is legitimately still there
    // too, so this also implicitly proves reconciliation doesn't touch rows
    // that already have a job -- but the key assertion is the age gate.
    const result = await reconcileStuckUrlChecks(15000);
    expect(result.scanned).toBe(0);
    // Sanity: the check row and its original job are both still intact.
    expect(await urlCheckQueue.getJob(jobIdFor(checkId, 0))).toBeTruthy();
  });

  it('Test E: a SUCCESS row is never re-enqueued by reconciliation', async () => {
    const batch = await insertRawBatch(['https://example.com/recon-e']);
    const before = await getBatchDetail(batch.id);
    const checkId = before.urlChecks[0]!.id;
    await pool.query(`UPDATE url_checks SET status = 'SUCCESS', http_status = 200 WHERE id = $1`, [checkId]);
    const result = await reconcileStuckUrlChecks(0);
    expect(result.scanned).toBe(0); // SUCCESS rows are never even selected
  });
});

import { Queue } from 'bullmq';
import type { UrlCheckJobData } from '@bulk-url/shared';
import { createRedisConnection } from './redis';

export const URL_CHECK_QUEUE_NAME = 'url-check';


export const urlCheckQueue = new Queue<UrlCheckJobData>(URL_CHECK_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    // "Up to 3 retries on transient failure" means 3 retries *in addition to*
    // the initial attempt -- 4 total attempts (initial + retry 1 + retry 2 +
    // retry 3). This must stay in sync with url_checks.max_attempts'
    // DEFAULT (see migrations/002_retry_generation.sql) and with the
    // worker's own accounting -- both are just display/audit copies of this
    // value, which is the one that's actually enforced.
    attempts: 4,
    backoff: { type: 'exponential', delay: 2000 }, // 2s, 4s, 8s between attempts
    removeOnComplete: { age: 3600, count: 5000 }, // keep queue lean; DB is authoritative, not this
    removeOnFail: { age: 86400, count: 5000 },
  },
});

/**
 * Job id = `url-check-{urlCheckId}-run-{runGeneration}`.
 *
 * The url_checks row owns an explicit, monotonically increasing
 * `run_generation` (see migrations/002_retry_generation.sql). Each row's
 * *first* submission is generation 0; each subsequent legitimate
 * "retry failed" call for that row bumps the generation exactly once
 * (batchService.ts does this atomically in the same UPDATE that resets the
 * row to QUEUED, so the row's run_generation and the job id derived from it
 * are always in lockstep).
 *
 * This gives us both properties the assignment asks for at once:
 *  - Duplicate-enqueue protection *within* a generation: two concurrent
 *    callers racing to enqueue the SAME generation (e.g. a retried API
 *    request, or a reconciliation pass racing the original enqueue) collide
 *    on the same job id, and BullMQ's own de-dup on a not-yet-finished job
 *    with that id makes the second call a safe no-op.
 *  - A *legitimate* new retry always gets a brand-new, never-before-used job
 *    id (the generation changed), so it is never blocked by BullMQ still
 *    retaining the previous generation's completed job -- no job removal or
 *    other race-prone patching required.
 */
export function jobIdFor(urlCheckId: string, runGeneration: number): string {
  return `url-check-${urlCheckId}-run-${runGeneration}`;
}

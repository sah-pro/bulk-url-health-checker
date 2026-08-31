import { Worker, Job } from 'bullmq';
import pino from 'pino';
import { pool } from './db';
import { redis, createRedisConnection } from './redis';
import { GlobalRateLimiter } from './rateLimiter';
import { GlobalConcurrencyLimiter } from './concurrencyLimiter';
import { processUrlCheckJob, finalizeExhaustedRetries, UrlCheckJobPayload } from './processUrl';
import { env } from './config';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const rateLimiter = new GlobalRateLimiter(redis);
const concurrencyLimiter = new GlobalConcurrencyLimiter(redis);

/**
 * BullMQ's own `concurrency` here is a *per-process* ceiling, set equal to
 * the global target (5). It exists so a single worker process cannot itself
 * try to pull more than 5 jobs off the queue at once and pile up waiting on
 * the global concurrency limiter; the GlobalConcurrencyLimiter inside
 * processUrlCheckJob is what actually enforces correctness across N
 * processes. With one worker process these two limits coincide; with
 * multiple, the global limiter is what prevents 5*N simultaneous requests.
 */
const worker = new Worker<UrlCheckJobPayload>(
  'url-check',
  async (job: Job<UrlCheckJobPayload>) => {
    logger.info(
      {
        jobId: job.id,
        batchId: job.data.batchId,
        urlCheckId: job.data.urlCheckId,
        attempt: job.attemptsMade + 1,
      },
      'processing url check',
    );
    try {
      await processUrlCheckJob(job.data, job.attemptsMade + 1, {
        pool,
        redis,
        rateLimiter,
        concurrencyLimiter,
      });
    } catch (err) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isLastAttempt) {
        const message = err instanceof Error ? err.message : String(err);
        const claimToken = err instanceof Error && 'claimToken' in err
          ? String((err as Error & { claimToken?: unknown }).claimToken)
          : null;
        logger.warn(
          { jobId: job.id, urlCheckId: job.data.urlCheckId, error: message },
          'exhausted retries, marking FAILED',
        );
        if (claimToken) {
          await finalizeExhaustedRetries(job.data, message, claimToken, pool, redis);
          return;
        }
        throw err;
      }
      throw err; // let BullMQ apply exponential backoff and retry
    }
  },
  {
    connection: createRedisConnection(),
    concurrency: env.GLOBAL_MAX_IN_FLIGHT,
  },
);

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err.message }, 'job failed');
});

worker.on('error', (err) => {
  logger.error({ error: err.message }, 'worker error');
});

logger.info(
  { rateLimitPerSec: env.GLOBAL_RATE_LIMIT_PER_SEC, maxInFlight: env.GLOBAL_MAX_IN_FLIGHT },
  'worker started',
);

async function shutdown() {
  logger.info('shutting down worker...');
  await worker.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

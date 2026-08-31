import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { env } from './config';
import { batchRoutes } from './routes/batches';
import { eventRoutes } from './routes/events';
import { pool } from './db/pool';
import { redis } from './lib/redis';
import { reconcileStuckUrlChecks } from './services/batchService';

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1024 * 1024, // 1MB for JSON bodies; CSV uploads go through multipart with their own limit
  });

  await app.register(cors, { origin: env.CORS_ORIGIN });
  await app.register(multipart, { limits: { fileSize: env.MAX_CSV_SIZE_BYTES, files: 1 } });

  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      return reply.send({ status: 'ok' });
    } catch (err) {
      app.log.error(err, 'health check failed');
      return reply.status(503).send({ status: 'unhealthy' });
    }
  });

  await app.register(batchRoutes);
  await app.register(eventRoutes);

  // Consistent error envelope; never leak stack traces to clients.
  app.setErrorHandler((error: import('fastify').FastifyError, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    reply.status(statusCode).send({
      error: {
        code: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: statusCode === 500 ? 'An unexpected error occurred.' : error.message,
      },
    });
  });

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  app.log.info(`API listening on :${env.API_PORT}`);

  // Queue reconciliation: recovers url_checks rows that are durably QUEUED
  // in Postgres but ended up with no corresponding BullMQ job (the
  // COMMIT-succeeded-but-enqueue-failed gap). Safe to run on every API
  // instance concurrently -- see reconcileStuckUrlChecks' doc comment for
  // why it can't create duplicates. Runs independently of any single
  // request/response cycle, which is why it lives here rather than in a
  // route handler.
  const reconcileIntervalMs = 10_000;
  const reconcileTimer = setInterval(() => {
    reconcileStuckUrlChecks().then(
      ({ scanned, enqueued }) => {
        if (enqueued > 0) {
          app.log.warn({ scanned, enqueued }, 'reconciliation enqueued missing url-check jobs');
        }
      },
      (err) => app.log.error(err, 'queue reconciliation pass failed'),
    );
  }, reconcileIntervalMs);
  reconcileTimer.unref(); // don't keep the process alive on this timer alone

  const shutdown = async () => {
    app.log.info('shutting down...');
    clearInterval(reconcileTimer);
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { FastifyInstance } from 'fastify';
import { batchIdParamSchema } from '@bulk-url/shared';
import type { BatchEvent } from '@bulk-url/shared';
import { createRedisConnection } from '../lib/redis';
import { getBatchDetail, NotFoundError } from '../services/batchService';

/**
 * Live updates via Server-Sent Events, fanned out through Redis pub/sub.
 *
 * Why SSE over WebSockets: updates only flow server -> client (the client
 * never needs to push anything over this channel -- controls are plain REST
 * POSTs), SSE reconnects automatically in the browser, and it works over
 * plain HTTP/1.1 through any proxy without special upgrade handling. A
 * websocket would be justified if the client needed to send frequent
 * messages back over the same channel, which it doesn't here.
 *
 * Why Redis pub/sub, not process memory: any of N API instances may hold the
 * SSE connection for a given browser tab, but the worker process that
 * completes a check has no idea which instance that is. The worker publishes
 * to a Redis channel keyed by batch id; every API instance subscribes to
 * channels for the batch ids it currently has open SSE connections for, so
 * the event reaches the right browser regardless of which instance is
 * holding that connection.
 *
 * Missed-event recovery, and the init-order race: if the connection drops
 * (network blip, tab closed/reopened, tab was asleep), any events published
 * while disconnected are simply lost -- Redis pub/sub does not buffer for
 * absent subscribers. The fix for that is "always send a fresh Postgres
 * snapshot on (re)connect" -- but naively doing "read Postgres, then
 * subscribe" leaves a real gap: an update can land in the window between
 * the snapshot read and the subscription becoming active, and would be
 * missed entirely (neither captured by the snapshot, which was read before
 * it happened, nor by the subscription, which wasn't listening yet).
 *
 * So the order here is subscribe-*then*-snapshot, with buffering in
 * between:
 *   1. Subscribe to the batch's Redis channel FIRST and start buffering
 *      (not sending) any messages that arrive from this point on.
 *   2. THEN read the authoritative Postgres snapshot. Nothing published
 *      from step 1 onward can be missed now -- it's either already
 *      reflected in this snapshot (if its commit happened before this SELECT
 *      started) or it's sitting in the buffer (if not).
 *   3. Send the snapshot.
 *   4. Flush the buffer (in arrival order) and switch to sending live
 *      messages directly from then on.
 *
 * Step 4 running strictly after step 3, as one synchronous block, is what
 * makes this safe rather than just "probably fine": JS's single-threaded
 * event loop guarantees no message handler can interleave between "send the
 * snapshot" and "start flushing the buffer", so the client can never
 * observe a buffered (guaranteed-fresh, published-after-we-subscribed)
 * event followed by an older snapshot overwriting it. The snapshot may
 * occasionally be stale by a few milliseconds relative to a buffered event
 * (Postgres READ COMMITTED takes its snapshot at statement start, so a
 * commit landing mid-SELECT won't be visible to it) -- but since that event
 * is always replayed from the buffer immediately afterward, the client's
 * view can only move forward, never regress.
 */
export async function eventRoutes(app: FastifyInstance) {
  app.get('/api/batches/:id/events', async (request, reply) => {
    const parseResult = batchIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid batch id.' } });
    }
    const { id } = parseResult.data;

    // Fail fast on a nonexistent batch before doing any streaming setup.
    try {
      await getBatchDetail(id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      throw err;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: BatchEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // --- Step 1: subscribe and buffer, before reading anything from Postgres ---
    let initializing = true;
    const buffered: BatchEvent[] = [];

    const subscriber = createRedisConnection();
    subscriber.on('message', (_channel, message) => {
      let event: BatchEvent;
      try {
        event = JSON.parse(message) as BatchEvent;
      } catch {
        return; // ignore malformed pub/sub payloads
      }
      if (initializing) {
        buffered.push(event);
      } else {
        send(event);
      }
    });
    await subscriber.subscribe(`batch:${id}`);

    // --- Step 2: now it's safe to read the authoritative snapshot ---
    const snapshot = await getBatchDetail(id).catch(() => null);

    // --- Steps 3 + 4: send snapshot, then flush the buffer, synchronously ---
    if (snapshot) {
      send({ type: 'batch-updated', batch: snapshot });
    }
    initializing = false;
    while (buffered.length > 0) {
      send(buffered.shift()!);
    }

    const heartbeat = setInterval(() => send({ type: 'heartbeat', ts: new Date().toISOString() }), 15000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      subscriber.unsubscribe().catch(() => {});
      subscriber.quit().catch(() => {});
    });
  });
}

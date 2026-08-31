/**
 * Integration test against a REAL Fastify server, real Postgres, and real
 * Redis pub/sub, for the exact race described in the SSE fix: an update can
 * be published to Redis while the snapshot is being read from Postgres.
 *
 * The old implementation read Postgres, THEN subscribed -- an event
 * published in between was lost entirely (too late for the snapshot, too
 * early for the subscription). The fix subscribes first and buffers, then
 * reads the snapshot, then flushes the buffer. This test forces exactly
 * that window open (by delaying the snapshot read with a spy) and asserts
 * the client still receives the event -- proving the fix, not just its
 * absence of an error.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { BatchEvent } from '@bulk-url/shared';
import { pool } from '../db/pool';
import { redis } from '../lib/redis';
import { eventRoutes } from '../routes/events';
import * as batchService from '../services/batchService';
import * as redisLib from '../lib/redis';

async function seedBatch(): Promise<string> {
  const res = await pool.query(`INSERT INTO batches (status, total_urls) VALUES ('RUNNING', 1) RETURNING id`);
  const batchId = res.rows[0].id;
  await pool.query(
    `INSERT INTO url_checks (batch_id, url, normalized_url, status) VALUES ($1, 'https://sse-test.example', 'https://sse-test.example', 'QUEUED')`,
    [batchId],
  );
  return batchId;
}

async function cleanDb() {
  await pool.query('TRUNCATE batches CASCADE');
}

let app: FastifyInstance;
let baseUrl: string;

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
  app = Fastify();
  await app.register(eventRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('unexpected server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

/** Connects to the SSE endpoint and resolves once `count` `data:` messages have been parsed. */
function collectEvents(url: string, count: number): Promise<BatchEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BatchEvent[] = [];
    const req = http.get(url, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (raw.startsWith('data: ')) {
            try {
              events.push(JSON.parse(raw.slice(6)) as BatchEvent);
            } catch {
              // ignore
            }
          }
          if (events.length >= count) {
            req.destroy();
            resolve(events);
            return;
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', (err) => {
      // Destroying the request once we have enough events triggers this;
      // only treat it as a real failure if we didn't get what we needed.
      if (events.length < count) reject(err);
    });
    setTimeout(() => {
      if (events.length < count) {
        req.destroy();
        reject(new Error(`Timed out waiting for ${count} SSE events, got ${events.length}`));
      }
    }, 5000);
  });
}

describe('SSE subscribe-before-snapshot race', () => {
  it('structurally subscribes to Redis before reading the authoritative snapshot (not just "probably fine" timing)', async () => {
    // This is the deterministic version of the fix's guarantee: rather than
    // racing a real network timing window (which can pass "by luck" even
    // against a broken implementation if the window happens to be too
    // narrow to hit), assert the actual ORDER of operations directly. The
    // route must call subscribe() before it starts the snapshot read that
    // will be sent as the first message -- doing it the other way around
    // (snapshot, then subscribe) is exactly the bug this proves is fixed.
    const batchId = await seedBatch();
    const order: string[] = [];

    const realGetBatchDetail = batchService.getBatchDetail;
    let getBatchDetailCalls = 0;
    vi.spyOn(batchService, 'getBatchDetail').mockImplementation(async (id: string) => {
      getBatchDetailCalls += 1;
      // Only the call made AFTER the route has started streaming is "the
      // snapshot" in the sense that matters here -- the very first call is
      // an existence check the route makes before it does anything else,
      // and recording it too would trivially satisfy "subscribe happened
      // before the LAST getBatchDetail call" without proving anything about
      // subscribe-vs-snapshot ordering specifically. Record every call;
      // the assertion below checks against the call that returns the data
      // actually sent as the SSE snapshot message.
      order.push(`getBatchDetail#${getBatchDetailCalls}`);
      return realGetBatchDetail(id);
    });

    const realCreateRedisConnection = redisLib.createRedisConnection;
    vi.spyOn(redisLib, 'createRedisConnection').mockImplementation(() => {
      const client = realCreateRedisConnection();
      const realSubscribe = client.subscribe.bind(client);
      client.subscribe = ((...args: Parameters<typeof realSubscribe>) => {
        order.push('subscribe');
        return realSubscribe(...args);
      }) as typeof client.subscribe;
      return client;
    });

    await collectEvents(`${baseUrl}/api/batches/${batchId}/events`, 1);

    // The route makes an existence-check getBatchDetail call, then must
    // subscribe, THEN make the real snapshot getBatchDetail call -- in that
    // order. Find where 'subscribe' sits relative to the getBatchDetail
    // calls: it must come after the first (existence check) and before the
    // second (snapshot) -- never after both, which is what the old
    // read-then-subscribe implementation would produce.
    const subscribeIndex = order.indexOf('subscribe');
    const secondSnapshotIndex = order.indexOf('getBatchDetail#2');
    expect(subscribeIndex).toBeGreaterThan(-1);
    expect(secondSnapshotIndex).toBeGreaterThan(-1);
    expect(subscribeIndex).toBeLessThan(secondSnapshotIndex);
  });

  it('an event published to Redis WHILE the Postgres snapshot is being read is not lost', async () => {
    const batchId = await seedBatch();

    // Delay only the SECOND call to getBatchDetail (the actual snapshot
    // read inside the route, after the existence-check call and after
    // subscribing) -- this is what forces the race window open long enough
    // to publish into it deterministically instead of hoping for a lucky
    // timing.
    const real = batchService.getBatchDetail;
    let callCount = 0;
    vi.spyOn(batchService, 'getBatchDetail').mockImplementation(async (id: string) => {
      callCount += 1;
      if (callCount === 2) {
        await new Promise((r) => setTimeout(r, 300));
      }
      return real(id);
    });

    const collectPromise = collectEvents(`${baseUrl}/api/batches/${batchId}/events`, 2);

    // Give the client a moment to connect and the route to reach the
    // subscribe step (well before the 300ms delayed snapshot resolves).
    await new Promise((r) => setTimeout(r, 100));

    // Publish directly to Redis, simulating a worker completing a check
    // WHILE the snapshot read is still in flight -- exactly the race.
    const liveEvent: BatchEvent = {
      type: 'batch-updated',
      batch: {
        id: batchId,
        status: 'COMPLETED',
        totalUrls: 1,
        completedUrls: 1,
        successfulUrls: 1,
        failedUrls: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cancelledAt: null,
      },
    };
    await redis.publish(`batch:${batchId}`, JSON.stringify(liveEvent));

    const received = await collectPromise;

    // Both the (stale, RUNNING) snapshot and the (fresh, COMPLETED) live
    // event must have arrived -- the live event proves nothing was lost;
    // the snapshot arriving first proves the ordering guarantee holds.
    expect(received).toHaveLength(2);
    expect(received[0]!.type).toBe('batch-updated');
    if (received[0]!.type === 'batch-updated') {
      expect(received[0]!.batch.status).toBe('RUNNING'); // the stale snapshot, sent first
    }
    expect(received[1]!.type).toBe('batch-updated');
    if (received[1]!.type === 'batch-updated') {
      expect(received[1]!.batch.status).toBe('COMPLETED'); // the buffered live event, flushed after
    }
  });

  it('normal connection with no concurrent update still gets exactly the current snapshot first', async () => {
    const batchId = await seedBatch();
    const [first] = await collectEvents(`${baseUrl}/api/batches/${batchId}/events`, 1);
    expect(first!.type).toBe('batch-updated');
    if (first!.type === 'batch-updated') {
      expect(first!.batch.id).toBe(batchId);
      expect(first!.batch.status).toBe('RUNNING');
    }
  });

  it('a live event AFTER the snapshot has already been sent is delivered normally (not buffered/delayed)', async () => {
    const batchId = await seedBatch();
    const collectPromise = collectEvents(`${baseUrl}/api/batches/${batchId}/events`, 2);
    // Let the snapshot definitely land first.
    await new Promise((r) => setTimeout(r, 150));
    await redis.publish(
      `batch:${batchId}`,
      JSON.stringify({
        type: 'batch-updated',
        batch: {
          id: batchId,
          status: 'COMPLETED',
          totalUrls: 1,
          completedUrls: 1,
          successfulUrls: 1,
          failedUrls: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cancelledAt: null,
        },
      } satisfies BatchEvent),
    );
    const received = await collectPromise;
    expect(received).toHaveLength(2);
  });
});

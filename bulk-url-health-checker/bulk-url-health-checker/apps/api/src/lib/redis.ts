import IORedis from 'ioredis';
import { env } from '../config';

// BullMQ requires maxRetriesPerRequest: null on connections it manages.
export function createRedisConnection() {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const redis = createRedisConnection();

redis.on('error', (err) => {
  // Redis is used for caching, pub/sub, and queueing -- not as the source of
  // truth for business state. A transient disconnect should be logged, not fatal.
  console.error('Redis connection error', err);
});

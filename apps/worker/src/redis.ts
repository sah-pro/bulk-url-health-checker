import IORedis from 'ioredis';
import { env } from './config';

export function createRedisConnection() {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const redis = createRedisConnection();
redis.on('error', (err) => {
  console.error('Redis connection error in worker', err);
});

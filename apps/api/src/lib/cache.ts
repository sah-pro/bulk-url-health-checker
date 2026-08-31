import { redis } from './redis';
import { env } from '../config';

/**
 * Cache for GET /api/batches.
 *
 * A flat TTL alone would let stale data survive up to 30s after a batch is
 * created or changes state, which the assignment explicitly forbids ("cached
 * data must not go stale in a user-visible way"). So every write path that
 * changes what the list response would contain (create batch, any status
 * change, progress update) calls invalidateBatchListCache() to DEL the key
 * immediately, in addition to the 30s TTL acting as a backstop expiry.
 *
 * The cache lives in Redis (not process memory) so it is correct and shared
 * across any number of API instances -- one instance invalidating it is
 * immediately visible to all others.
 */
const LIST_CACHE_KEY = 'cache:batches:list';

export async function getCachedBatchList(): Promise<string | null> {
  return redis.get(LIST_CACHE_KEY);
}

export async function setCachedBatchList(json: string): Promise<void> {
  await redis.set(LIST_CACHE_KEY, json, 'EX', env.BATCH_LIST_CACHE_TTL_SECONDS);
}

export async function invalidateBatchListCache(): Promise<void> {
  await redis.del(LIST_CACHE_KEY);
}

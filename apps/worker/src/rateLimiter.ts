import { Redis } from 'ioredis';
import { env } from './config';

/**
 * Global, cross-process rate limiter: at most GLOBAL_RATE_LIMIT_PER_SEC (10)
 * outbound health-check requests start per second, no matter how many worker
 * processes are running.
 *
 * Implementation: a token bucket stored entirely in Redis, refilled and
 * drained by a single Lua script (EVAL), which Redis executes atomically.
 * That atomicity is the whole point -- it's what makes this safe under N
 * concurrent workers hitting it at once. Two workers calling this at the same
 * instant cannot both be handed the same token: Redis processes Lua scripts
 * one at a time, so "read current tokens, refill for elapsed time, decide,
 * write back" happens as one indivisible step. An in-memory counter inside a
 * single worker process cannot provide this guarantee across processes,
 * which is why the assignment explicitly rules that out.
 *
 * Bucket capacity == the per-second rate (10), refill rate == 10 tokens/sec,
 * computed continuously from elapsed wall-clock time (not a fixed 1-second
 * window), so there's no thundering-herd re-approval every time a window
 * boundary ticks over. A cold-started bucket can burst up to 10 requests
 * immediately (capacity == rate), then settles into a steady 10/sec -- this
 * is the standard, intentional behavior of a token bucket and is documented
 * here rather than hidden.
 *
 * Worker restart: the bucket lives in Redis, not the worker process, so a
 * restarted worker does not get a "fresh" bucket or reset the shared limit --
 * it just resumes drawing from the same shared state everyone else uses.
 */
export class GlobalRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly key = 'ratelimit:url-check',
    private readonly ratePerSec = env.GLOBAL_RATE_LIMIT_PER_SEC,
  ) {}

  private static readonly LUA_SCRIPT = `
    local key = KEYS[1]
    local rate = tonumber(ARGV[1])
    local capacity = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local bucket = redis.call('HMGET', key, 'tokens', 'ts')
    local tokens = tonumber(bucket[1])
    local ts = tonumber(bucket[2])

    if tokens == nil then
      tokens = capacity
      ts = now
    end

    local elapsed = math.max(0, now - ts)
    tokens = math.min(capacity, tokens + elapsed * rate)

    local allowed = 0
    if tokens >= 1 then
      tokens = tokens - 1
      allowed = 1
    end

    redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
    redis.call('EXPIRE', key, 60)

    return allowed
  `;

  /** Attempts to acquire one token. Returns true if allowed to proceed right now. */
  private async tryAcquire(): Promise<boolean> {
    const now = Date.now() / 1000;
    const result = await this.redis.eval(
      GlobalRateLimiter.LUA_SCRIPT,
      1,
      this.key,
      this.ratePerSec,
      this.ratePerSec,
      now,
    );
    return result === 1;
  }

  /** Blocks (via short polling sleeps) until a token is available, then consumes it. */
  async acquire(): Promise<void> {
    // Poll interval is short relative to the 1/rate spacing between tokens so
    // we don't waste much time waiting once a token is actually free.
    const pollMs = Math.max(10, Math.floor(1000 / this.ratePerSec / 4));
    while (!(await this.tryAcquire())) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

import { cleanEnv, str, num } from 'envalid';

export const env = cleanEnv(process.env, {
  DATABASE_URL: str(),
  REDIS_URL: str(),
  GLOBAL_RATE_LIMIT_PER_SEC: num({ default: 10 }),
  GLOBAL_MAX_IN_FLIGHT: num({ default: 5 }),
  REQUEST_TIMEOUT_MS: num({ default: 8000 }),
  MAX_RESPONSE_BYTES: num({ default: 2 * 1024 * 1024 }), // 2MB cap on body read for title extraction
  IN_FLIGHT_LEASE_MS: num({ default: 20000 }), // stale-slot sweep threshold, see concurrencyLimiter.ts
});

if (env.IN_FLIGHT_LEASE_MS < env.REQUEST_TIMEOUT_MS + 5000) {
  throw new Error('IN_FLIGHT_LEASE_MS must be at least REQUEST_TIMEOUT_MS + 5000ms.');
}

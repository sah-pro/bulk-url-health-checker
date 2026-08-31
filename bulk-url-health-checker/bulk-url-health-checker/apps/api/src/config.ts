import { cleanEnv, str, port, num } from 'envalid';

/**
 * Environment is validated once at process startup. If anything required is
 * missing or malformed, the process exits immediately with a clear message
 * rather than failing confusingly later at first use.
 */
export const env = cleanEnv(process.env, {
  DATABASE_URL: str(),
  REDIS_URL: str(),
  API_PORT: port({ default: 4000 }),
  CORS_ORIGIN: str({ default: 'http://localhost:3000' }),
  BATCH_LIST_CACHE_TTL_SECONDS: num({ default: 30 }),
  MAX_URLS_PER_BATCH: num({ default: 2000 }),
  MAX_CSV_SIZE_BYTES: num({ default: 5 * 1024 * 1024 }),
});

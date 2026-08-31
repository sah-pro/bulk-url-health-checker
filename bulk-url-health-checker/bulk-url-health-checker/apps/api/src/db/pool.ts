import { Pool } from 'pg';
import { env } from '../config';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  // A background/idle client emitted an error (e.g. connection dropped).
  // Log it; pg will recycle the connection. We do not crash the process --
  // in-flight requests using other connections should continue to work.
  console.error('Unexpected PG pool error', err);
});

/** Runs `fn` inside a transaction, committing on success and rolling back on any thrown error. */
export async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

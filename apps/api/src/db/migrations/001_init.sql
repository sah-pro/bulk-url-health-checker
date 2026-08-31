-- Bulk URL Health Checker: initial schema.
-- PostgreSQL is the sole source of truth for all business state. Redis/BullMQ
-- are transport and coordination layers only -- nothing important lives there
-- that isn't also (or first) durably written here.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TYPE batch_status AS ENUM (
  'PENDING',            -- created, jobs not yet all enqueued/confirmed
  'RUNNING',            -- at least one check has started
  'COMPLETED',          -- all checks terminal, zero failures
  'PARTIALLY_FAILED',   -- all checks terminal, some failures, some successes
  'FAILED',             -- all checks terminal, zero successes
  'CANCELLED'           -- user cancelled; queued jobs will not run
);

CREATE TYPE url_check_status AS ENUM (
  'QUEUED',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status batch_status NOT NULL DEFAULT 'PENDING',
  total_urls INTEGER NOT NULL DEFAULT 0 CHECK (total_urls >= 0),
  completed_urls INTEGER NOT NULL DEFAULT 0 CHECK (completed_urls >= 0),
  successful_urls INTEGER NOT NULL DEFAULT 0 CHECK (successful_urls >= 0),
  failed_urls INTEGER NOT NULL DEFAULT 0 CHECK (failed_urls >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CHECK (completed_urls <= total_urls),
  CHECK (successful_urls + failed_urls <= completed_urls)
);

-- URLs are normalized into their own table (not columns on batches) because:
--  1. A batch has a variable, potentially large number of URLs (up to 2000) --
--     denormalizing into an array or JSON column would prevent per-row indexed
--     status updates and per-row locking.
--  2. Retry-failed and live progress both need to query/update individual
--     check rows independently and efficiently (indexed by batch_id + status).
--  3. Each check has its own job id, attempt count, and result fields that
--     don't fit cleanly into an array-of-batch-scalars model.
CREATE TABLE url_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  url TEXT NOT NULL,                -- as submitted by the user
  normalized_url TEXT NOT NULL,     -- canonicalized; used for dedup + the actual request
  status url_check_status NOT NULL DEFAULT 'QUEUED',
  http_status INTEGER,
  response_time_ms INTEGER CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
  page_title TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, normalized_url)
);

CREATE INDEX idx_url_checks_batch_id ON url_checks(batch_id);
CREATE INDEX idx_url_checks_batch_status ON url_checks(batch_id, status);
CREATE INDEX idx_batches_created_at ON batches(created_at DESC);

-- Keep updated_at accurate without relying on every call site to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_batches_updated_at BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_url_checks_updated_at BEFORE UPDATE ON url_checks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

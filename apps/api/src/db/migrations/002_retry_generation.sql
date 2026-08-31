-- Adds a database-owned retry/run generation to url_checks.
--
-- Why: BullMQ job ids were previously stable per url_checks row
-- (`url-check-{id}`), which made a *duplicate* enqueue of an in-flight job a
-- safe no-op (good) but also made a *legitimate* re-enqueue on retry a no-op
-- once the original job had completed and BullMQ was still retaining it
-- (bad -- the retry silently did nothing). Rather than removing the old
-- completed job before re-adding (a race-prone patch), the row now owns an
-- explicit, monotonically increasing generation number. Each logical retry
-- bumps it exactly once; the BullMQ job id for a check is always
-- `url-check-{id}-run-{run_generation}`, so a legitimate retry always gets a
-- brand-new, never-before-used job id, while duplicate/concurrent retry
-- requests -- serialized by the existing `SELECT ... FOR UPDATE` lock on the
-- batches row in batchService.ts -- only ever see FAILED rows once and only
-- bump the generation once.
--
-- The worker's claim step also checks run_generation, so a stale delivery of
-- an old-generation job can never process (and overwrite) a row that has
-- already moved on to a newer generation.

ALTER TABLE url_checks
  ADD COLUMN run_generation INTEGER NOT NULL DEFAULT 0 CHECK (run_generation >= 0);

-- The assignment's "up to 3 retries on transient failure" means 3 retries
-- *in addition to* the initial attempt, i.e. 4 total attempts. The previous
-- default of 3 only allowed 2 retries. This changes the default for new
-- rows; BullMQ's own `attempts: 4` (apps/api/src/lib/queue.ts) is the
-- authoritative enforcement, this column just keeps the persisted value
-- consistent with it for display/auditing.
ALTER TABLE url_checks ALTER COLUMN max_attempts SET DEFAULT 4;

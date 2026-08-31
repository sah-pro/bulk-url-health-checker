-- BullMQ job identity is derived from (url_check_id, run_generation).
-- The old job_id column was not authoritative and was never required by the queue.
ALTER TABLE url_checks DROP COLUMN job_id;

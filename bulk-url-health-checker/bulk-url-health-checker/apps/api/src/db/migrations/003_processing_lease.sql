-- Execution ownership for safe BullMQ duplicate delivery and stalled-job recovery.
ALTER TABLE url_checks
  ADD COLUMN processing_claim_token UUID,
  ADD COLUMN processing_lease_until TIMESTAMPTZ;

CREATE INDEX idx_url_checks_processing_lease
  ON url_checks(processing_lease_until)
  WHERE status = 'PROCESSING';

-- Any PROCESSING rows that predate this migration are eligible for one
-- immediate recovery attempt rather than being stranded with a NULL lease.
UPDATE url_checks
SET processing_lease_until = now() - interval '1 second'
WHERE status = 'PROCESSING';

ALTER TABLE insertion_log ADD COLUMN IF NOT EXISTS batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_insertion_log_batch_id ON insertion_log(batch_id) WHERE batch_id IS NOT NULL;

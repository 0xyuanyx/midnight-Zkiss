ALTER TABLE participants ADD COLUMN admission_nullifier text CHECK (admission_nullifier IS NULL OR admission_nullifier ~ '^[0-9a-f]{64}$');

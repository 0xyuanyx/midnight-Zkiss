ALTER TABLE chain_jobs DROP CONSTRAINT chain_jobs_kind_check;
ALTER TABLE chain_jobs ADD CONSTRAINT chain_jobs_kind_check CHECK(kind IN ('ticket','terms','close','open'));
ALTER TABLE conversations ADD COLUMN chain_preparation_status text NOT NULL DEFAULT 'waiting'
 CHECK(chain_preparation_status IN ('waiting','preparing','open','closed'));

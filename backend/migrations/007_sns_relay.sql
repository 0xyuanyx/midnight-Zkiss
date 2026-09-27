CREATE TABLE sns_relay_jobs (
  intent_id text PRIMARY KEY REFERENCES chain_intents(id) ON DELETE CASCADE,
  transaction_hash text NOT NULL,
  proven_transaction text NOT NULL,
  balanced_transaction text,
  transaction_id text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','prepared','submitted','failed')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

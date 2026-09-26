CREATE TABLE browser_relay_transactions (
  intent_id text PRIMARY KEY REFERENCES chain_intents(id) ON DELETE CASCADE,
  input_hash text NOT NULL,
  finalized_transaction text,
  transaction_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE events ADD COLUMN midnight_network text, ADD COLUMN midnight_contract_address text, ADD COLUMN midnight_event_scope text;
ALTER TABLE participants ADD COLUMN ticket_event jsonb, ADD COLUMN ticket_leaf text, ADD COLUMN ticket_status text CHECK(ticket_status IN ('issuing','issued','failed'));
CREATE UNIQUE INDEX event_ticket_leaf ON participants(event_id,ticket_leaf) WHERE ticket_leaf IS NOT NULL;
ALTER TABLE conversations ADD COLUMN chain_room_id text UNIQUE, ADD COLUMN chain_event jsonb, ADD COLUMN chain_slots jsonb NOT NULL DEFAULT '{}';
ALTER TABLE reveal_requests ALTER COLUMN transcript_hash DROP NOT NULL, ALTER COLUMN transcript_payload DROP NOT NULL;
ALTER TABLE reveal_requests ADD COLUMN mode text, ADD COLUMN room_material jsonb NOT NULL DEFAULT '{}', ADD COLUMN chain_event jsonb, ADD COLUMN chain_room_id text, ADD COLUMN policy_version integer;
-- v1 pending approvals cannot be combined with v2 material/terms. No ciphertext is released by migration.
UPDATE reveal_requests SET status='cancelled',version=version+1 WHERE status IN ('requested','awaiting_chain','authorized','ready');
DROP INDEX one_active_reveal;
CREATE UNIQUE INDEX one_active_reveal ON reveal_requests(conversation_id) WHERE status IN ('collecting','requested','awaiting_chain','authorized','ready');
CREATE TABLE chain_jobs (
 id bigserial PRIMARY KEY, event_id text NOT NULL REFERENCES events(id),
 kind text NOT NULL CHECK(kind IN ('ticket','terms','close')), resource_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('real','demo')), chain_event jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 failure_code text, transaction_id text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(kind,resource_id)
);
CREATE INDEX chain_jobs_pending ON chain_jobs(next_attempt_at,id) WHERE status='pending';

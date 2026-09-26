ALTER TABLE participants ADD COLUMN published_profile jsonb;
ALTER TABLE participants ADD COLUMN published_version integer NOT NULL DEFAULT 0;
UPDATE participants SET published_profile=profile,published_version=profile_version WHERE profile_status='published';
CREATE INDEX operations_pending ON operations(updated_at) WHERE status IN ('awaiting_submission','submitted','confirming','reconciling');
CREATE INDEX answers_inbox ON answers(event_id,owner_id,id);
CREATE INDEX answers_sent ON answers(event_id,sender_id,id);
CREATE INDEX conversations_a ON conversations(event_id,a,id);
CREATE INDEX conversations_b ON conversations(event_id,b,id);

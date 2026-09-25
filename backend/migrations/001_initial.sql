CREATE TABLE events (
 id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'open',
 join_until timestamptz NOT NULL, discover_until timestamptz NOT NULL, chat_until timestamptz NOT NULL,
 modes jsonb NOT NULL DEFAULT '[]', sns_reveal boolean NOT NULL DEFAULT false,
 policy_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE participants (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id),
 admission_status text NOT NULL DEFAULT 'onboarding',
 device_public_key text, device_key_version integer NOT NULL DEFAULT 0,
 profile jsonb, profile_version integer NOT NULL DEFAULT 0, profile_status text NOT NULL DEFAULT 'draft',
 contact jsonb, contact_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX participants_event ON participants(event_id);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, participant_id text NOT NULL REFERENCES participants(id),
 csrf_token text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE ai_jobs (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES participants(id),
 status text NOT NULL DEFAULT 'processing', profile_version integer NOT NULL,
 result text, cleanup_status text NOT NULL DEFAULT 'pending',
 mode text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), failure_code text
);
CREATE TABLE questions (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), owner_id text NOT NULL UNIQUE REFERENCES participants(id),
 text text NOT NULL, version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'published', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversations (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), a text NOT NULL REFERENCES participants(id), b text NOT NULL REFERENCES participants(id),
 origin text NOT NULL, origin_key text NOT NULL, alias text NOT NULL,
 status text NOT NULL DEFAULT 'active', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(a <> b), UNIQUE(event_id,origin,origin_key)
);
CREATE TABLE answers (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), question_id text NOT NULL REFERENCES questions(id),
 owner_id text NOT NULL REFERENCES participants(id), sender_id text NOT NULL REFERENCES participants(id),
 question_version integer NOT NULL, question_text text NOT NULL, text text NOT NULL, alias text NOT NULL,
 status text NOT NULL DEFAULT 'pending', version integer NOT NULL DEFAULT 1,
 conversation_id text REFERENCES conversations(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(owner_id <> sender_id), UNIQUE(question_id,sender_id)
);
CREATE TABLE likes (
 event_id text NOT NULL REFERENCES events(id), sender_id text NOT NULL REFERENCES participants(id), recipient_id text NOT NULL REFERENCES participants(id),
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(sender_id <> recipient_id), PRIMARY KEY(event_id,sender_id,recipient_id)
);
CREATE TABLE messages (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), sender_id text NOT NULL REFERENCES participants(id),
 client_message_id text NOT NULL, sequence integer NOT NULL, text text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,sender_id,client_message_id), UNIQUE(conversation_id,sequence)
);
CREATE TABLE read_states (
 conversation_id text NOT NULL REFERENCES conversations(id), participant_id text NOT NULL REFERENCES participants(id),
 sequence integer NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,participant_id)
);
CREATE TABLE blocks (
 event_id text NOT NULL REFERENCES events(id), owner_id text NOT NULL REFERENCES participants(id), target_id text NOT NULL REFERENCES participants(id),
 CHECK(owner_id <> target_id), PRIMARY KEY(event_id,owner_id,target_id)
);
CREATE TABLE reports (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), reporter_id text NOT NULL REFERENCES participants(id),
 context_type text NOT NULL, context_id text NOT NULL, reason text NOT NULL, detail text,
 evidence_ids jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reveal_requests (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), conversation_id text NOT NULL REFERENCES conversations(id),
 a text NOT NULL REFERENCES participants(id), b text NOT NULL REFERENCES participants(id),
 a_contact integer NOT NULL, b_contact integer NOT NULL, a_key integer NOT NULL, b_key integer NOT NULL,
 transcript_hash text NOT NULL, transcript_payload text NOT NULL, key_material jsonb NOT NULL,
 decisions jsonb NOT NULL, verified jsonb NOT NULL DEFAULT '{}', envelopes jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'requested', version integer NOT NULL DEFAULT 1,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_reveal ON reveal_requests(conversation_id)
 WHERE status IN ('requested','awaiting_chain','authorized','ready');
CREATE TABLE chain_intents (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), owner_id text NOT NULL REFERENCES participants(id),
 purpose text NOT NULL, reveal_request_id text REFERENCES reveal_requests(id), binding jsonb NOT NULL,
 binding_hash text NOT NULL UNIQUE, prepared jsonb NOT NULL, mode text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operations (
 id text PRIMARY KEY, intent_id text NOT NULL UNIQUE REFERENCES chain_intents(id), owner_id text NOT NULL REFERENCES participants(id),
 status text NOT NULL DEFAULT 'awaiting_submission', transaction_id text,
 effect_applied boolean NOT NULL DEFAULT false, failure_code text, evidence_ref text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE processed_effects (
 binding_hash text PRIMARY KEY, operation_id text NOT NULL UNIQUE REFERENCES operations(id), evidence_ref text NOT NULL
);
CREATE TABLE idempotency (
 owner_id text NOT NULL REFERENCES participants(id), scope text NOT NULL, key text NOT NULL, payload_hash text NOT NULL,
 status_code integer NOT NULL, body jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,scope,key)
);
CREATE TABLE outbox (
 sequence bigserial PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), audience text NOT NULL REFERENCES participants(id),
 kind text NOT NULL, resource_id text NOT NULL, conversation_id text REFERENCES conversations(id), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_audience_sequence ON outbox(audience,sequence);
CREATE TABLE rate_buckets (
 key text PRIMARY KEY, window_start timestamptz NOT NULL DEFAULT now(), hits integer NOT NULL DEFAULT 1
);

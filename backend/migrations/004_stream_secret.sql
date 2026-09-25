ALTER TABLE sessions ADD COLUMN cursor_secret text NOT NULL DEFAULT replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
ALTER TABLE reveal_requests ADD COLUMN approval_scope jsonb;

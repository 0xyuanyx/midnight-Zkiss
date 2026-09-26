-- Apply as the migration owner after migrations 001–005.
-- zkiss_backend must already exist as a dedicated LOGIN role with no elevated privileges.
-- This deployment uses the existing backend API; browsers must not access these tables directly.
GRANT USAGE ON SCHEMA public TO zkiss_backend;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated, zkiss_backend;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'events','participants','sessions','ai_jobs','questions','conversations',
    'answers','likes','messages','read_states','blocks','reports','reveal_requests',
    'chain_intents','operations','processed_effects','idempotency','outbox',
    'rate_buckets','chain_jobs','migrations'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS zkiss_backend_access ON public.%I', t);
    IF t = 'migrations' THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO zkiss_backend', t);
      EXECUTE format('CREATE POLICY zkiss_backend_access ON public.%I FOR SELECT TO zkiss_backend USING (true)', t);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO zkiss_backend', t);
      EXECUTE format('CREATE POLICY zkiss_backend_access ON public.%I FOR ALL TO zkiss_backend USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.outbox_sequence_seq, public.chain_jobs_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.outbox_sequence_seq, public.chain_jobs_id_seq TO zkiss_backend;
-- Future tables remain inaccessible until this access script is updated and reapplied.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

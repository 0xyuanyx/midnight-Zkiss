-- Supabase enables RLS on new public tables. The app role owns each relay
-- staging operation, so its table grants also need an explicit RLS policy.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zkiss_backend') THEN
    CREATE POLICY zkiss_backend_access ON browser_relay_transactions
      FOR ALL TO zkiss_backend USING (true) WITH CHECK (true);
  END IF;
END $$;

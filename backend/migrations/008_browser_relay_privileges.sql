-- Supabase's app role differs from the migration owner. The relay stages,
-- updates and reads transactions; safe validation failure clears a marker.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zkiss_backend') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON browser_relay_transactions TO zkiss_backend;
  END IF;
END $$;

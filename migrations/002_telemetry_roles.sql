-- Group roles only. Attach dedicated provider login roles separately; no passwords in SQL.
DO $$ BEGIN CREATE ROLE merchantpro_telemetry_writer NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE merchantpro_telemetry_reader NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE merchantpro_telemetry_maintenance NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO merchantpro_telemetry_writer, merchantpro_telemetry_reader, merchantpro_telemetry_maintenance;
GRANT INSERT, SELECT ON telemetry_events TO merchantpro_telemetry_writer;
GRANT INSERT, SELECT, UPDATE ON telemetry_collections TO merchantpro_telemetry_writer;
GRANT SELECT ON telemetry_events, telemetry_collections TO merchantpro_telemetry_reader;
GRANT SELECT, DELETE ON telemetry_events TO merchantpro_telemetry_maintenance;
-- SELECT ... FOR UPDATE in retention requires UPDATE permission, without application use of UPDATE.
GRANT UPDATE ON telemetry_events TO merchantpro_telemetry_maintenance;

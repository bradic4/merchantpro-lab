-- Additive Phase 1. No store configuration/authentication/runtime migrations.
CREATE TABLE IF NOT EXISTS telemetry_events (
  receipt_id uuid PRIMARY KEY,
  received_at timestamptz NOT NULL,
  store_id text,
  attribution text NOT NULL CHECK (attribution IN ('host', 'store_and_host', 'unknown_host', 'conflict', 'invalid_payload')),
  event_type text NOT NULL CHECK (event_type IN ('session_summary', 'error', 'unknown')),
  client_timestamp_ms double precision CHECK (client_timestamp_ms >= 0 AND client_timestamp_ms <= 8640000000000000),
  edge_country text,
  reported_country text,
  cohort text,
  page_host text,
  page_path text,
  meta text CHECK (meta IN ('idle', 'deferred', 'loading', 'loaded', 'failed')),
  gtm text CHECK (gtm IN ('idle', 'deferred', 'loading', 'loaded', 'failed')),
  tiktok text CHECK (tiktok IN ('idle', 'deferred', 'loading', 'loaded', 'failed')),
  errors_count bigint CHECK (errors_count >= 0 AND errors_count <= 9007199254740991),
  events_buffered bigint CHECK (events_buffered >= 0 AND events_buffered <= 9007199254740991),
  long_task_blocking_ms double precision CHECK (long_task_blocking_ms >= 0 AND long_task_blocking_ms < 'Infinity'::double precision),
  error_vendor text CHECK (error_vendor IN ('meta', 'gtm', 'tiktok')),
  has_error_message boolean NOT NULL DEFAULT false,
  validation_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CHECK ((store_id IS NOT NULL) = (attribution IN ('host', 'store_and_host')))
);

-- First successfully stored receipt, not a claim of uninterrupted collection.
CREATE TABLE IF NOT EXISTS telemetry_collections (
  store_id text PRIMARY KEY,
  first_received_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS telemetry_events_store_time_idx ON telemetry_events (store_id, received_at DESC, receipt_id DESC);
CREATE INDEX IF NOT EXISTS telemetry_events_summary_idx ON telemetry_events (store_id, received_at) WHERE event_type = 'session_summary';
CREATE INDEX IF NOT EXISTS telemetry_events_error_idx ON telemetry_events (store_id, received_at, error_vendor) WHERE event_type = 'error';
CREATE INDEX IF NOT EXISTS telemetry_events_retention_idx ON telemetry_events (received_at);

export const RETENTION_DAYS = 35;

export function unavailableMetrics(storeId, hours = 24, reason = 'reads_not_enabled') {
  return { storeId, periodHours: hours, source: { kind: 'postgres', available: false, reason },
    totalSessions: null, totalErrors: null, summaryReports: null, errorReports: null, summaryReportedErrors: null,
    lastTelemetryAt: null, storeStatus: null, runtimeVersion: null, countryBreakdown: null,
    classificationBreakdown: null, trackingErrors: null, vendors: null,
    baselineBlockingMs: null, optimizedBlockingMs: null, reductionPercent: null,
    recentSessions: [], performanceHistory: [], performanceSampleCount: null, periodComplete: false,
    missing: ['sessionId', 'runtimeVersion', 'mode', 'classification', 'runtimeStatus', 'measurement validity/support/duration'],
  };
}

// One statement = one consistent DB snapshot. Aggregations precede recent-row LIMIT.
export const METRICS_SQL = `
WITH windowed AS (
  SELECT * FROM telemetry_events WHERE store_id = $1
  AND received_at >= $2::timestamptz - ($3::int * interval '1 hour') AND received_at < $2::timestamptz
), summaries AS (SELECT * FROM windowed WHERE event_type = 'session_summary'),
countries AS (SELECT coalesce(edge_country, 'unknown') AS country, count(*) AS n FROM summaries GROUP BY 1),
history AS (
  SELECT date_trunc(CASE WHEN $3::int <= 24 THEN 'hour' ELSE 'day' END, received_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
  count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY long_task_blocking_ms) AS median,
  CASE WHEN count(*) >= 20 THEN percentile_cont(0.75) WITHIN GROUP (ORDER BY long_task_blocking_ms) END AS p75
  FROM summaries WHERE long_task_blocking_ms IS NOT NULL GROUP BY 1
), observations AS (
  SELECT e.received_at, e.receipt_id, v.vendor, v.state FROM telemetry_events e
  CROSS JOIN LATERAL (VALUES ('meta', e.meta), ('gtm', e.gtm), ('tiktok', e.tiktok)) AS v(vendor, state)
  WHERE e.store_id = $1 AND e.event_type = 'session_summary' AND e.received_at < $2::timestamptz
  AND e.received_at >= $2::timestamptz - interval '35 days'
), latest_vendor AS (
  SELECT DISTINCT ON (vendor) vendor, state, received_at FROM observations
  WHERE state IS NOT NULL ORDER BY vendor, received_at DESC, receipt_id DESC
), vendor_counts AS (
  SELECT vendor, coalesce(state, 'unknown') AS state, count(*) AS n FROM observations
  WHERE received_at >= $2::timestamptz - ($3::int * interval '1 hour') GROUP BY 1, 2
), recent AS (
  SELECT * FROM windowed ORDER BY received_at DESC, receipt_id DESC LIMIT 50
)
SELECT jsonb_build_object(
 'asOf', $2::timestamptz,
 'periodStart', $2::timestamptz - ($3::int * interval '1 hour'),
 'firstPersistedAt', (SELECT first_received_at FROM telemetry_collections WHERE store_id = $1),
 'lastTelemetryAt', (SELECT max(received_at) FROM telemetry_events WHERE store_id = $1 AND received_at < $2::timestamptz AND received_at >= $2::timestamptz - interval '35 days'),
 'recordCount', (SELECT count(*) FROM windowed),
 'summaryReports', (SELECT count(*) FROM summaries),
 'errorReports', (SELECT count(*) FROM windowed WHERE event_type = 'error'),
 'summaryReportedErrors', (SELECT CASE WHEN count(*) > 0 AND count(errors_count) = count(*) THEN sum(errors_count) END FROM summaries),
 'summariesWithErrorCount', (SELECT count(errors_count) FROM summaries),
 'countryBreakdown', (SELECT jsonb_object_agg(country, n) FROM countries),
 'vendors', (SELECT jsonb_object_agg(v.vendor, jsonb_build_object(
     'latestState', l.state, 'lastObservedAt', l.received_at,
     'fresh', coalesce(l.received_at >= $2::timestamptz - interval '24 hours', false),
     'states', (SELECT jsonb_object_agg(c.state, c.n) FROM vendor_counts c WHERE c.vendor = v.vendor)))
   FROM (VALUES ('meta'), ('gtm'), ('tiktok')) AS v(vendor) LEFT JOIN latest_vendor l ON l.vendor = v.vendor),
 'recentSessions', coalesce((SELECT jsonb_agg(jsonb_build_object(
   'id', receipt_id, 'timestamp', extract(epoch FROM received_at) * 1000,
   'clientTimestamp', client_timestamp_ms, 'type', event_type, 'country', edge_country,
   'reportedCountry', reported_country, 'cohort', cohort,
   'pageHost', page_host, 'pagePath', page_path,
   'longTaskBlockingMs', long_task_blocking_ms, 'errorsCount', errors_count, 'eventsBuffered', events_buffered,
   'meta', meta, 'gtm', gtm, 'tiktok', tiktok, 'errorVendor', error_vendor,
   'validationFlags', validation_flags) ORDER BY received_at DESC, receipt_id DESC) FROM recent), '[]'::jsonb),
 'performanceHistory', coalesce((SELECT jsonb_agg(jsonb_build_object(
   'timestamp', extract(epoch FROM bucket) * 1000, 'sampleSize', n, 'median', median, 'p75', p75) ORDER BY bucket) FROM history), '[]'::jsonb),
 'performanceSampleCount', (SELECT count(long_task_blocking_ms) FROM summaries),
 'performanceMedian', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY long_task_blocking_ms) FROM summaries),
 'performanceP75', (SELECT CASE WHEN count(long_task_blocking_ms) >= 20 THEN percentile_cont(0.75) WITHIN GROUP (ORDER BY long_task_blocking_ms) END FROM summaries)
) AS metrics`;

export function createTelemetryRepository(query) {
  return {
    async insert(record) {
      // Static column list; payload keys never become SQL identifiers. The same receipt
      // ID may be retried safely, but independent browser beacons are never deduplicated.
      const columns = ['receipt_id', 'received_at', 'store_id', 'attribution', 'event_type', 'client_timestamp_ms',
        'edge_country', 'reported_country', 'cohort', 'page_host', 'page_path', 'meta', 'gtm', 'tiktok',
        'errors_count', 'events_buffered', 'long_task_blocking_ms', 'error_vendor', 'has_error_message', 'validation_flags', 'fingerprint'];
      const values = columns.map(k => k === 'validation_flags' ? JSON.stringify(record[k]) : record[k]);
      await query(`WITH inserted AS (
        INSERT INTO telemetry_events (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})
        ON CONFLICT (receipt_id) DO NOTHING RETURNING store_id, received_at
      ) INSERT INTO telemetry_collections (store_id, first_received_at)
        SELECT store_id, received_at FROM inserted WHERE store_id IS NOT NULL
        ON CONFLICT (store_id) DO UPDATE SET first_received_at = LEAST(telemetry_collections.first_received_at, EXCLUDED.first_received_at)`, values);
    },
    async metrics(storeId, hours = 24, asOf = new Date()) {
      if (![24, 168, 720].includes(hours)) throw new Error('invalid_period');
      const result = await query(METRICS_SQL, [storeId, asOf.toISOString(), hours]);
      return { ...unavailableMetrics(storeId, hours), ...result[0].metrics,
        source: { kind: 'postgres', available: true, units: 'received_reports' },
        // A collection start and available rows do not prove uninterrupted delivery.
        periodComplete: false,
      };
    },
    async retain(now = new Date(), batchSize = 5000) {
      const rows = await query(`WITH expired AS (
        SELECT receipt_id FROM telemetry_events WHERE received_at < $1::timestamptz - interval '35 days'
        ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED
      ), deleted AS (DELETE FROM telemetry_events e USING expired x WHERE e.receipt_id = x.receipt_id RETURNING e.receipt_id)
      SELECT count(*)::int AS deleted FROM deleted`, [now.toISOString(), batchSize]);
      return rows[0].deleted;
    },
  };
}

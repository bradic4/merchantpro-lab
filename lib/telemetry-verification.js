import { normalizeTelemetry } from './telemetry-normalize.js';

// Compare the normalized beacon fields independently of the persistence marker.
// The original logger flattens header and payload country, so it cannot prove
// edge-country provenance. Receipt identity and receive time are server-only.
export function payloadProjection(record) {
  const fields = ['store_id', 'attribution', 'event_type', 'client_timestamp_ms',
    'cohort', 'page_host', 'page_path', 'meta', 'gtm', 'tiktok', 'errors_count',
    'events_buffered', 'long_task_blocking_ms', 'error_vendor', 'has_error_message'];
  return JSON.stringify(fields.map(key => record[key]));
}

export async function compareOriginalPayloads(originalLogs, records) {
  const counts = new Map();
  for (const payload of originalLogs) {
    const record = await normalizeTelemetry(payload, { receivedAt: 0 });
    const key = payloadProjection(record);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let unexpectedRecords = 0;
  for (const record of records) {
    const key = payloadProjection(record), count = counts.get(key) || 0;
    if (!count) unexpectedRecords++;
    else counts.set(key, count - 1);
  }
  return { unmatchedOriginals: [...counts.values()].reduce((a, b) => a + b, 0), unexpectedRecords };
}

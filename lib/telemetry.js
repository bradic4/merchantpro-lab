import { neon } from '@neondatabase/serverless';
import { normalizeTelemetry } from './telemetry-normalize.js';
import { createTelemetryRepository, unavailableMetrics } from './telemetry-repository.js';

export function neonQuery(url, timeoutMs = 5000) {
  if (!url) throw new Error('database_not_configured');
  const sql = neon(url);
  return (statement, params = []) => sql.query(statement, params, {
    fetchOptions: { signal: AbortSignal.timeout(timeoutMs) },
  });
}

/** Fail-open shadow persistence; the caller's existing response must not change. */
export async function shadowWrite(payload, context, options = {}) {
  const env = options.env || process.env;
  if (env.TELEMETRY_PERSIST_ENABLED !== 'true') return { outcome: 'disabled' };
  const log = options.log || ((entry) => console.log('[SD_TELEMETRY_PERSISTENCE]', JSON.stringify(entry)));
  let record;
  try {
    record = await normalizeTelemetry(payload, context);
    const query = options.query || neonQuery(env.TELEMETRY_DATABASE_URL, 2000);
    await createTelemetryRepository(query).insert(record);
    const result = { outcome: 'stored', receiptId: record.receipt_id, receivedAt: record.received_at,
      storeId: record.store_id, eventType: record.event_type, fingerprint: record.fingerprint };
    log(result);
    return result;
  } catch {
    // Never print connection strings, payloads, or driver errors (which can include SQL parameters).
    const result = { outcome: 'failed', receiptId: record?.receipt_id ?? null,
      receivedAt: record?.received_at ?? null, reason: 'persistence_failed' };
    try { log(result); } catch { /* Logging failure cannot alter the production contract. */ }
    return result;
  }
}

export async function readTelemetryMetrics(storeId, hours = 24, options = {}) {
  const env = options.env || process.env;
  if (env.TELEMETRY_READ_ENABLED !== 'true') return unavailableMetrics(storeId, hours);
  try {
    const query = options.query || neonQuery(env.TELEMETRY_READ_DATABASE_URL);
    return await createTelemetryRepository(query).metrics(storeId, hours, options.asOf || new Date());
  } catch {
    console.warn('[SD_TELEMETRY_READ]', JSON.stringify({ outcome: 'failed', storeId }));
    return unavailableMetrics(storeId, hours, 'database_unavailable');
  }
}

export async function retainTelemetry(options = {}) {
  const env = options.env || process.env;
  const query = options.query || neonQuery(env.TELEMETRY_MAINTENANCE_DATABASE_URL);
  const repo = createTelemetryRepository(query);
  const now = options.now || new Date();
  let deleted = 0;
  for (let batch = 0; batch < 5; batch++) {
    const n = await repo.retain(now, 5000); deleted += n;
    if (n < 5000) return { deleted, moreMayRemain: false };
  }
  return { deleted, moreMayRemain: true };
}

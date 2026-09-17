/** v1 receipts only. No synthesized visitor/session identity or runtime fields. */
export const STORE_HOSTS = Object.freeze({
  'volimsvojdom.rs': 'volimsvojdom', 'www.volimsvojdom.rs': 'volimsvojdom',
  'baldino.rs': 'baldino', 'www.baldino.rs': 'baldino',
});
const states = ['idle', 'deferred', 'loading', 'loaded', 'failed'];
const country = value => typeof value === 'string' && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
const shortText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null;

export async function fingerprintRecord(record) {
  const { fingerprint, ...fields } = record;
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(fields).sort().map(k => [k, fields[k]])));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}

export async function normalizeTelemetry(payload, context = {}) {
  const valid = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
  const input = valid ? payload : {};
  const flags = valid ? [] : ['invalid_payload'];
  const number = (key, integer = false) => {
    const n = input[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && (!integer || Number.isSafeInteger(n))) return n;
    if (n !== undefined) flags.push(`invalid_${key}`);
    return null;
  };
  let host = null, path = null;
  try {
    const url = new URL(input.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('invalid_url');
    host = url.hostname.toLowerCase();
    path = url.pathname.length <= 2048 ? url.pathname : null;
    if (path === null) flags.push('oversize_path');
  } catch { flags.push('invalid_url'); }
  // Request Host is the collector's host, NOT the merchant's host. Referer/country/IP
  // must never supply a default tenant. Public payload attribution is not authentication.
  const resolved = Object.hasOwn(STORE_HOSTS, host) ? STORE_HOSTS[host] : null;
  const claimed = input.storeId;
  const conflict = claimed !== undefined && claimed !== resolved;
  const store = resolved && !conflict ? resolved : null;
  const timestamp = number('timestamp');
  if (timestamp !== null && timestamp > 8640000000000000) flags.push('invalid_timestamp_range');
  const record = {
    receipt_id: context.receiptId || crypto.randomUUID(),
    received_at: new Date(context.receivedAt ?? Date.now()).toISOString(),
    store_id: store,
    attribution: !valid ? 'invalid_payload' : !resolved ? 'unknown_host' : conflict ? 'conflict' : claimed === undefined ? 'host' : 'store_and_host',
    event_type: ['session_summary', 'error'].includes(input.type) ? input.type : 'unknown',
    client_timestamp_ms: timestamp !== null && timestamp <= 8640000000000000 ? timestamp : null,
    edge_country: country(context.edgeCountry),
    reported_country: country(input.country),
    cohort: shortText(input.cohort, 100),
    page_host: host,
    page_path: path,
    meta: states.includes(input.meta) ? input.meta : null,
    gtm: states.includes(input.gtm) ? input.gtm : null,
    tiktok: states.includes(input.tiktok) ? input.tiktok : null,
    errors_count: number('errorsCount', true),
    events_buffered: number('eventsBuffered', true),
    long_task_blocking_ms: number('longTaskBlockingMs'),
    error_vendor: ['meta', 'gtm', 'tiktok'].includes(input.vendor) ? input.vendor : null,
    // Free-form vendor messages and URL query strings can carry customer identifiers.
    // Phase 1 stores vendor/count presence; original diagnostic text stays in existing logs.
    has_error_message: typeof input.error === 'string' && input.error.length > 0,
    validation_flags: flags,
  };
  record.fingerprint = await fingerprintRecord(record);
  return record;
}

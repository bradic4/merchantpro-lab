import { readFile, writeFile } from 'node:fs/promises';
import { neonQuery } from '../lib/telemetry.js';
import { fingerprintRecord } from '../lib/telemetry-normalize.js';
import { compareOriginalPayloads } from '../lib/telemetry-verification.js';

// Read-only production comparison. Accept actual exported Vercel JSON/NDJSON logs.
// A pass never changes the read flag; enabling reads is a separate deployment step.
const [logFile, outputFile] = process.argv.slice(2);
if (!logFile || !outputFile || !process.env.TELEMETRY_READ_DATABASE_URL) {
  console.error('Usage: node scripts/verify-telemetry.mjs <production-log-export.json|jsonl> <report.json>; set TELEMETRY_READ_DATABASE_URL.');
  process.exitCode = 1;
} else {
  try {
    const text = await readFile(logFile, 'utf8');
    let documents;
    try { documents = JSON.parse(text); } catch { documents = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
    const strings = [];
    const walk = value => {
      if (typeof value === 'string') { if (value.includes('[SD_TELEMETRY')) strings.push(value); }
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(documents);
    const markers = [], original = [];
    for (const entry of strings) for (const line of entry.split(/\r?\n/)) {
      const match = line.match(/\[(SD_TELEMETRY_PERSISTENCE|SD_TELEMETRY)\]\s*(\{.*\})\s*$/);
      if (match) (match[1] === 'SD_TELEMETRY' ? original : markers).push(JSON.parse(match[2]));
    }
    const failures = markers.filter(m => m.outcome !== 'stored');
    const stored = markers.filter(m => m.outcome === 'stored');
    const unique = new Map(stored.map(m => [m.receiptId, m]));
    const query = neonQuery(process.env.TELEMETRY_READ_DATABASE_URL, 10000);
    const missing = [], mismatched = [], records = [];
    let matched = 0, attributed = 0;
    const ids = [...unique.keys()];
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await query('SELECT * FROM telemetry_events WHERE receipt_id = ANY($1::uuid[])', [ids.slice(i, i + 200)]);
      const returned = new Map(rows.map(row => [row.receipt_id, row]));
      for (const id of ids.slice(i, i + 200)) {
        const row = returned.get(id), marker = unique.get(id);
        if (!row) { missing.push(id); continue; }
        const normalized = { ...row, received_at: new Date(row.received_at).toISOString(),
          errors_count: row.errors_count === null ? null : Number(row.errors_count),
          events_buffered: row.events_buffered === null ? null : Number(row.events_buffered) };
        const hash = await fingerprintRecord(normalized);
        records.push(normalized);
        if (hash !== row.fingerprint || hash !== marker.fingerprint || row.store_id !== marker.storeId || row.event_type !== marker.eventType || normalized.received_at !== marker.receivedAt) mismatched.push(id);
        else { matched++; if (row.store_id) attributed++; }
      }
    }
    const uniqueOriginalCount = original.length;
    const payloadComparison = await compareOriginalPayloads(original, records);
    const passed = ids.length > 0 && attributed > 0 && original.length === markers.length && stored.length === unique.size && failures.length === 0 && missing.length === 0 && mismatched.length === 0 && payloadComparison.unmatchedOriginals === 0 && payloadComparison.unexpectedRecords === 0;
    const report = { verifiedAt: new Date().toISOString(), passed, originalLogCount: uniqueOriginalCount,
      persistenceMarkerCount: markers.length, matched, attributed, failures: failures.length, missing, mismatched, payloadComparison,
      note: 'Comparison covers only the supplied export. Confirm production project/environment and complete export boundaries separately. No client-session uniqueness or lossless delivery is asserted.' };
    await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    if (!passed) process.exitCode = 1;
  } catch {
    console.error('Verification failed. Check export format and read-only database access. No credentials or raw telemetry were printed.');
    process.exitCode = 1;
  }
}
